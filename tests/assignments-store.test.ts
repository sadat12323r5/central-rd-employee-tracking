import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AssignmentAlreadyOpenError, AssignmentClosedError, AssignmentEmployeeNotFoundError, AssignmentInvalidError, AssignmentNoDepartmentError,
  AssignmentsForbiddenError, AssignmentsUnavailableError, compareAssignments, createAssignmentsStore, toAssignment,
  type AssignmentInput, type AssignmentRow,
} from "@/server/assignments-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import type { SessionIdentity } from "@/server/session";

const DEPT = "d0000000-0000-4000-8000-000000000001";
const OTHER_DEPT = "d0000000-0000-4000-8000-000000000002";

type Call = { table: string; method: string; args: unknown[] };
type Failure = { table?: string; method: string; error: { code?: string; message: string } };

/**
 * Minimal in-memory stand-in for the supabase-js query builder over `employees` and `assignments`:
 * applies eq/in filters, inserts (open, with the employee's department, as the trigger does) and updates,
 * and records every call. `fail` makes the first matching operation return an error.
 */
function fakeDb(state: { employees: { employee_id: string; department_id: string | null }[]; assignments: AssignmentRow[] }, fail: Failure[] = []) {
  const calls: Call[][] = [];
  let seq = 0;
  const client = {
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
        const failure = fail.find(f => f.method === op && (f.table === undefined || f.table === table));
        if (failure) {
          fail.splice(fail.indexOf(failure), 1);
          return { data: null, error: failure.error };
        }
        const rows = (table === "employees" ? state.employees : state.assignments) as unknown as Record<string, unknown>[];
        if (op === "insert") {
          const input = query.find(c => c.method === "insert")!.args[0] as Record<string, unknown>;
          const employee = state.employees.find(e => e.employee_id === input.employee_id);
          const row: AssignmentRow = {
            id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, latest_update: "", ...(input as object),
            department_id: employee?.department_id ?? "", status: "open", completion_date: null, created_at: `2026-10-14T00:00:0${seq}Z`, closed_at: null,
          } as AssignmentRow;
          state.assignments.push(row);
          return { data: [row], error: null };
        }
        if (op === "update") {
          const changes = query.find(c => c.method === "update")!.args[0] as Record<string, unknown>;
          const hit = rows.filter(matches);
          for (const row of hit) Object.assign(row, changes, changes.status === "closed" ? { closed_at: "2026-10-15T00:00:00Z" } : {});
          return { data: hit.map(r => ({ ...r })), error: null };
        }
        let data = rows.filter(matches).map(r => ({ ...r }));
        const limit = query.find(c => c.method === "limit");
        if (limit) data = data.slice(0, limit.args[0] as number);
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
        limit: (...args: unknown[]) => record("limit", args),
        insert: (...args: unknown[]) => record("insert", args),
        update: (...args: unknown[]) => record("update", args),
        delete: (...args: unknown[]) => record("delete", args),
        returns: () => builder,
        maybeSingle: () => one(false),
        single: () => one(true),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  const writes = () => calls.flat().filter(c => c.method === "insert" || c.method === "update" || c.method === "delete");
  const reads = (table: string) => calls.filter(q => q[0]?.table === table && !q.some(c => c.method === "insert" || c.method === "update"));
  return { client: client as unknown as SupabaseClient, calls, writes, reads };
}

const row = (employee_id: string, id: string, extra: Partial<AssignmentRow> = {}): AssignmentRow => ({
  id, employee_id, department_id: DEPT, client: "Client", project_name: `Project ${id}`, role: "Engineer", allocation: 80,
  start_date: "2026-09-14", latest_update: "", status: "open", completion_date: null, created_at: "2026-10-01T00:00:00Z", closed_at: null, ...extra,
});
const closedRow = (employee_id: string, id: string, completion_date: string, extra: Partial<AssignmentRow> = {}) =>
  row(employee_id, id, { status: "closed", completion_date, closed_at: `${completion_date}T10:00:00Z`, start_date: "2026-01-01", ...extra });

const OPEN_ID = "00000000-0000-4000-8000-0000000000a1";
const CLOSED_ID = "00000000-0000-4000-8000-0000000000c1";

function world() {
  return {
    employees: [
      { employee_id: "BS-1001", department_id: DEPT }, { employee_id: "BS-1002", department_id: DEPT },
      { employee_id: "BS-1003", department_id: OTHER_DEPT }, { employee_id: "BS-1004", department_id: null },
    ],
    assignments: [
      closedRow("BS-1001", "00000000-0000-4000-8000-0000000000c0", "2026-03-31"),
      row("BS-1001", OPEN_ID),
      closedRow("BS-1001", CLOSED_ID, "2026-08-31"),
      row("BS-1003", "00000000-0000-4000-8000-0000000000b1"),
    ],
  };
}

const admin = { role: "admin" } as const;
const manager = { role: "manager", employeeId: "BS-1009", userId: "u-mgr" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;

/** An injected manager scope: the in-scope employees, recording each call. */
function fakeScope(ids: string[] = ["BS-1001", "BS-1002", "BS-1004"], fail = false) {
  const calls: SessionIdentity[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw new ManagerScopeUnavailableError({ cause: "connection refused" });
      return { departmentIds: new Set([DEPT]), employeeIds: new Set(ids) };
    },
  };
  return { scope, calls };
}

const storeFor = (db: ReturnType<typeof fakeDb>, scope = fakeScope().scope) => createAssignmentsStore({ userClient: async () => db.client, scope });

const input: AssignmentInput = { client: "  Northwind (fictional) ", projectName: "Portal rebuild", role: "Developer", allocation: 60, startDate: "2026-10-01" };

describe("assignments-store reads", () => {
  it("gives an admin every assignment, the open one first, then closed by completion date, newest first", async () => {
    const db = fakeDb(world());
    const list = await storeFor(db).listFor(admin, "BS-1001");
    expect(list.map(a => [a.id, a.status, a.completionDate])).toEqual([
      [OPEN_ID, "open", null], [CLOSED_ID, "closed", "2026-08-31"], ["00000000-0000-4000-8000-0000000000c0", "closed", "2026-03-31"],
    ]);
    expect((await storeFor(fakeDb(world())).listFor(admin)).map(a => a.employeeId).sort()).toEqual(["BS-1001", "BS-1001", "BS-1001", "BS-1003"]);
  });

  it("maps the row to the camel-cased Assignment", () => {
    expect(toAssignment(row("BS-1001", OPEN_ID, { latest_update: "Note" }))).toEqual({
      id: OPEN_ID, employeeId: "BS-1001", departmentId: DEPT, client: "Client", projectName: `Project ${OPEN_ID}`, role: "Engineer",
      allocation: 80, startDate: "2026-09-14", latestUpdate: "Note", status: "open", completionDate: null,
      createdAt: "2026-10-01T00:00:00Z", closedAt: null,
    });
  });

  it("orders open before closed whatever the dates", () => {
    const open = toAssignment(row("BS-1", "b"));
    const closed = toAssignment(closedRow("BS-1", "a", "2027-01-01"));
    expect([closed, open].sort(compareAssignments).map(a => a.id)).toEqual(["b", "a"]);
  });

  it("orders closed assignments with the same completion date newest-created first", () => {
    const older = { ...toAssignment(closedRow("BS-1", "a", "2026-08-31")), createdAt: "2026-01-01T00:00:00Z" };
    const newer = { ...toAssignment(closedRow("BS-1", "z", "2026-08-31")), createdAt: "2026-05-01T00:00:00Z" };
    expect([older, newer].sort(compareAssignments).map(a => a.id)).toEqual(["z", "a"]);
  });

  it("gives Staff only their own assignments; anyone else's is [] without a query", async () => {
    const db = fakeDb(world());
    const store = storeFor(db);
    expect((await store.listFor(staff)).every(a => a.employeeId === "BS-1001")).toBe(true);
    expect(await store.listFor(staff)).toHaveLength(3);
    const before = db.calls.length;
    expect(await store.listFor(staff, "BS-1003")).toEqual([]);
    expect(db.calls.length).toBe(before);
  });

  it("gives a manager only in-scope employees' assignments; an out-of-scope id is [] without a query", async () => {
    const db = fakeDb(world());
    const store = storeFor(db);
    expect((await store.listFor(manager)).map(a => a.employeeId)).toEqual(["BS-1001", "BS-1001", "BS-1001"]);
    const before = db.reads("assignments").length;
    expect(await store.listFor(manager, "BS-1003")).toEqual([]);
    expect(db.reads("assignments").length).toBe(before);
    expect(await storeFor(fakeDb(world()), fakeScope([]).scope).listFor(manager)).toEqual([]);
  });

  it("throws AssignmentsUnavailableError (never a partial list) when a read or the scope fails", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "select", error: { code: "PGRST205", message: "missing" } }])).listFor(admin))
      .rejects.toBeInstanceOf(AssignmentsUnavailableError);
    await expect(storeFor(fakeDb(world()), fakeScope([], true).scope).listFor(manager)).rejects.toBeInstanceOf(AssignmentsUnavailableError);
    await expect(createAssignmentsStore({ userClient: async () => { throw new Error("not configured"); } }).listFor(admin))
      .rejects.toBeInstanceOf(AssignmentsUnavailableError);
  });
});

describe("assignments-store create", () => {
  it("lets the Administrator create an open assignment under the employee's department, values trimmed", async () => {
    const state = world();
    const db = fakeDb(state);
    const created = await storeFor(db).create(admin, "BS-1002", input);
    expect(created).toMatchObject({ employeeId: "BS-1002", departmentId: DEPT, client: "Northwind (fictional)", status: "open", completionDate: null, latestUpdate: "" });
    const insert = db.writes().find(c => c.method === "insert")!.args[0] as Record<string, unknown>;
    expect(insert).toEqual({
      employee_id: "BS-1002", department_id: DEPT, client: "Northwind (fictional)", project_name: "Portal rebuild", role: "Developer",
      allocation: 60, start_date: "2026-10-01", latest_update: "",
    });
    // The store never writes status or completion_date on create.
    expect(insert).not.toHaveProperty("status");
    expect(insert).not.toHaveProperty("completion_date");
  });

  it("lets a manager create for an in-scope employee", async () => {
    const created = await storeFor(fakeDb(world())).create(manager, "BS-1002", input);
    expect(created.departmentId).toBe(DEPT);
  });

  it("never takes a caller-chosen department (extra fields are ignored)", async () => {
    const db = fakeDb(world());
    await storeFor(db).create(admin, "BS-1002", { ...input, departmentId: OTHER_DEPT } as AssignmentInput);
    expect((db.writes()[0].args[0] as Record<string, unknown>).department_id).toBe(DEPT);
  });

  it("refuses Staff and out-of-scope managers before anything is read or written", async () => {
    for (const [session, id] of [[staff, "BS-1001"], [manager, "BS-1003"]] as const) {
      const db = fakeDb(world());
      await expect(storeFor(db).create(session, id, input)).rejects.toBeInstanceOf(AssignmentsForbiddenError);
      expect(db.calls).toHaveLength(0);
    }
  });

  it("refuses a second open assignment, writing nothing", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).create(admin, "BS-1001", input).catch(e => e);
    expect(error).toBeInstanceOf(AssignmentAlreadyOpenError);
    expect(error.message).toBe("This employee already has an open assignment. Close it first.");
    expect(db.writes()).toEqual([]);
  });

  it("maps the database's one-open index (23505) to AssignmentAlreadyOpenError (a race past the pre-check)", async () => {
    const db = fakeDb(world(), [{ method: "insert", error: { code: "23505", message: "duplicate key value violates unique constraint" } }]);
    await expect(storeFor(db).create(admin, "BS-1002", input)).rejects.toBeInstanceOf(AssignmentAlreadyOpenError);
  });

  it("maps an RLS refusal (42501) to forbidden and a trigger refusal (23514) to invalid; other errors are unavailable", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "42501", message: "row-level security" } }])).create(manager, "BS-1002", input))
      .rejects.toBeInstanceOf(AssignmentsForbiddenError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "23514", message: "check" } }])).create(admin, "BS-1002", input))
      .rejects.toBeInstanceOf(AssignmentInvalidError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "08006", message: "connection" } }])).create(admin, "BS-1002", input))
      .rejects.toBeInstanceOf(AssignmentsUnavailableError);
  });

  it("refuses an employee without a department, and an unknown employee", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).create(admin, "BS-1004", input).catch(e => e);
    expect(error).toBeInstanceOf(AssignmentNoDepartmentError);
    expect(error.message).toBe("Place this employee in a department first.");
    await expect(storeFor(db).create(manager, "BS-1004", input)).rejects.toBeInstanceOf(AssignmentNoDepartmentError);
    await expect(storeFor(db).create(admin, "BS-9999", input)).rejects.toBeInstanceOf(AssignmentEmployeeNotFoundError);
    expect(db.writes()).toEqual([]);
  });

  it("validates the values at the store", async () => {
    const store = storeFor(fakeDb(world()));
    for (const bad of [
      { client: "  " }, { projectName: "" }, { role: "x".repeat(201) }, { allocation: 101 }, { allocation: -1 }, { allocation: 12.5 },
      { startDate: "2026-02-30" }, { startDate: "14 Sep 2026" },
    ]) await expect(store.create(admin, "BS-1002", { ...input, ...bad })).rejects.toBeInstanceOf(AssignmentInvalidError);
    await expect(store.create(admin, "BS-1002", { ...input, allocation: 0 })).resolves.toMatchObject({ allocation: 0 });
  });

  it("maps a scope that cannot be read to unavailable", async () => {
    await expect(storeFor(fakeDb(world()), fakeScope([], true).scope).create(manager, "BS-1002", input)).rejects.toBeInstanceOf(AssignmentsUnavailableError);
  });
});

describe("assignments-store updateNote", () => {
  it("saves the note of an open assignment (trimmed), and only the note", async () => {
    const db = fakeDb(world());
    const saved = await storeFor(db).updateNote(manager, OPEN_ID, "  Demo delivered.  ");
    expect(saved.latestUpdate).toBe("Demo delivered.");
    expect(db.writes().map(c => c.args[0])).toEqual([{ latest_update: "Demo delivered." }]);
  });

  it("authorizes against the target row's employee, never the caller's choice", async () => {
    const db = fakeDb(world());
    // BS-1003's assignment is outside the manager's scope.
    await expect(storeFor(db).updateNote(manager, "00000000-0000-4000-8000-0000000000b1", "x")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
    expect(db.writes()).toEqual([]);
    await expect(storeFor(db).updateNote(admin, "00000000-0000-4000-8000-0000000000b1", "x")).resolves.toMatchObject({ latestUpdate: "x" });
  });

  it("refuses Staff without a query, and a row the session cannot see as forbidden", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).updateNote(staff, OPEN_ID, "x")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
    expect(db.calls).toHaveLength(0);
    await expect(storeFor(db).updateNote(admin, "00000000-0000-4000-8000-00000000ffff", "x")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
  });

  it("refuses a closed assignment", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).updateNote(admin, CLOSED_ID, "x").catch(e => e);
    expect(error).toBeInstanceOf(AssignmentClosedError);
    expect(error.message).toBe("This assignment is closed and can't be changed.");
    expect(db.writes()).toEqual([]);
  });

  it("refuses a note over 2000 characters", async () => {
    await expect(storeFor(fakeDb(world())).updateNote(admin, OPEN_ID, "x".repeat(2001))).rejects.toBeInstanceOf(AssignmentInvalidError);
  });

  it("reports closed when the row was closed between the read and the write", async () => {
    const state = world();
    const db = fakeDb(state);
    const store = storeFor(db);
    // Close it as soon as the update is issued (the eq status=open filter then matches nothing).
    const original = db.client.from.bind(db.client);
    (db.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = original(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const update = b.update;
      b.update = (...args: unknown[]) => { state.assignments.find(r => r.id === OPEN_ID)!.status = "closed"; return update(...args); };
      return b;
    };
    await expect(store.updateNote(admin, OPEN_ID, "x")).rejects.toBeInstanceOf(AssignmentClosedError);
  });

  it("maps a trigger refusal (locked field, 23514) to AssignmentInvalidError", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "update", error: { code: "23514", message: "locked" } }])).updateNote(admin, OPEN_ID, "x"))
      .rejects.toBeInstanceOf(AssignmentInvalidError);
  });
});

describe("assignments-store close", () => {
  it("closes an open assignment with a completion date on or after the start date", async () => {
    const db = fakeDb(world());
    const closed = await storeFor(db).close(manager, OPEN_ID, "2026-09-14");
    expect(closed).toMatchObject({ status: "closed", completionDate: "2026-09-14" });
    expect(db.writes().map(c => c.args[0])).toEqual([{ status: "closed", completion_date: "2026-09-14" }]);
    // Then it is listed in history, and nothing is open.
    const list = await storeFor(db).listFor(admin, "BS-1001");
    expect(list.every(a => a.status === "closed")).toBe(true);
    expect(list[0].id).toBe(OPEN_ID);
  });

  it("refuses a completion date before the start date, or an invalid one, writing nothing", async () => {
    const db = fakeDb(world());
    const early = await storeFor(db).close(admin, OPEN_ID, "2026-09-13").catch(e => e);
    expect(early).toBeInstanceOf(AssignmentInvalidError);
    expect(early.message).toBe("The completion date can't be before the start date.");
    for (const bad of ["2026-02-30", "", "13/09/2026"]) await expect(storeFor(db).close(admin, OPEN_ID, bad)).rejects.toBeInstanceOf(AssignmentInvalidError);
    expect(db.writes()).toEqual([]);
  });

  it("refuses an already closed assignment (no reopen, no second close)", async () => {
    await expect(storeFor(fakeDb(world())).close(admin, CLOSED_ID, "2026-12-01")).rejects.toBeInstanceOf(AssignmentClosedError);
  });

  it("refuses Staff and an out-of-scope manager", async () => {
    await expect(storeFor(fakeDb(world())).close(staff, OPEN_ID, "2026-10-01")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
    await expect(storeFor(fakeDb(world())).close(manager, "00000000-0000-4000-8000-0000000000b1", "2026-10-01")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
  });

  it("has no delete method", () => {
    expect("delete" in storeFor(fakeDb(world()))).toBe(false);
    expect("remove" in storeFor(fakeDb(world()))).toBe(false);
  });
});
