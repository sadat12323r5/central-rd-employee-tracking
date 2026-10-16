import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  BackfillDepartmentError, BackfillForbiddenError, BackfillInvalidError, BackfillNoEmployeeError, BackfillUnavailableError,
  BackfillWithdrawnError, compareBackfilledProjects, createBackfilledProjectStore, toBackfilledProject, validateBackfillInput,
  type BackfilledProjectRow, type BackfillInput,
} from "@/server/backfilled-project-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import type { SessionIdentity } from "@/server/session";

const CRD = "de9a0000-0000-4000-8000-000000000002";
const LND = "de9a0000-0000-4000-8000-000000000001";
const UNLISTED = "de9a0000-0000-4000-8000-0000000000ff";
const OWN = "bf000000-0000-4000-8000-000000000001";
const OWN_WITHDRAWN = "bf000000-0000-4000-8000-000000000002";
const OTHERS = "bf000000-0000-4000-8000-000000000003";
const MANAGERS_OWN = "bf000000-0000-4000-8000-000000000004";

type Call = { table: string; method: string; args: unknown[] };
type Failure = { method: string; error: { code?: string; message: string } };
type State = { rows: BackfilledProjectRow[]; departments: { id: string; name: string; manager_user_id?: string }[] };

/**
 * Minimal in-memory stand-in for the supabase-js query builder over `backfilled_projects`, plus the
 * `department_options` rpc. Inserts and updates behave like the guard trigger (an insert is active with
 * database timestamps; an update stamps updated_at, and withdrawn_at on a withdrawal). Records every call;
 * `fail` makes the first matching operation (select, insert, update or rpc) return an error.
 */
function fakeDb(state: State, fail: Failure[] = []) {
  const calls: Call[][] = [];
  let seq = 0;
  const failure = (op: string) => {
    const found = fail.find(f => f.method === op);
    if (found) fail.splice(fail.indexOf(found), 1);
    return found;
  };
  const client = {
    async rpc(name: string, ...args: unknown[]) {
      calls.push([{ table: "rpc", method: name, args }]);
      const failed = failure("rpc");
      if (failed) return { data: null, error: failed.error };
      if (name !== "department_options") return { data: null, error: { code: "PGRST202", message: "no such function" } };
      // The function returns id and name only, whatever else the table holds.
      return { data: state.departments.map(d => ({ id: d.id, name: d.name })), error: null };
    },
    from(table: string) {
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => { query.push({ table, method, args }); return builder; };
      const has = (method: string) => query.some(c => c.method === method);
      const matches = (row: Record<string, unknown>) =>
        query.filter(c => c.method === "eq").every(c => row[c.args[0] as string] === c.args[1])
        && query.filter(c => c.method === "in").every(c => (c.args[1] as unknown[]).includes(row[c.args[0] as string]));
      const result = (): { data: unknown; error: unknown } => {
        const op = has("insert") ? "insert" : has("update") ? "update" : "select";
        const failed = failure(op);
        if (failed) return { data: null, error: failed.error };
        const rows = state.rows as unknown as Record<string, unknown>[];
        if (op === "insert") {
          const input = query.find(c => c.method === "insert")!.args[0] as Record<string, unknown>;
          const at = `2026-10-16T00:00:0${++seq}Z`;
          const row = {
            id: `bf000000-0000-4000-8000-${String(100 + seq).padStart(12, "0")}`, ...input,
            status: "active", withdrawn_at: null, created_at: at, updated_at: at,
          } as BackfilledProjectRow;
          state.rows.push(row);
          return { data: [row], error: null };
        }
        if (op === "update") {
          const changes = query.find(c => c.method === "update")!.args[0] as Record<string, unknown>;
          const hit = rows.filter(matches);
          for (const row of hit) {
            Object.assign(row, changes, { updated_at: "2026-10-17T00:00:00Z" });
            if (changes.status === "withdrawn") row.withdrawn_at = "2026-10-17T00:00:00Z";
          }
          return { data: hit.map(r => ({ ...r })), error: null };
        }
        let data = rows.filter(matches).map(r => ({ ...r }));
        const range = query.find(c => c.method === "range");
        if (range) data = data.slice(range.args[0] as number, (range.args[1] as number) + 1);
        return { data, error: null };
      };
      const one = async (strict: boolean) => {
        const r = result();
        if (r.error) return r;
        const list = r.data as unknown[];
        if (strict && list.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one row" } };
        return { data: list[0] ?? null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: (...args: unknown[]) => record("select", args),
        eq: (...args: unknown[]) => record("eq", args),
        in: (...args: unknown[]) => record("in", args),
        order: (...args: unknown[]) => record("order", args),
        range: (...args: unknown[]) => record("range", args),
        insert: (...args: unknown[]) => record("insert", args),
        update: (...args: unknown[]) => record("update", args),
        upsert: (...args: unknown[]) => record("upsert", args),
        delete: (...args: unknown[]) => record("delete", args),
        returns: () => builder,
        maybeSingle: () => one(false),
        single: () => one(true),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  const writes = () => calls.flat().filter(c => ["insert", "update", "upsert", "delete"].includes(c.method));
  return { client: client as unknown as SupabaseClient, calls, writes, state };
}

const row = (id: string, employee_id: string, extra: Partial<BackfilledProjectRow> = {}): BackfilledProjectRow => ({
  id, employee_id, department_id: LND, client: "Old Bank (fictional)", project_name: `Project ${id.slice(-1)}`, completion_date: "2025-06-30",
  outcome: "Delivered.", status: "active", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", withdrawn_at: null, ...extra,
});

function world(): State {
  return {
    rows: [
      row(OWN, "BS-1001", { completion_date: "2025-06-30" }),
      row(OWN_WITHDRAWN, "BS-1001", { completion_date: "2026-01-31", status: "withdrawn", withdrawn_at: "2026-10-02T00:00:00Z" }),
      row(OTHERS, "BS-1003", { department_id: CRD }),
      row(MANAGERS_OWN, "BS-1009"),
    ],
    departments: [
      { id: LND, name: "L&D", manager_user_id: "u-admin" },
      { id: CRD, name: "Central R&D" },
    ],
  };
}

const admin = { role: "admin" } as const;
const manager = { role: "manager", employeeId: "BS-1009", userId: "u-mgr" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const otherStaff = { role: "staff", employeeId: "BS-1003" } as const;

/** An injected manager scope (BS-1001 and BS-1002 in scope), recording each call. */
function fakeScope(employees: string[] = ["BS-1001", "BS-1002"], fail = false) {
  const calls: SessionIdentity[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw new ManagerScopeUnavailableError({ cause: "connection refused" });
      return { departmentIds: new Set([LND]), employeeIds: new Set(employees) };
    },
  };
  return { scope, calls };
}

/** 12:00 in Dhaka on 28 Sep 2026. */
const NOW = new Date("2026-09-28T06:00:00Z");
const storeFor = (db: ReturnType<typeof fakeDb>, scope = fakeScope().scope, now = NOW) =>
  createBackfilledProjectStore({ userClient: async () => db.client, scope, now: () => now });

const input: BackfillInput = {
  departmentId: CRD, client: "  Harbour Systems (fictional) ", projectName: " Data migration ", completionDate: "2025-12-15",
  outcome: "  Migrated 40 services.  ",
};

describe("backfilled-project-store reads", () => {
  it("gives an admin every entry, or one employee's, withdrawn ones included", async () => {
    expect((await storeFor(fakeDb(world())).listFor(admin)).map(p => p.id).sort()).toEqual([OWN, OWN_WITHDRAWN, OTHERS, MANAGERS_OWN].sort());
    expect((await storeFor(fakeDb(world())).listFor(admin, "BS-1001")).map(p => p.id)).toEqual([OWN_WITHDRAWN, OWN]);
  });

  it("maps the row to the camel-cased BackfilledProject with a materialized provenance", () => {
    expect(toBackfilledProject(row(OWN, "BS-1001"))).toEqual({
      id: OWN, employeeId: "BS-1001", departmentId: LND, client: "Old Bank (fictional)", projectName: "Project 1", completionDate: "2025-06-30",
      outcome: "Delivered.", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", withdrawnAt: null,
      provenance: "backfilled",
    });
  });

  it("orders newest completion first, then newest creation, then id", async () => {
    const a = toBackfilledProject(row("b", "BS-1", { completion_date: "2025-01-01" }));
    const b = toBackfilledProject(row("a", "BS-1", { completion_date: "2026-01-01" }));
    const c = toBackfilledProject(row("c", "BS-1", { completion_date: "2026-01-01", created_at: "2026-10-05T00:00:00Z" }));
    const d = toBackfilledProject(row("0", "BS-1", { completion_date: "2026-01-01" }));
    expect([a, b, c, d].sort(compareBackfilledProjects).map(p => p.id)).toEqual(["c", "0", "a", "b"]);
    // The query asks the database for the same order.
    const db = fakeDb(world());
    await storeFor(db).listFor(admin);
    expect(db.calls[0].filter(c => c.method === "order").map(c => c.args)).toEqual([
      ["completion_date", { ascending: false }], ["created_at", { ascending: false }], ["id"],
    ]);
  });

  it("gives Staff only their own entries; anyone else's is [] without a query", async () => {
    const db = fakeDb(world());
    const store = storeFor(db);
    expect((await store.listFor(staff)).map(p => p.id)).toEqual([OWN_WITHDRAWN, OWN]);
    expect((await store.listFor(otherStaff)).map(p => p.id)).toEqual([OTHERS]);
    const before = db.calls.length;
    expect(await store.listFor(staff, "BS-1003")).toEqual([]);
    expect(db.calls.length).toBe(before);
  });

  it("gives a manager the entries of in-scope employees only", async () => {
    const scope = fakeScope();
    expect((await storeFor(fakeDb(world()), scope.scope).listFor(manager)).map(p => p.id)).toEqual([OWN_WITHDRAWN, OWN]);
    expect(scope.calls).toEqual([manager]);
    expect((await storeFor(fakeDb(world())).listFor(manager, "BS-1001")).map(p => p.id)).toEqual([OWN_WITHDRAWN, OWN]);
    const db = fakeDb(world());
    expect(await storeFor(db).listFor(manager, "BS-1003")).toEqual([]);
    expect(await storeFor(db, fakeScope([]).scope).listFor(manager)).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it("throws BackfillUnavailableError (never a partial list) when a read or the scope fails", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "select", error: { code: "PGRST205", message: "missing" } }])).listFor(admin))
      .rejects.toBeInstanceOf(BackfillUnavailableError);
    await expect(storeFor(fakeDb(world()), fakeScope([], true).scope).listFor(manager)).rejects.toBeInstanceOf(BackfillUnavailableError);
    await expect(createBackfilledProjectStore({ userClient: async () => { throw new Error("not configured"); } }).listFor(admin))
      .rejects.toBeInstanceOf(BackfillUnavailableError);
  });
});

describe("backfilled-project-store department options", () => {
  it("returns every department's id and name only, sorted by name", async () => {
    const db = fakeDb(world());
    expect(await storeFor(db).departmentOptions()).toEqual([{ id: CRD, name: "Central R&D" }, { id: LND, name: "L&D" }]);
    expect(db.calls.flat()).toEqual([{ table: "rpc", method: "department_options", args: [] }]);
  });

  it("is unavailable when the function fails or returns nothing", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "rpc", error: { code: "PGRST202", message: "missing" } }])).departmentOptions())
      .rejects.toBeInstanceOf(BackfillUnavailableError);
    const empty = fakeDb(world());
    (empty.client as unknown as { rpc: () => Promise<unknown> }).rpc = async () => ({ data: null, error: null });
    await expect(storeFor(empty).departmentOptions()).rejects.toBeInstanceOf(BackfillUnavailableError);
  });
});

describe("backfilled-project-store add", () => {
  it("saves an active entry owned by the session's employee, trimmed", async () => {
    const db = fakeDb(world());
    const saved = await storeFor(db).add(staff, input);
    expect(saved).toMatchObject({
      employeeId: "BS-1001", departmentId: CRD, client: "Harbour Systems (fictional)", projectName: "Data migration",
      completionDate: "2025-12-15", outcome: "Migrated 40 services.", status: "active", withdrawnAt: null, provenance: "backfilled",
    });
    expect(db.writes()).toEqual([{
      table: "backfilled_projects", method: "insert", args: [{
        employee_id: "BS-1001", department_id: CRD, client: "Harbour Systems (fictional)", project_name: "Data migration",
        completion_date: "2025-12-15", outcome: "Migrated 40 services.",
      }],
    }]);
  });

  it("never takes the owner from the input", async () => {
    const db = fakeDb(world());
    await storeFor(db).add(staff, { ...input, employeeId: "BS-1003" } as BackfillInput);
    expect((db.writes()[0].args[0] as Record<string, unknown>).employee_id).toBe("BS-1001");
  });

  it("lets a manager add their own entry (any session with an employee record)", async () => {
    const db = fakeDb(world());
    expect(await storeFor(db).add(manager, input)).toMatchObject({ employeeId: "BS-1009" });
  });

  it("refuses a session without an employee record (an unlinked Administrator) before anything is read", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).add(admin, input)).rejects.toBeInstanceOf(BackfillNoEmployeeError);
    await expect(storeFor(db).add(admin, input)).rejects.toThrow("Only an employee can add their own past projects.");
    expect(db.calls).toEqual([]);
  });

  it("refuses a department that is not in the list, without writing", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).add(staff, { ...input, departmentId: UNLISTED })).rejects.toBeInstanceOf(BackfillDepartmentError);
    await expect(storeFor(db).add(staff, { ...input, departmentId: "" })).rejects.toBeInstanceOf(BackfillDepartmentError);
    expect(db.writes()).toEqual([]);
  });

  it("maps the foreign-key refusal (23503) to BackfillDepartmentError", async () => {
    const db = fakeDb(world(), [{ method: "insert", error: { code: "23503", message: "fk" } }]);
    await expect(storeFor(db).add(staff, input)).rejects.toBeInstanceOf(BackfillDepartmentError);
  });

  it("maps 23514 to BackfillInvalidError, 42501 to BackfillForbiddenError and anything else to BackfillUnavailableError", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "23514", message: "check" } }])).add(staff, input))
      .rejects.toBeInstanceOf(BackfillInvalidError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "42501", message: "rls" } }])).add(staff, input))
      .rejects.toBeInstanceOf(BackfillForbiddenError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "PGRST205", message: "missing" } }])).add(staff, input))
      .rejects.toBeInstanceOf(BackfillUnavailableError);
    await expect(storeFor(fakeDb(world(), [{ method: "rpc", error: { code: "PGRST202", message: "missing" } }])).add(staff, input))
      .rejects.toBeInstanceOf(BackfillUnavailableError);
  });

  it("validates the values before writing", async () => {
    const cases: [Partial<BackfillInput>, string][] = [
      [{ client: "   " }, "Enter the client (1 to 200 characters)."],
      [{ client: "x".repeat(201) }, "Enter the client (1 to 200 characters)."],
      [{ projectName: "" }, "Enter the project name (1 to 200 characters)."],
      [{ projectName: "x".repeat(201) }, "Enter the project name (1 to 200 characters)."],
      [{ outcome: " " }, "Enter the outcome (1 to 2000 characters)."],
      [{ outcome: "x".repeat(2001) }, "Enter the outcome (1 to 2000 characters)."],
      [{ completionDate: "2025-02-30" }, "Enter a valid completion date."],
      [{ completionDate: "15/12/2025" }, "Enter a valid completion date."],
      [{ completionDate: "2026-09-29" }, "The completion date can't be in the future."],
    ];
    const db = fakeDb(world());
    for (const [change, message] of cases) {
      await expect(storeFor(db).add(staff, { ...input, ...change }), JSON.stringify(change)).rejects.toThrow(message);
      await expect(storeFor(db).add(staff, { ...input, ...change })).rejects.toBeInstanceOf(BackfillInvalidError);
    }
    expect(db.writes()).toEqual([]);
    // The limits themselves are accepted.
    expect(await storeFor(db).add(staff, { ...input, client: "x".repeat(200), projectName: "y".repeat(200), outcome: "z".repeat(2000) }))
      .toMatchObject({ status: "active" });
  });

  it("allows today in Dhaka, which can be a day ahead of UTC", async () => {
    // 20:00 UTC on 15 Oct 2026 is already 16 Oct in Dhaka.
    const late = new Date("2026-10-15T20:00:00Z");
    expect(await storeFor(fakeDb(world()), undefined, late).add(staff, { ...input, completionDate: "2026-10-16" })).toMatchObject({ completionDate: "2026-10-16" });
    expect(() => validateBackfillInput({ ...input, completionDate: "2026-10-17" }, "2026-10-16")).toThrow(BackfillInvalidError);
  });
});

describe("backfilled-project-store edit and withdraw", () => {
  it("edits the owner's active entry; updated_at changes", async () => {
    const db = fakeDb(world());
    const saved = await storeFor(db).edit(staff, OWN, input);
    expect(saved).toMatchObject({ id: OWN, employeeId: "BS-1001", departmentId: CRD, projectName: "Data migration", status: "active" });
    expect(saved.updatedAt).not.toBe("2026-10-01T00:00:00Z");
    const update = db.calls.find(q => q.some(c => c.method === "update"))!;
    expect(update.filter(c => c.method === "eq").map(c => c.args)).toEqual([["id", OWN], ["employee_id", "BS-1001"], ["status", "active"]]);
    expect(update.find(c => c.method === "update")!.args[0]).not.toHaveProperty("employee_id");
  });

  it("withdraws the owner's active entry: it stays, marked, with withdrawn_at set", async () => {
    const db = fakeDb(world());
    const withdrawn = await storeFor(db).withdraw(staff, OWN);
    expect(withdrawn).toMatchObject({ id: OWN, status: "withdrawn", provenance: "backfilled" });
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect((await storeFor(db).listFor(staff)).map(p => [p.id, p.status])).toContainEqual([OWN, "withdrawn"]);
    expect(db.writes().map(w => w.args[0])).toEqual([{ status: "withdrawn" }]);
  });

  it("refuses to change a withdrawn entry, without writing", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).edit(staff, OWN_WITHDRAWN, input)).rejects.toBeInstanceOf(BackfillWithdrawnError);
    await expect(storeFor(db).withdraw(staff, OWN_WITHDRAWN)).rejects.toThrow("This past project was withdrawn and can't be changed.");
    expect(db.writes()).toEqual([]);
  });

  it("refuses the Administrator and managers on another employee's entry, and another Staff member", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).edit(admin, OWN, input)).rejects.toBeInstanceOf(BackfillNoEmployeeError);
    await expect(storeFor(db).withdraw(admin, OWN)).rejects.toBeInstanceOf(BackfillNoEmployeeError);
    // BS-1001 is in the manager's scope, but managers read, never write.
    await expect(storeFor(db).edit(manager, OWN, input)).rejects.toBeInstanceOf(BackfillForbiddenError);
    await expect(storeFor(db).withdraw(manager, OWN)).rejects.toThrow("Only the employee who added this past project can change it.");
    await expect(storeFor(db).edit(otherStaff, OWN, input)).rejects.toBeInstanceOf(BackfillForbiddenError);
    await expect(storeFor(db).withdraw(otherStaff, OWN)).rejects.toBeInstanceOf(BackfillForbiddenError);
    // A missing (or RLS-hidden) entry is refused the same way.
    await expect(storeFor(db).withdraw(staff, "bf000000-0000-4000-8000-0000000000aa")).rejects.toBeInstanceOf(BackfillForbiddenError);
    expect(db.writes()).toEqual([]);
  });

  it("lets a manager edit and withdraw their own entry", async () => {
    const db = fakeDb(world());
    expect(await storeFor(db).edit(manager, MANAGERS_OWN, input)).toMatchObject({ employeeId: "BS-1009" });
    expect(await storeFor(db).withdraw(manager, MANAGERS_OWN)).toMatchObject({ status: "withdrawn" });
  });

  it("refuses an unlisted department and invalid values on edit", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).edit(staff, OWN, { ...input, departmentId: UNLISTED })).rejects.toBeInstanceOf(BackfillDepartmentError);
    await expect(storeFor(db).edit(staff, OWN, { ...input, outcome: "" })).rejects.toBeInstanceOf(BackfillInvalidError);
    await expect(storeFor(db).edit(staff, OWN, { ...input, completionDate: "2027-01-01" })).rejects.toBeInstanceOf(BackfillInvalidError);
    expect(db.writes()).toEqual([]);
  });

  it("explains an update that matched nothing: withdrawn meanwhile, or refused by RLS", async () => {
    // The pre-check saw an active row; the update then matched nothing because it was withdrawn meanwhile.
    const raced = fakeDb(world());
    const original = raced.client.from.bind(raced.client);
    let reads = 0;
    (raced.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = original(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const update = builder.update;
      builder.update = (...args: unknown[]) => {
        const target = raced.state.rows.find(r => r.id === OWN)!;
        target.status = "withdrawn";
        target.withdrawn_at = "2026-10-17T00:00:00Z";
        return update(...args);
      };
      reads++;
      return builder;
    };
    await expect(storeFor(raced).withdraw(staff, OWN)).rejects.toBeInstanceOf(BackfillWithdrawnError);
    expect(reads).toBeGreaterThan(1);

    // RLS hides the update (0 rows) although the read saw the row.
    const hidden = fakeDb(world());
    const from = hidden.client.from.bind(hidden.client);
    (hidden.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      builder.update = () => builder.eq("id", "nothing-matches");
      return builder;
    };
    await expect(storeFor(hidden).edit(staff, OWN, input)).rejects.toBeInstanceOf(BackfillForbiddenError);
  });

  it("maps a database refusal on update to its typed error", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "update", error: { code: "23514", message: "withdrawn" } }])).withdraw(staff, OWN))
      .rejects.toBeInstanceOf(BackfillInvalidError);
    await expect(storeFor(fakeDb(world(), [{ method: "update", error: { code: "42501", message: "rls" } }])).edit(staff, OWN, input))
      .rejects.toBeInstanceOf(BackfillForbiddenError);
    await expect(storeFor(fakeDb(world(), [{ method: "update", error: { code: "23503", message: "fk" } }])).edit(staff, OWN, input))
      .rejects.toBeInstanceOf(BackfillDepartmentError);
    await expect(storeFor(fakeDb(world(), [{ method: "select", error: { code: "08006", message: "down" } }])).withdraw(staff, OWN))
      .rejects.toBeInstanceOf(BackfillUnavailableError);
  });

  it("has no delete path", () => {
    const store = storeFor(fakeDb(world()));
    expect(Object.keys(store).sort()).toEqual(["add", "departmentOptions", "edit", "listFor", "withdraw"]);
  });
});
