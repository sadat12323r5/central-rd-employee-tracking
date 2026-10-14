import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createDepartmentsStore, DepartmentCycleError, DepartmentNameInvalidError, DepartmentNameTakenError, DepartmentNotFoundError,
  DepartmentsForbiddenError, DepartmentsUnavailableError, toDepartment, type DepartmentRow, type DepartmentsStore,
} from "@/server/departments-store";

type DbError = { code: string; message: string };
type Call = { table: string; method: string; args: unknown[] };
type Options = { throws?: boolean; readError?: DbError; writeError?: DbError; writeNone?: boolean };

const LND = "de9a0000-0000-4000-8000-000000000001";
const CRD = "de9a0000-0000-4000-8000-000000000002";
const QA = "de9a0000-0000-4000-8000-000000000003";
const UNKNOWN = "de9a0000-0000-4000-8000-0000000000ff";

/**
 * Minimal stand-in for the supabase-js query builder: records every call, keeps rows in memory, and
 * applies inserts and updates (so a later list sees them).
 */
function fakeClient(rows: DepartmentRow[], options: Options = {}) {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (options.throws) throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        const inserted = query.find(c => c.method === "insert");
        const updated = query.find(c => c.method === "update");
        if ((inserted || updated) && options.writeError) return { data: null, error: options.writeError };
        if (!inserted && !updated && options.readError) return { data: null, error: options.readError };
        if (inserted) {
          const row = { id: "new-id", ...(inserted.args[0] as object) } as DepartmentRow;
          rows.push(row);
          return { data: row, error: null };
        }
        const filters = query.filter(c => c.method === "eq").map(c => c.args as [string, unknown]);
        const matching = rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val));
        if (updated) {
          if (options.writeNone) return { data: null, error: null };
          for (const r of matching) Object.assign(r, updated.args[0]);
        }
        const one = query.some(c => c.method === "maybeSingle" || c.method === "single");
        return { data: one ? (matching[0] ?? null) : [...matching].sort((a, b) => a.name.localeCompare(b.name)), error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        insert: (...args: unknown[]) => { record("insert", args); return builder; },
        update: (...args: unknown[]) => { record("update", args); return builder; },
        delete: (...args: unknown[]) => { record("delete", args); return builder; },
        maybeSingle: () => { record("maybeSingle", []); return builder; },
        single: () => { record("single", []); return builder; },
        returns: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const seeded = (): DepartmentRow[] => [
  { id: LND, name: "L&D", parent_department_id: null },
  { id: CRD, name: "Central R&D", parent_department_id: LND },
  { id: QA, name: "QA Lab", parent_department_id: CRD },
];
const storeFor = (client: SupabaseClient) => createDepartmentsStore({ userClient: async () => client });
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const writes = (calls: Call[][]) => calls.flat().filter(c => c.method === "insert" || c.method === "update" || c.method === "delete");

describe("departments-store shape", () => {
  it("has no delete method", () => {
    const store = storeFor(fakeClient([]).client);
    expect(Object.keys(store).sort()).toEqual(["create", "list", "update"]);
    expect((store as DepartmentsStore & { delete?: unknown }).delete).toBeUndefined();
  });

  it("maps a row to a department", () => {
    expect(toDepartment({ id: CRD, name: "Central R&D", parent_department_id: LND })).toEqual({ id: CRD, name: "Central R&D", parentId: LND });
  });
});

describe("departments-store authorization", () => {
  it.each([["a staff session", staff], ["no session", null]])("refuses %s before any query", async (_label, session) => {
    const { client, calls } = fakeClient(seeded());
    const store = storeFor(client);
    const s = session as unknown as typeof admin;
    await expect(store.list(s)).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.create(s, { name: "Quality", parentId: null })).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.update(s, LND, { name: "L&D", parentId: null })).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    expect(calls).toHaveLength(0);
  });
});

describe("departments-store list", () => {
  it("lists every department by name, through the departments table", async () => {
    const { client, calls } = fakeClient(seeded());
    expect(await storeFor(client).list(admin)).toEqual([
      { id: CRD, name: "Central R&D", parentId: LND },
      { id: LND, name: "L&D", parentId: null },
      { id: QA, name: "QA Lab", parentId: CRD },
    ]);
    expect(calls[0].map(c => [c.table, c.method, ...c.args])).toEqual([
      ["departments", "select", "id,name,parent_department_id"],
      ["departments", "order", "name"],
      ["departments", "order", "id"],
    ]);
  });

  it("reports unavailable on a database error or a network failure, never an empty list", async () => {
    await expect(storeFor(fakeClient([], { readError: { code: "PGRST205", message: "missing" } }).client).list(admin))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
    await expect(storeFor(fakeClient([], { throws: true }).client).list(admin)).rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});

describe("departments-store create", () => {
  it("adds a top-level department with a normalised name", async () => {
    const { client, calls } = fakeClient(seeded());
    const saved = await storeFor(client).create(admin, { name: "  Quality   Engineering ", parentId: null });
    expect(saved).toEqual({ id: "new-id", name: "Quality Engineering", parentId: null });
    expect(writes(calls)).toEqual([{ table: "departments", method: "insert", args: [{ name: "Quality Engineering", parent_department_id: null }] }]);
  });

  it("adds a child under an existing department", async () => {
    const { client } = fakeClient(seeded());
    expect(await storeFor(client).create(admin, { name: "QA Lab 2", parentId: LND })).toMatchObject({ parentId: LND });
  });

  it("rejects a duplicate name case-insensitively, without writing", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).create(admin, { name: "central r&d ", parentId: null })).rejects.toBeInstanceOf(DepartmentNameTakenError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects an unknown parent, without writing", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).create(admin, { name: "Quality", parentId: UNKNOWN })).rejects.toBeInstanceOf(DepartmentNotFoundError);
    expect(writes(calls)).toHaveLength(0);
  });

  it.each([["an empty", "   "], ["a too-long", "x".repeat(101)]])("rejects %s name, without writing", async (_label, name) => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).create(admin, { name, parentId: null })).rejects.toBeInstanceOf(DepartmentNameInvalidError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("maps the database's unique violation (a race) to the same name error", async () => {
    const { client } = fakeClient(seeded(), { writeError: { code: "23505", message: "duplicate key value violates unique constraint \"departments_name_lower_key\"" } });
    await expect(storeFor(client).create(admin, { name: "Quality", parentId: null })).rejects.toBeInstanceOf(DepartmentNameTakenError);
  });

  it("maps a parent foreign-key violation to not found, and anything else to unavailable", async () => {
    await expect(storeFor(fakeClient(seeded(), { writeError: { code: "23503", message: "fk" } }).client).create(admin, { name: "Quality", parentId: LND }))
      .rejects.toBeInstanceOf(DepartmentNotFoundError);
    await expect(storeFor(fakeClient(seeded(), { writeError: { code: "42501", message: "rls" } }).client).create(admin, { name: "Quality", parentId: null }))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});

describe("departments-store update", () => {
  it("renames and re-parents a department", async () => {
    const { client, calls } = fakeClient(seeded());
    const saved = await storeFor(client).update(admin, QA, { name: "Quality Lab", parentId: LND });
    expect(saved).toEqual({ id: QA, name: "Quality Lab", parentId: LND });
    expect(writes(calls)).toEqual([{ table: "departments", method: "update", args: [{ name: "Quality Lab", parent_department_id: LND }] }]);
    expect(calls.at(-1)).toContainEqual({ table: "departments", method: "eq", args: ["id", QA] });
  });

  it("allows renaming a department to its own name in a different case", async () => {
    const { client } = fakeClient(seeded());
    expect(await storeFor(client).update(admin, CRD, { name: "CENTRAL R&D", parentId: LND })).toMatchObject({ name: "CENTRAL R&D" });
  });

  it("rejects another department's name", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).update(admin, QA, { name: "l&d", parentId: CRD })).rejects.toBeInstanceOf(DepartmentNameTakenError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects a department as its own parent", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).update(admin, CRD, { name: "Central R&D", parentId: CRD })).rejects.toBeInstanceOf(DepartmentCycleError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects placing a department under one of its descendants", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).update(admin, LND, { name: "L&D", parentId: CRD })).rejects.toBeInstanceOf(DepartmentCycleError);
    await expect(storeFor(client).update(admin, LND, { name: "L&D", parentId: QA })).rejects.toBeInstanceOf(DepartmentCycleError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses (as a cycle) when the stored hierarchy already loops, instead of hanging", async () => {
    const looped: DepartmentRow[] = [
      { id: LND, name: "L&D", parent_department_id: CRD },
      { id: CRD, name: "Central R&D", parent_department_id: LND },
      { id: QA, name: "QA Lab", parent_department_id: null },
    ];
    const { client } = fakeClient(looped);
    await expect(storeFor(client).update(admin, QA, { name: "QA Lab", parentId: CRD })).rejects.toBeInstanceOf(DepartmentCycleError);
  });

  it("maps the database cycle trigger to the same cycle error", async () => {
    const { client } = fakeClient(seeded(), { writeError: { code: "23514", message: "department_cycle" } });
    await expect(storeFor(client).update(admin, QA, { name: "QA Lab", parentId: LND })).rejects.toBeInstanceOf(DepartmentCycleError);
  });

  it("rejects an unknown department or parent", async () => {
    const { client, calls } = fakeClient(seeded());
    await expect(storeFor(client).update(admin, UNKNOWN, { name: "Ghost", parentId: null })).rejects.toBeInstanceOf(DepartmentNotFoundError);
    await expect(storeFor(client).update(admin, QA, { name: "QA Lab", parentId: UNKNOWN })).rejects.toBeInstanceOf(DepartmentNotFoundError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("reports not found when the update matches no row (RLS hid it)", async () => {
    const { client } = fakeClient(seeded(), { writeNone: true });
    await expect(storeFor(client).update(admin, QA, { name: "QA Lab", parentId: LND })).rejects.toBeInstanceOf(DepartmentNotFoundError);
  });

  it("reports unavailable when the database cannot be reached, never saved", async () => {
    await expect(storeFor(fakeClient(seeded(), { throws: true }).client).update(admin, QA, { name: "QA", parentId: null }))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});
