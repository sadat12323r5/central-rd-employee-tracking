import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createEmploymentHistoryStore, EmploymentHistoryForbiddenError, EmploymentHistoryInvalidError, EmploymentHistoryNotFoundError,
  EmploymentHistoryRemovedError, EmploymentHistoryUnavailableError, toEmploymentHistoryEntry, type EmploymentHistoryRow,
} from "@/server/employment-history-store";
import type { EmploymentHistoryInput } from "@/domain/employment-history";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import { many, pagedClient } from "./support/paged-client";

type Mode = "ok" | "error" | "throw" | "foreign" | "check" | "denied" | "update-none";
type Call = { table: string; method: string; args: unknown[] };

/**
 * Minimal stand-in for the supabase-js query builder: records every call and applies eq / in / is filters
 * to rows. An update applies its values to the matching rows (so tests can inspect them) and returns them.
 */
function fakeClient(rows: EmploymentHistoryRow[], mode: Mode = "ok") {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        if (mode === "error") return { data: null, error: { code: "PGRST205", message: "relation does not exist" } };
        const write = query.find(c => c.method === "insert" || c.method === "update");
        if (write && mode === "check") return { data: null, error: { code: "23514", message: "violates check constraint" } };
        if (write && mode === "denied") return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
        const inserted = query.find(c => c.method === "insert");
        if (inserted) {
          const row = { id: "new-id", created_at: "2026-10-15T08:00:00Z", removed_at: null, ...(inserted.args[0] as object) } as EmploymentHistoryRow;
          rows.push(row);
          return { data: mode === "foreign" ? { ...row, employee_id: "BS-1999" } : row, error: null };
        }
        const filters = query.filter(c => c.method === "eq" || c.method === "is").map(c => c.args as [string, unknown]);
        const within = query.find(c => c.method === "in")?.args as [string, string[]] | undefined;
        const matching = rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)
          && (!within || within[1].includes((r as Record<string, string>)[within[0]])));
        const updated = query.find(c => c.method === "update");
        if (updated) {
          if (mode === "update-none") return { data: null, error: null };
          for (const r of matching) Object.assign(r, updated.args[0]);
        }
        const one = query.some(c => c.method === "maybeSingle" || c.method === "single");
        return { data: one ? (matching[0] ?? null) : matching, error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "order", "range", "insert", "update", "delete", "maybeSingle", "single"]) {
        builder[method] = (...args: unknown[]) => { record(method, args); return builder; };
      }
      builder.returns = () => builder;
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** A stand-in manager-scope returning the given employee ids (or failing), recording each call. */
function fakeScope(employeeIds: string[], fail?: Error) {
  const calls: unknown[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw fail;
      return { departmentIds: new Set(["d"]), employeeIds: new Set(employeeIds) };
    },
  };
  return { scope, calls };
}

const storeFor = (client: SupabaseClient, scope: ManagerScope = fakeScope(["BS-1002"]).scope) =>
  createEmploymentHistoryStore({ userClient: async () => client, scope });
const COLUMNS = "id,employee_id,role,employer,period,detail,created_at,removed_at";

const row = (employee_id: string, id: string, period: string, extra: Partial<EmploymentHistoryRow> = {}): EmploymentHistoryRow => ({
  id, employee_id, role: "Engineer", employer: "Brain Station 23", period, detail: "", created_at: "2026-10-01T00:00:00Z", removed_at: null, ...extra,
});
const fresh = () => [
  row("BS-1001", "a", "2021 – 2022"),
  row("BS-1001", "b", "Mar 2023 – Present"),
  row("BS-1001", "c", "2022-02-06 – Present"),
  row("BS-1002", "m", "2020 – 2021"),
  row("BS-1003", "u", "2019 – 2020"),
  row("BS-1001", "r", "2024 – Present", { removed_at: "2026-10-10T00:00:00Z" }),
];
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const manager = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const input: EmploymentHistoryInput = { role: "  Senior   Engineer ", employer: " Orbit  Analytics ", period: " 2025 –  Present ", detail: " Led the API team. " };
const normalized = { role: "Senior Engineer", employer: "Orbit Analytics", period: "2025 – Present", detail: "Led the API team." };
const writes = (calls: Call[][]) => calls.flat().filter(c => c.method === "insert" || c.method === "update" || c.method === "delete");

describe("employment-history-store mapping", () => {
  it("maps a row to an entry, with the employer as the profile's company", () => {
    expect(toEmploymentHistoryEntry(row("BS-1001", "a", "2021 – 2022", { detail: "Did things." }))).toEqual({
      id: "a", employeeId: "BS-1001", role: "Engineer", company: "Brain Station 23", period: "2021 – 2022", detail: "Did things.",
      createdAt: "2026-10-01T00:00:00Z",
    });
  });
});

describe("employment-history-store reads", () => {
  it("lists active entries only, newest first per employee, for an admin", async () => {
    const { client, calls } = fakeClient(fresh());
    const list = await storeFor(client).listFor(admin);
    expect(list.map(e => e.id)).toEqual(["b", "c", "a", "m", "u"]);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", COLUMNS],
      ["is", "removed_at", null],
      ["order", "employee_id"],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["range", 0, 999],
    ]);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient(fresh());
    expect((await storeFor(client).listFor(admin, "BS-1002")).map(e => e.id)).toEqual(["m"]);
    expect(calls[0]).toContainEqual({ table: "employment_history", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("filters staff reads to the session's own employee in the query", async () => {
    const { client, calls } = fakeClient(fresh());
    expect((await storeFor(client).listFor(staff)).map(e => e.id)).toEqual(["b", "c", "a"]);
    expect((await storeFor(client).listFor(staff, "BS-1001")).map(e => e.id)).toEqual(["b", "c", "a"]);
    for (const query of calls) expect(query).toContainEqual({ table: "employment_history", method: "eq", args: ["employee_id", "BS-1001"] });
  });

  it("returns nothing, without a query, when staff ask for another employee's history", async () => {
    const { client, calls } = fakeClient(fresh());
    expect(await storeFor(client).listFor(staff, "BS-1002")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("filters a manager's reads to the subtree, and drops anything else returned (defence in depth)", async () => {
    const { client, calls } = fakeClient(fresh());
    const scope = fakeScope(["BS-1002"]);
    expect((await storeFor(client, scope.scope).listFor(manager)).map(e => e.id)).toEqual(["m"]);
    expect(calls[0]).toContainEqual({ table: "employment_history", method: "in", args: ["employee_id", ["BS-1002"]] });
    const leaky = { from: (t: string) => { const b = client.from(t) as unknown as Record<string, unknown>; b.in = () => b; return b; } } as unknown as SupabaseClient;
    expect((await storeFor(leaky, scope.scope).listFor(manager)).map(e => e.id)).toEqual(["m"]);
    expect(scope.calls).toEqual([manager, manager]);
  });

  it("returns nothing, without a query, for a manager outside the subtree or with an empty subtree", async () => {
    const { client, calls } = fakeClient(fresh());
    expect(await storeFor(client).listFor(manager, "BS-1003")).toEqual([]);
    expect(await storeFor(client, fakeScope([]).scope).listFor(manager)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("is unavailable, without a query, when the manager's scope cannot be read", async () => {
    const { client, calls } = fakeClient(fresh());
    await expect(storeFor(client, fakeScope([], new ManagerScopeUnavailableError()).scope).listFor(manager)).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
    expect(calls).toHaveLength(0);
  });
});

describe("employment-history-store add", () => {
  it("adds a normalised entry for the staff member's own record", async () => {
    const { client, calls } = fakeClient([]);
    const saved = await storeFor(client).add(staff, "BS-1001", input);
    expect(saved).toEqual({ id: "new-id", employeeId: "BS-1001", role: normalized.role, company: normalized.employer, period: normalized.period, detail: normalized.detail, createdAt: "2026-10-15T08:00:00Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["insert", { employee_id: "BS-1001", ...normalized }], ["select", COLUMNS], ["single"],
    ]);
  });

  it("refuses staff adding to another employee's history, without a query", async () => {
    const { client, calls } = fakeClient([]);
    await expect(storeFor(client).add(staff, "BS-1002", input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("lets an admin add for anyone and a manager for an employee in the subtree", async () => {
    const { client } = fakeClient([]);
    expect((await storeFor(client).add(admin, "BS-1003", input)).employeeId).toBe("BS-1003");
    expect((await storeFor(client).add(manager, "BS-1002", input)).employeeId).toBe("BS-1002");
  });

  it("refuses a manager outside the subtree without a write, and is unavailable when the scope fails", async () => {
    const { client, calls } = fakeClient([]);
    await expect(storeFor(client).add(manager, "BS-1003", input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
    await expect(storeFor(client, fakeScope([], new ManagerScopeUnavailableError()).scope).add(manager, "BS-1002", input))
      .rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid entry without a query, naming the fields", async () => {
    const { client, calls } = fakeClient([]);
    const error = await storeFor(client).add(admin, "BS-1001", { role: " ", employer: "x".repeat(201), period: "Present", detail: "d".repeat(2001) }).catch(e => e);
    expect(error).toBeInstanceOf(EmploymentHistoryInvalidError);
    expect(error.fields).toEqual(["role", "employer", "period", "detail"]);
    expect(calls).toHaveLength(0);
  });

  it("maps a table check (23514) to invalid and an RLS refusal (42501) to forbidden", async () => {
    await expect(storeFor(fakeClient([], "check").client).add(admin, "BS-1001", input)).rejects.toBeInstanceOf(EmploymentHistoryInvalidError);
    await expect(storeFor(fakeClient([], "denied").client).add(staff, "BS-1001", input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
  });

  it("never reports a row stored for another employee as saved", async () => {
    await expect(storeFor(fakeClient([], "foreign").client).add(admin, "BS-1001", input)).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
  });
});

describe("employment-history-store update", () => {
  it("updates the staff member's own active entry, filtered by id, the row's employee and removed_at is null", async () => {
    const data = fresh();
    const { client, calls } = fakeClient(data);
    const saved = await storeFor(client).update(staff, "a", input);
    expect(saved).toMatchObject({ id: "a", employeeId: "BS-1001", role: normalized.role, company: normalized.employer });
    expect(calls).toHaveLength(2);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([["select", COLUMNS], ["eq", "id", "a"], ["maybeSingle"]]);
    expect(calls[1].map(c => [c.method, ...c.args])).toEqual([
      ["update", normalized],
      ["eq", "id", "a"], ["eq", "employee_id", "BS-1001"], ["is", "removed_at", null],
      ["select", COLUMNS], ["maybeSingle"],
    ]);
  });

  it("takes the subject from the target row: staff see another employee's entry or an unknown id as not found", async () => {
    for (const id of ["m", "missing"]) {
      const { client, calls } = fakeClient(fresh());
      await expect(storeFor(client).update(staff, id, input)).rejects.toBeInstanceOf(EmploymentHistoryNotFoundError);
      expect(writes(calls)).toEqual([]);
    }
  });

  it("lets an admin edit anyone's entry and a manager an entry in the subtree", async () => {
    const data = fresh();
    const { client, calls } = fakeClient(data);
    await storeFor(client).update(admin, "u", input);
    await storeFor(client).update(manager, "m", input);
    expect(data.find(r => r.id === "u")?.role).toBe(normalized.role);
    expect(data.find(r => r.id === "m")?.role).toBe(normalized.role);
    expect(calls[3]).toContainEqual({ table: "employment_history", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("refuses a manager outside the subtree without a write", async () => {
    const { client, calls } = fakeClient(fresh());
    await expect(storeFor(client).update(manager, "u", input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses a removed entry without a write", async () => {
    const { client, calls } = fakeClient(fresh());
    await expect(storeFor(client).update(staff, "r", input)).rejects.toBeInstanceOf(EmploymentHistoryRemovedError);
    await expect(storeFor(client).update(admin, "r", input)).rejects.toBeInstanceOf(EmploymentHistoryRemovedError);
    expect(writes(calls)).toEqual([]);
  });

  it("rejects an invalid entry without a query", async () => {
    const { client, calls } = fakeClient(fresh());
    await expect(storeFor(client).update(admin, "a", { ...input, period: "Present" })).rejects.toBeInstanceOf(EmploymentHistoryInvalidError);
    expect(calls).toHaveLength(0);
  });

  it("reports not found when the guarded update matches no row (removed in between)", async () => {
    await expect(storeFor(fakeClient(fresh(), "update-none").client).update(staff, "a", input)).rejects.toBeInstanceOf(EmploymentHistoryNotFoundError);
  });

  it("never reports a refused write (e.g. the guard trigger) as saved", async () => {
    await expect(storeFor(fakeClient(fresh(), "check").client).update(staff, "a", input)).rejects.toBeInstanceOf(EmploymentHistoryInvalidError);
    await expect(storeFor(fakeClient(fresh(), "denied").client).update(staff, "a", input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
  });
});

describe("employment-history-store remove", () => {
  it("sets removed_at on an active entry and nothing else; the row is kept and never deleted", async () => {
    const data = fresh();
    const { client, calls } = fakeClient(data);
    const removed = await storeFor(client).remove(staff, "a");
    expect(removed.id).toBe("a");
    const update = calls[1].find(c => c.method === "update")!.args[0] as Record<string, unknown>;
    expect(Object.keys(update)).toEqual(["removed_at"]);
    expect(Number.isNaN(Date.parse(update.removed_at as string))).toBe(false);
    expect(calls[1]).toContainEqual({ table: "employment_history", method: "is", args: ["removed_at", null] });
    expect(calls.flat().some(c => c.method === "delete")).toBe(false);
    expect(data.find(r => r.id === "a")).toBeDefined();
  });

  it("hides a removed entry from every list afterwards", async () => {
    const { client } = fakeClient(fresh());
    const store = storeFor(client);
    await store.remove(admin, "b");
    expect((await store.listFor(admin, "BS-1001")).map(e => e.id)).toEqual(["c", "a"]);
    expect((await store.listFor(staff)).map(e => e.id)).toEqual(["c", "a"]);
  });

  it("refuses removing again, another employee's entry for staff, and a manager outside the subtree", async () => {
    const data = fresh();
    const before = structuredClone(data);
    const { client, calls } = fakeClient(data);
    await expect(storeFor(client).remove(staff, "r")).rejects.toBeInstanceOf(EmploymentHistoryRemovedError);
    await expect(storeFor(client).remove(staff, "m")).rejects.toBeInstanceOf(EmploymentHistoryNotFoundError);
    await expect(storeFor(client).remove(manager, "u")).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
    expect(writes(calls)).toEqual([]);
    expect(data).toEqual(before);
  });
});

describe("employment-history-store unavailability", () => {
  const calls = (store: ReturnType<typeof createEmploymentHistoryStore>) => [
    () => store.listFor(admin), () => store.listFor(staff), () => store.listFor(manager), () => store.add(staff, "BS-1001", input),
    () => store.update(staff, "a", input), () => store.remove(staff, "a"),
  ];

  it("throws EmploymentHistoryUnavailableError when the database returns an error (including a missing table)", async () => {
    const { client } = fakeClient(fresh(), "error");
    for (const call of calls(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
  });

  it("throws EmploymentHistoryUnavailableError on a network failure", async () => {
    const { client } = fakeClient(fresh(), "throw");
    for (const call of calls(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
  });

  it("throws EmploymentHistoryUnavailableError when the user client cannot be created", async () => {
    const store = createEmploymentHistoryStore({ userClient: async () => { throw new Error("Supabase is not configured"); }, scope: fakeScope(["BS-1002"]).scope });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
  });

  it("rethrows a non-availability scope error unchanged", async () => {
    const bug = new TypeError("bug");
    await expect(storeFor(fakeClient(fresh()).client, fakeScope([], bug).scope).listFor(manager)).rejects.toBe(bug);
  });
});

describe("employment-history-store paging (Story 8.2)", () => {
  const rowAt = (i: number) => row("BS-1001", `row-${String(i).padStart(4, "0")}`, "2020");

  it("reads 1000-row pages until a short page, using every row", async () => {
    const { client, ranges } = pagedClient([many(1000, rowAt), many(1000, rowAt, 1000), many(3, rowAt, 2000)]);
    const all = await storeFor(client).listFor(admin);
    expect(all).toHaveLength(2003);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("throws the unavailable error when a later page fails", async () => {
    const { client, requests } = pagedClient([many(1000, rowAt), "error", many(3, rowAt)]);
    await expect(storeFor(client).listFor(admin)).rejects.toBeInstanceOf(EmploymentHistoryUnavailableError);
    expect(requests()).toBe(2);
  });
});
