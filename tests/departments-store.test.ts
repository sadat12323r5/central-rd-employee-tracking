import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createDepartmentsStore, DepartmentCycleError, DepartmentNameInvalidError, DepartmentNameTakenError, DepartmentNotFoundError,
  DepartmentsForbiddenError, DepartmentsUnavailableError, ManagerArchivedError, ManagerEmployeeNotFoundError, ManagerHasNoAccountError,
  toDepartment, type DepartmentRow, type DepartmentsStore,
} from "@/server/departments-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";

type DbError = { code: string; message: string };
type Call = { table: string; method: string; args: unknown[] };
type Options = {
  throws?: boolean; readError?: DbError; writeError?: DbError; writeNone?: boolean;
  /** Rows of the employees table (Story 4.2: manager candidates and linked accounts). */
  employees?: EmployeeRow[]; employeesError?: DbError;
};
type EmployeeRow = { employee_id: string; name: string; auth_user_id: string | null; archived_at: string | null };

const LND = "de9a0000-0000-4000-8000-000000000001";
const CRD = "de9a0000-0000-4000-8000-000000000002";
const QA = "de9a0000-0000-4000-8000-000000000003";
const UNKNOWN = "de9a0000-0000-4000-8000-0000000000ff";

/**
 * Minimal stand-in for the supabase-js query builder: records every call, keeps rows in memory, and
 * applies inserts and updates (so a later list sees them).
 */
function fakeClient(departmentRows: DepartmentRow[], options: Options = {}) {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (options.throws) throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        const rows = (table === "employees" ? options.employees ?? [] : departmentRows) as (DepartmentRow & EmployeeRow)[];
        if (table === "employees" && options.employeesError) return { data: null, error: options.employeesError };
        const inserted = query.find(c => c.method === "insert");
        const updated = query.find(c => c.method === "update");
        if ((inserted || updated) && options.writeError) return { data: null, error: options.writeError };
        if (!inserted && !updated && options.readError) return { data: null, error: options.readError };
        if (inserted) {
          const row = { id: "new-id", ...(inserted.args[0] as object) } as DepartmentRow;
          departmentRows.push(row);
          return { data: row, error: null };
        }
        const filters = query.filter(c => c.method === "eq" || c.method === "is").map(c => c.args as [string, unknown]);
        const within = query.filter(c => c.method === "in").map(c => c.args as [string, unknown[]]);
        const matching = rows.filter(r => filters.every(([col, val]) => ((r as Record<string, unknown>)[col] ?? null) === val)
          && within.every(([col, vals]) => vals.includes((r as Record<string, unknown>)[col])));
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
        is: (...args: unknown[]) => { record("is", args); return builder; },
        in: (...args: unknown[]) => { record("in", args); return builder; },
        limit: (...args: unknown[]) => { record("limit", args); return builder; },
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
const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const none = { managerUserId: null, managerEmployeeId: null };
const writes = (calls: Call[][]) => calls.flat().filter(c => c.method === "insert" || c.method === "update" || c.method === "delete");

describe("departments-store shape", () => {
  it("has no delete method", () => {
    const store = storeFor(fakeClient([]).client);
    expect(Object.keys(store).sort()).toEqual(["create", "list", "listFor", "managesAny", "setManager", "update"]);
    expect((store as DepartmentsStore & { delete?: unknown }).delete).toBeUndefined();
  });

  it("maps a row to a department", () => {
    expect(toDepartment({ id: CRD, name: "Central R&D", parent_department_id: LND }))
      .toEqual({ id: CRD, name: "Central R&D", parentId: LND, managerUserId: null, managerEmployeeId: null });
    expect(toDepartment({ id: LND, name: "L&D", parent_department_id: null, manager_user_id: "u-1" }, "BS-1002"))
      .toEqual({ id: LND, name: "L&D", parentId: null, managerUserId: "u-1", managerEmployeeId: "BS-1002" });
    // No manager account means no manager employee, whatever the caller passed.
    expect(toDepartment({ id: LND, name: "L&D", parent_department_id: null, manager_user_id: null }, "BS-1002").managerEmployeeId).toBeNull();
  });
});

describe("departments-store authorization", () => {
  it.each([["a staff session", staff], ["a manager session", manager], ["no session", null]])("refuses %s before any query", async (_label, session) => {
    const { client, calls } = fakeClient(seeded());
    const store = storeFor(client);
    const s = session as unknown as typeof admin;
    await expect(store.list(s)).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.create(s, { name: "Quality", parentId: null })).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.update(s, LND, { name: "L&D", parentId: null })).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.setManager(s, LND, "BS-1002")).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.setManager(s, LND, null)).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    expect(calls).toHaveLength(0);
  });
});

describe("departments-store list", () => {
  it("lists every department by name, through the departments table", async () => {
    const { client, calls } = fakeClient(seeded());
    expect(await storeFor(client).list(admin)).toEqual([
      { id: CRD, name: "Central R&D", parentId: LND, ...none },
      { id: LND, name: "L&D", parentId: null, ...none },
      { id: QA, name: "QA Lab", parentId: CRD, ...none },
    ]);
    // No managers: no employees read.
    expect(calls).toHaveLength(1);
    expect(calls[0].map(c => [c.table, c.method, ...c.args])).toEqual([
      ["departments", "select", "id,name,parent_department_id,manager_user_id"],
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
    expect(saved).toEqual({ id: "new-id", name: "Quality Engineering", parentId: null, ...none });
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
    expect(saved).toEqual({ id: QA, name: "Quality Lab", parentId: LND, ...none });
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

const MANAGER_USER = "aaaa0000-0000-4000-8000-000000000001";
const ADMIN_USER = "aaaa0000-0000-4000-8000-000000000002";
const people = (): EmployeeRow[] => [
  { employee_id: "BS-1002", name: "Rafi Ahmed", auth_user_id: MANAGER_USER, archived_at: null },
  { employee_id: "BS-1003", name: "Meera Das", auth_user_id: null, archived_at: null },
  { employee_id: "BS-1004", name: "Tanvir Hasan", auth_user_id: "aaaa0000-0000-4000-8000-000000000004", archived_at: "2026-10-01T00:00:00Z" },
];

describe("departments-store list with managers (Story 4.2)", () => {
  it("returns each manager's account and linked Employee ID; an account with no employee row has none", async () => {
    const rows = seeded();
    rows[0].manager_user_id = ADMIN_USER; // L&D: the Administrator account (no employee row)
    rows[2].manager_user_id = MANAGER_USER; // QA Lab: Rafi
    const { client, calls } = fakeClient(rows, { employees: people() });
    expect(await storeFor(client).list(admin)).toEqual([
      { id: CRD, name: "Central R&D", parentId: LND, ...none },
      { id: LND, name: "L&D", parentId: null, managerUserId: ADMIN_USER, managerEmployeeId: null },
      { id: QA, name: "QA Lab", parentId: CRD, managerUserId: MANAGER_USER, managerEmployeeId: "BS-1002" },
    ]);
    const employeesRead = calls[1].map(c => [c.table, c.method, ...c.args]);
    expect(employeesRead[0]).toEqual(["employees", "select", "employee_id,auth_user_id"]);
    expect(employeesRead[1][0]).toBe("employees");
    expect(employeesRead[1][1]).toBe("in");
    expect(employeesRead[1][2]).toBe("auth_user_id");
    expect([...(employeesRead[1][3] as string[])].sort()).toEqual([ADMIN_USER, MANAGER_USER].sort());
  });

  it("reports unavailable when the manager lookup fails, never a list without managers", async () => {
    const rows = seeded();
    rows[0].manager_user_id = ADMIN_USER;
    const { client } = fakeClient(rows, { employees: people(), employeesError: { code: "42501", message: "rls" } });
    await expect(storeFor(client).list(admin)).rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});

describe("departments-store setManager (Story 4.2)", () => {
  it("sets the manager to the employee's linked account", async () => {
    const rows = seeded();
    const { client, calls } = fakeClient(rows, { employees: people() });
    const saved = await storeFor(client).setManager(admin, CRD, "BS-1002");
    expect(saved).toEqual({ id: CRD, name: "Central R&D", parentId: LND, managerUserId: MANAGER_USER, managerEmployeeId: "BS-1002" });
    expect(writes(calls)).toEqual([{ table: "departments", method: "update", args: [{ manager_user_id: MANAGER_USER }] }]);
    expect(calls.at(-1)).toContainEqual({ table: "departments", method: "eq", args: ["id", CRD] });
    expect(rows[1].manager_user_id).toBe(MANAGER_USER);
  });

  it("removes the manager for null, without reading employees", async () => {
    const rows = seeded();
    rows[1].manager_user_id = MANAGER_USER;
    const { client, calls } = fakeClient(rows, { employees: people() });
    expect(await storeFor(client).setManager(admin, CRD, null)).toMatchObject({ id: CRD, ...none });
    expect(writes(calls)).toEqual([{ table: "departments", method: "update", args: [{ manager_user_id: null }] }]);
    expect(calls.flat().filter(c => c.table === "employees" && c.args[0] === "employee_id,name,auth_user_id,archived_at")).toHaveLength(0);
  });

  it("refuses an employee with no sign-in account, naming them, and never creates one", async () => {
    const { client, calls } = fakeClient(seeded(), { employees: people() });
    const refused = storeFor(client).setManager(admin, CRD, "BS-1003");
    await expect(refused).rejects.toBeInstanceOf(ManagerHasNoAccountError);
    await expect(refused).rejects.toThrow("Meera Das has no sign-in account yet. Provision their account first, then make them a manager.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses an archived employee without an account as archived, not as provision-first", async () => {
    const archivedNoAccount: EmployeeRow = { employee_id: "BS-1005", name: "Sadia Islam", auth_user_id: null, archived_at: "2026-10-01T00:00:00Z" };
    const { client, calls } = fakeClient(seeded(), { employees: [...people(), archivedNoAccount] });
    const refused = storeFor(client).setManager(admin, CRD, "BS-1005");
    await expect(refused).rejects.toBeInstanceOf(ManagerArchivedError);
    await expect(refused).rejects.toThrow("Sadia Islam's account is archived. Restore it first.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses an archived employee", async () => {
    const { client, calls } = fakeClient(seeded(), { employees: people() });
    const refused = storeFor(client).setManager(admin, CRD, "BS-1004");
    await expect(refused).rejects.toBeInstanceOf(ManagerArchivedError);
    await expect(refused).rejects.toThrow("Tanvir Hasan's account is archived. Restore it first.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses an unknown employee or department, without writing", async () => {
    const { client, calls } = fakeClient(seeded(), { employees: people() });
    await expect(storeFor(client).setManager(admin, CRD, "BS-9999")).rejects.toBeInstanceOf(ManagerEmployeeNotFoundError);
    await expect(storeFor(client).setManager(admin, UNKNOWN, "BS-1002")).rejects.toBeInstanceOf(DepartmentNotFoundError);
    await expect(storeFor(client).setManager(admin, UNKNOWN, null)).rejects.toBeInstanceOf(DepartmentNotFoundError);
    expect(writes(calls)).toHaveLength(0);
  });

  it("reports not found when the update matches no row, and unavailable on errors", async () => {
    await expect(storeFor(fakeClient(seeded(), { employees: people(), writeNone: true }).client).setManager(admin, CRD, null))
      .rejects.toBeInstanceOf(DepartmentNotFoundError);
    await expect(storeFor(fakeClient(seeded(), { employees: people(), writeError: { code: "42501", message: "rls" } }).client).setManager(admin, CRD, null))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
    await expect(storeFor(fakeClient(seeded(), { employees: people(), employeesError: { code: "42501", message: "rls" } }).client).setManager(admin, CRD, "BS-1002"))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
    await expect(storeFor(fakeClient(seeded(), { throws: true }).client).setManager(admin, CRD, null))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});

describe("departments-store managesAny (Story 4.2)", () => {
  it("is true when the user manages a department, reading only through the departments table", async () => {
    const rows = seeded();
    rows[2].manager_user_id = MANAGER_USER;
    const { client, calls } = fakeClient(rows);
    expect(await storeFor(client).managesAny(MANAGER_USER)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContainEqual({ table: "departments", method: "eq", args: ["manager_user_id", MANAGER_USER] });
    expect(calls[0]).toContainEqual({ table: "departments", method: "limit", args: [1] });
    expect(writes(calls)).toHaveLength(0);
  });

  it("is false when the user manages nothing", async () => {
    expect(await storeFor(fakeClient(seeded()).client).managesAny(MANAGER_USER)).toBe(false);
  });

  it("throws unavailable on a read error, never false", async () => {
    await expect(storeFor(fakeClient(seeded(), { readError: { code: "42703", message: "missing column" } }).client).managesAny(MANAGER_USER))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
    await expect(storeFor(fakeClient(seeded(), { throws: true }).client).managesAny(MANAGER_USER))
      .rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });
});

describe("departments-store after a committed write (Story 4.2)", () => {
  it("returns the saved department with an unknown manager Employee ID when the follow-up lookup fails, never 'not saved'", async () => {
    const rows = seeded();
    rows[2].manager_user_id = MANAGER_USER;
    // The employees read fails; the departments read and the update succeed.
    const { client, calls } = fakeClient(rows, { employees: people() });
    let employeesReads = 0;
    const flaky = {
      from(table: string) {
        if (table === "employees" && ++employeesReads > 1) return fakeClient([], { employeesError: { code: "08006", message: "connection lost" } }).client.from("employees");
        return client.from(table);
      },
    } as unknown as SupabaseClient;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved = await storeFor(flaky).update(admin, QA, { name: "Quality Lab", parentId: LND });
      expect(saved).toEqual({ id: QA, name: "Quality Lab", parentId: LND, managerUserId: MANAGER_USER, managerEmployeeId: null });
      expect(writes(calls)).toHaveLength(1);
      expect(rows[2].name).toBe("Quality Lab");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("departments-store listFor (Story 4.3)", () => {
  /** A stand-in manager-scope that records each call and returns the given departments. */
  function fakeScope(departmentIds: string[], fail?: Error) {
    const calls: unknown[] = [];
    const scope: ManagerScope = {
      async forManager(session) {
        calls.push(session);
        if (fail) throw fail;
        return { departmentIds: new Set(departmentIds), employeeIds: new Set() };
      },
    };
    return { scope, calls };
  }

  it("gives an Administrator every department, exactly like list, without a scope read", async () => {
    const { client } = fakeClient(seeded());
    const { scope, calls } = fakeScope([]);
    const store = createDepartmentsStore({ userClient: async () => client, scope });
    expect(await store.listFor(admin)).toEqual(await store.list(admin));
    expect(calls).toHaveLength(0);
  });

  it("gives a manager only the departments in scope, by name, with manager fields resolved", async () => {
    const rows = seeded();
    rows[1].manager_user_id = MANAGER_USER;
    const { client, calls } = fakeClient(rows, { employees: people() });
    const scope = fakeScope([CRD, QA]);
    const list = await createDepartmentsStore({ userClient: async () => client, scope: scope.scope }).listFor(manager);
    expect(list).toEqual([
      { id: CRD, name: "Central R&D", parentId: LND, managerUserId: MANAGER_USER, managerEmployeeId: "BS-1002" },
      { id: QA, name: "QA Lab", parentId: CRD, ...none },
    ]);
    expect(scope.calls).toEqual([manager]);
    expect(calls[0].find(c => c.method === "in")?.args).toEqual(["id", [CRD, QA]]);
  });

  it("drops a returned department outside the scope (defence in depth)", async () => {
    const { client } = fakeClient(seeded());
    // A client whose `in` filter is ignored, so the query returns every department.
    const leaky = { from: (t: string) => { const b = client.from(t); return Object.assign(b, { in: () => b }); } } as unknown as SupabaseClient;
    const list = await createDepartmentsStore({ userClient: async () => leaky, scope: fakeScope([QA]).scope }).listFor(manager);
    expect(list.map(d => d.id)).toEqual([QA]);
  });

  it("returns no departments, without a query, when nothing is in scope", async () => {
    const { client, calls } = fakeClient(seeded());
    expect(await createDepartmentsStore({ userClient: async () => client, scope: fakeScope([]).scope }).listFor(manager)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reports unavailable when the scope cannot be read", async () => {
    const { client } = fakeClient(seeded());
    const scope = fakeScope([], new ManagerScopeUnavailableError()).scope;
    await expect(createDepartmentsStore({ userClient: async () => client, scope }).listFor(manager)).rejects.toBeInstanceOf(DepartmentsUnavailableError);
  });

  it("refuses staff and no session before any query", async () => {
    const { client, calls } = fakeClient(seeded());
    const scope = fakeScope([LND]);
    const store = createDepartmentsStore({ userClient: async () => client, scope: scope.scope });
    await expect(store.listFor(staff)).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    await expect(store.listFor(null as unknown as typeof admin)).rejects.toBeInstanceOf(DepartmentsForbiddenError);
    expect(calls).toHaveLength(0);
    expect(scope.calls).toHaveLength(0);
  });
});
