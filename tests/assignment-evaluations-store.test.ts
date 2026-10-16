import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createAssignmentEvaluationsStore, EvaluationAssignmentOpenError, EvaluationExistsError, EvaluationForbiddenError, EvaluationInvalidError,
  EvaluationNotFoundError, EvaluationsUnavailableError, toAssignmentEvaluation, validateEvaluationInput,
  type AssignmentEvaluationRow, type EvaluationInput,
} from "@/server/assignment-evaluations-store";
import type { AssignmentRow } from "@/server/assignments-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import type { SessionIdentity } from "@/server/session";

const DEPT = "d0000000-0000-4000-8000-000000000001";
const OTHER_DEPT = "d0000000-0000-4000-8000-000000000002";
const CLOSED_ID = "00000000-0000-4000-8000-0000000000c1";
const EVALUATED_ID = "00000000-0000-4000-8000-0000000000c2";
const OPEN_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_DEPT_CLOSED = "00000000-0000-4000-8000-0000000000c3";
/** A closed assignment run under DEPT for an employee who has since moved to OTHER_DEPT (Story 4.8). */
const TRANSFERRED_CLOSED = "00000000-0000-4000-8000-0000000000c4";

type Call = { table: string; method: string; args: unknown[] };
type Failure = { table?: string; method: string; error: { code?: string; message: string } };
type State = {
  assignments: AssignmentRow[]; evaluations: AssignmentEvaluationRow[]; uid: string;
  /** The writer's snapshot the trigger records (the employees name linked to the JWT, and its role). */
  name: string | null; role: "admin" | "manager";
};

/**
 * Minimal in-memory stand-in for the supabase-js query builder over `assignments` (read) and
 * `assignment_evaluations`. Inserts behave like the guard trigger (employee and department copied from
 * the assignment, authors from the "JWT" `uid`); updates set authored_by and updated_at. Records every
 * call; `fail` makes the first matching operation return an error.
 */
function fakeDb(state: State, fail: Failure[] = []) {
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
        const rows = (table === "assignments" ? state.assignments : state.evaluations) as unknown as Record<string, unknown>[];
        if (op === "insert") {
          const input = query.find(c => c.method === "insert")!.args[0] as Record<string, unknown>;
          const assignment = state.assignments.find(a => a.id === input.assignment_id)!;
          const at = `2026-10-16T00:00:0${++seq}Z`;
          const row: AssignmentEvaluationRow = {
            id: `e0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, client_feedback: "", ...(input as object),
            employee_id: assignment.employee_id, department_id: assignment.department_id,
            created_by: state.uid, authored_by: state.uid, created_at: at, updated_at: at,
            created_by_name: state.name, created_by_role: state.role, authored_by_name: state.name, authored_by_role: state.role,
          } as AssignmentEvaluationRow;
          state.evaluations.push(row);
          return { data: [row], error: null };
        }
        if (op === "update") {
          const changes = query.find(c => c.method === "update")!.args[0] as Record<string, unknown>;
          const hit = rows.filter(matches);
          for (const row of hit) Object.assign(row, changes, {
            authored_by: state.uid, authored_by_name: state.name, authored_by_role: state.role, updated_at: "2026-10-17T00:00:00Z",
          });
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
        limit: (...args: unknown[]) => record("limit", args),
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
  return { client: client as unknown as SupabaseClient, calls, writes };
}

const assignment = (id: string, employee_id: string, extra: Partial<AssignmentRow> = {}): AssignmentRow => ({
  id, employee_id, department_id: DEPT, client: "Client", project_name: `Project ${id}`, role: "Engineer", allocation: 80,
  start_date: "2026-01-01", latest_update: "", status: "closed", completion_date: "2026-08-31", created_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-08-31T10:00:00Z", ...extra,
});
const evaluationRow = (id: string, assignment_id: string, employee_id: string, extra: Partial<AssignmentEvaluationRow> = {}): AssignmentEvaluationRow => ({
  id, assignment_id, employee_id, department_id: DEPT, evaluation: "Solid delivery.", client_feedback: "", created_by: "u-first",
  created_by_name: "First Writer", created_by_role: "manager", created_at: "2026-09-01T00:00:00Z", authored_by: "u-first",
  authored_by_name: "First Writer", authored_by_role: "manager", updated_at: "2026-09-01T00:00:00Z", ...extra,
});

function world(uid = "u-writer", name: string | null = null, role: "admin" | "manager" = "manager"): State {
  return {
    uid, name, role,
    assignments: [
      assignment(CLOSED_ID, "BS-1001"),
      assignment(EVALUATED_ID, "BS-1001"),
      assignment(OPEN_ID, "BS-1001", { status: "open", completion_date: null, closed_at: null }),
      assignment(OTHER_DEPT_CLOSED, "BS-1003", { department_id: OTHER_DEPT }),
      assignment(TRANSFERRED_CLOSED, "BS-1005"),
    ],
    evaluations: [
      evaluationRow("e-1", EVALUATED_ID, "BS-1001"),
      evaluationRow("e-3", OTHER_DEPT_CLOSED, "BS-1003", { department_id: OTHER_DEPT }),
      evaluationRow("e-5", TRANSFERRED_CLOSED, "BS-1005"),
    ],
  };
}

const admin = { role: "admin" } as const;
const manager = { role: "manager", employeeId: "BS-1009", userId: "u-mgr" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;

/** An injected manager scope: DEPT and the in-scope employees (BS-1005 has moved out of DEPT), recording each call. */
function fakeScope(departments: string[] = [DEPT], employees: string[] = ["BS-1001", "BS-1002"], fail = false) {
  const calls: SessionIdentity[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw new ManagerScopeUnavailableError({ cause: "connection refused" });
      return { departmentIds: new Set(departments), employeeIds: new Set(employees) };
    },
  };
  return { scope, calls };
}

const storeFor = (db: ReturnType<typeof fakeDb>, scope = fakeScope().scope) =>
  createAssignmentEvaluationsStore({ userClient: async () => db.client, scope });

const input: EvaluationInput = { evaluation: "  Delivered the migration on time.  ", clientFeedback: "  Client was happy with the service. " };

describe("assignment-evaluations-store reads", () => {
  it("gives an admin every evaluation, or one employee's", async () => {
    expect((await storeFor(fakeDb(world())).listFor(admin)).map(e => e.id).sort()).toEqual(["e-1", "e-3", "e-5"]);
    expect((await storeFor(fakeDb(world())).listFor(admin, "BS-1003")).map(e => e.id)).toEqual(["e-3"]);
  });

  it("maps the row to the camel-cased AssignmentEvaluation", () => {
    expect(toAssignmentEvaluation(evaluationRow("e-1", EVALUATED_ID, "BS-1001", { client_feedback: "Good." }))).toEqual({
      id: "e-1", assignmentId: EVALUATED_ID, employeeId: "BS-1001", departmentId: DEPT, evaluation: "Solid delivery.", clientFeedback: "Good.",
      createdBy: "u-first", createdByName: "First Writer", createdByRole: "manager", createdAt: "2026-09-01T00:00:00Z",
      authoredBy: "u-first", authoredByName: "First Writer", authoredByRole: "manager", updatedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("gives Staff only their own evaluations; anyone else's is [] without a query", async () => {
    const db = fakeDb(world());
    const store = storeFor(db);
    expect((await store.listFor(staff)).map(e => e.id)).toEqual(["e-1"]);
    const before = db.calls.length;
    expect(await store.listFor(staff, "BS-1003")).toEqual([]);
    expect(db.calls.length).toBe(before);
  });

  it("gives a manager rows whose assignment's department, or whose employee, is in scope", async () => {
    // BS-1005 has left DEPT, but the work was done under DEPT: still visible. BS-1003's (OTHER_DEPT) is not.
    expect((await storeFor(fakeDb(world())).listFor(manager)).map(e => e.id).sort()).toEqual(["e-1", "e-5"]);
    // In scope by employee only (the employee's current manager reads their history, PRD FR-9).
    const byEmployee = fakeScope([], ["BS-1003"]).scope;
    expect((await storeFor(fakeDb(world()), byEmployee).listFor(manager)).map(e => e.id)).toEqual(["e-3"]);
    expect((await storeFor(fakeDb(world())).listFor(manager, "BS-1005")).map(e => e.id)).toEqual(["e-5"]);
    expect(await storeFor(fakeDb(world())).listFor(manager, "BS-1003")).toEqual([]);
    expect(await storeFor(fakeDb(world()), fakeScope([], []).scope).listFor(manager)).toEqual([]);
  });

  it("throws EvaluationsUnavailableError (never a partial list) when a read or the scope fails", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "select", error: { code: "PGRST205", message: "missing" } }])).listFor(admin))
      .rejects.toBeInstanceOf(EvaluationsUnavailableError);
    await expect(storeFor(fakeDb(world()), fakeScope([], [], true).scope).listFor(manager)).rejects.toBeInstanceOf(EvaluationsUnavailableError);
    await expect(createAssignmentEvaluationsStore({ userClient: async () => { throw new Error("not configured"); } }).listFor(admin))
      .rejects.toBeInstanceOf(EvaluationsUnavailableError);
  });
});

describe("assignment-evaluations-store create", () => {
  it("saves the Administrator's evaluation, texts trimmed, authored by the JWT's user, with subject and department from the assignment", async () => {
    const state = world("u-admin", null, "admin");
    const db = fakeDb(state);
    const saved = await storeFor(db).create(admin, CLOSED_ID, input);
    expect(saved).toMatchObject({
      assignmentId: CLOSED_ID, employeeId: "BS-1001", departmentId: DEPT, evaluation: "Delivered the migration on time.",
      clientFeedback: "Client was happy with the service.", createdBy: "u-admin", authoredBy: "u-admin",
      createdByName: null, createdByRole: "admin", authoredByName: null, authoredByRole: "admin",
    });
    expect(saved.createdAt).toBe(saved.updatedAt);
    const insert = db.writes().find(c => c.method === "insert")!.args[0] as Record<string, unknown>;
    // The author is never sent: the trigger takes it from the JWT.
    expect(insert).not.toHaveProperty("created_by");
    expect(insert).not.toHaveProperty("created_by_name");
    expect(insert).not.toHaveProperty("created_by_role");
    expect(insert).not.toHaveProperty("authored_by");
    expect(insert).toMatchObject({ assignment_id: CLOSED_ID, employee_id: "BS-1001", department_id: DEPT });
  });

  it("lets a manager over the assignment's department write it, even after the employee moved away", async () => {
    const saved = await storeFor(fakeDb(world("u-mgr"))).create(manager, CLOSED_ID, input);
    expect(saved).toMatchObject({ createdBy: "u-mgr", authoredBy: "u-mgr" });
    const state = world("u-mgr");
    state.evaluations = state.evaluations.filter(e => e.assignment_id !== TRANSFERRED_CLOSED);
    await expect(storeFor(fakeDb(state)).create(manager, TRANSFERRED_CLOSED, input)).resolves.toMatchObject({ employeeId: "BS-1005", departmentId: DEPT });
  });

  it("refuses an out-of-scope manager (the assignment's department, not the employee, decides)", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).create(manager, OTHER_DEPT_CLOSED, input).catch(e => e);
    expect(error).toBeInstanceOf(EvaluationForbiddenError);
    expect(error.message).toBe("Only the Administrator or a manager over this assignment's department can evaluate it.");
    // In scope by employee only is not enough to write.
    const byEmployee = fakeScope([], ["BS-1003"]).scope;
    await expect(storeFor(fakeDb(world()), byEmployee).create(manager, OTHER_DEPT_CLOSED, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    expect(db.writes()).toEqual([]);
  });

  it("refuses a manager, or an employee-linked Administrator, on their own assignment, writing nothing (Story 4.10)", async () => {
    const ownManager = { ...manager, employeeId: "BS-1001" } as const;
    // An Administrator account linked to an employee (Story 4.10 identity shape).
    const ownAdmin = { role: "admin", employeeId: "BS-1001" } as unknown as SessionIdentity;
    for (const session of [ownManager, ownAdmin]) {
      const db = fakeDb(world());
      const error = await storeFor(db).create(session, CLOSED_ID, input).catch(e => e);
      expect(error).toBeInstanceOf(EvaluationForbiddenError);
      await expect(storeFor(db).amend(session, EVALUATED_ID, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
      expect(db.writes()).toEqual([]);
    }
    // Someone else's assignment in scope is still allowed.
    const state = world();
    state.assignments.push(assignment("00000000-0000-4000-8000-0000000000c9", "BS-1002"));
    await expect(storeFor(fakeDb(state)).create(ownManager, "00000000-0000-4000-8000-0000000000c9", input)).resolves.toMatchObject({ employeeId: "BS-1002" });
  });

  it("refuses Staff, own assignment included, before anything is read or written", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).create(staff, CLOSED_ID, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    await expect(storeFor(db).amend(staff, EVALUATED_ID, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    expect(db.calls).toHaveLength(0);
  });

  it("refuses an assignment that is missing or invisible", async () => {
    const db = fakeDb(world());
    await expect(storeFor(db).create(admin, "00000000-0000-4000-8000-00000000ffff", input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    expect(db.writes()).toEqual([]);
  });

  it("refuses an open assignment and leaves it open (never writes assignments)", async () => {
    const state = world();
    const db = fakeDb(state);
    const error = await storeFor(db).create(admin, OPEN_ID, input).catch(e => e);
    expect(error).toBeInstanceOf(EvaluationAssignmentOpenError);
    expect(error.message).toBe("Close the assignment before evaluating it.");
    expect(db.writes()).toEqual([]);
    expect(state.assignments.find(a => a.id === OPEN_ID)?.status).toBe("open");
  });

  it("refuses a second evaluation at the store, writing nothing", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).create(admin, EVALUATED_ID, input).catch(e => e);
    expect(error).toBeInstanceOf(EvaluationExistsError);
    expect(error.message).toBe("This assignment already has an evaluation. Amend it instead.");
    expect(db.writes()).toEqual([]);
  });

  it("maps the database's unique index (23505) to EvaluationExistsError (a race past the pre-check)", async () => {
    const db = fakeDb(world(), [{ method: "insert", error: { code: "23505", message: "duplicate key value violates unique constraint" } }]);
    await expect(storeFor(db).create(admin, CLOSED_ID, input)).rejects.toBeInstanceOf(EvaluationExistsError);
  });

  it("maps RLS (42501) to forbidden, the trigger (23514) to invalid, anything else to unavailable", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "42501", message: "row-level security" } }])).create(manager, CLOSED_ID, input))
      .rejects.toBeInstanceOf(EvaluationForbiddenError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "23514", message: "not closed" } }])).create(admin, CLOSED_ID, input))
      .rejects.toBeInstanceOf(EvaluationInvalidError);
    await expect(storeFor(fakeDb(world(), [{ method: "insert", error: { code: "08006", message: "connection" } }])).create(admin, CLOSED_ID, input))
      .rejects.toBeInstanceOf(EvaluationsUnavailableError);
    await expect(storeFor(fakeDb(world(), [{ table: "assignments", method: "select", error: { code: "08006", message: "connection" } }])).create(admin, CLOSED_ID, input))
      .rejects.toBeInstanceOf(EvaluationsUnavailableError);
  });

  it("validates the texts: evaluation 1–4000 characters, client feedback up to 2000", async () => {
    const store = storeFor(fakeDb(world()));
    for (const bad of [{ evaluation: "   " }, { evaluation: "x".repeat(4001) }, { clientFeedback: "x".repeat(2001) }]) {
      await expect(store.create(admin, CLOSED_ID, { ...input, ...bad })).rejects.toBeInstanceOf(EvaluationInvalidError);
    }
    expect(validateEvaluationInput({ evaluation: "x".repeat(4000), clientFeedback: "" })).toEqual({ evaluation: "x".repeat(4000), clientFeedback: "" });
    expect(validateEvaluationInput({ evaluation: "ok", clientFeedback: ` ${"y".repeat(2000)} ` }).clientFeedback).toHaveLength(2000);
    expect(() => validateEvaluationInput({ evaluation: "" , clientFeedback: "" })).toThrow("Enter the evaluation (1 to 4000 characters).");
    expect(() => validateEvaluationInput({ evaluation: "ok", clientFeedback: "y".repeat(2001) })).toThrow("Keep the client feedback to 2000 characters or fewer.");
  });

  it("maps a scope that cannot be read to unavailable", async () => {
    await expect(storeFor(fakeDb(world()), fakeScope([], [], true).scope).create(manager, CLOSED_ID, input)).rejects.toBeInstanceOf(EvaluationsUnavailableError);
  });
});

describe("assignment-evaluations-store amend", () => {
  it("lets another authorized account amend: texts updated, authored_by/updated_at the amender, created_by kept", async () => {
    const state = world("u-other-mgr", "Other Manager", "manager");
    const db = fakeDb(state);
    const saved = await storeFor(db).amend({ ...manager, userId: "u-other-mgr" }, EVALUATED_ID, { evaluation: "Revised.", clientFeedback: "" });
    expect(saved).toMatchObject({ evaluation: "Revised.", clientFeedback: "", createdBy: "u-first", authoredBy: "u-other-mgr", updatedAt: "2026-10-17T00:00:00Z" });
    // The snapshot: the first writer's name/role kept, the amender's recorded.
    expect(saved).toMatchObject({ createdByName: "First Writer", createdByRole: "manager", authoredByName: "Other Manager", authoredByRole: "manager" });
    expect(saved.createdAt).toBe("2026-09-01T00:00:00Z");
    // Only the texts are sent (feedback may be cleared on amend).
    expect(db.writes().map(c => [c.table, c.method, c.args[0]])).toEqual([["assignment_evaluations", "update", { evaluation: "Revised.", client_feedback: "" }]]);
  });

  it("refuses an amendment when there is no evaluation yet", async () => {
    const db = fakeDb(world());
    const error = await storeFor(db).amend(admin, CLOSED_ID, input).catch(e => e);
    expect(error).toBeInstanceOf(EvaluationNotFoundError);
    expect(error.message).toBe("Write the evaluation first.");
    expect(db.writes()).toEqual([]);
  });

  it("refuses an out-of-scope manager, a missing assignment and an invalid text", async () => {
    await expect(storeFor(fakeDb(world())).amend(manager, OTHER_DEPT_CLOSED, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    await expect(storeFor(fakeDb(world())).amend(admin, "00000000-0000-4000-8000-00000000ffff", input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
    await expect(storeFor(fakeDb(world())).amend(admin, EVALUATED_ID, { evaluation: "", clientFeedback: "" })).rejects.toBeInstanceOf(EvaluationInvalidError);
  });

  it("maps a trigger refusal (locked field, 23514) to EvaluationInvalidError, and a 0-row update (RLS) to forbidden", async () => {
    await expect(storeFor(fakeDb(world(), [{ method: "update", error: { code: "23514", message: "locked" } }])).amend(admin, EVALUATED_ID, input))
      .rejects.toBeInstanceOf(EvaluationInvalidError);
    const state = world();
    const db = fakeDb(state);
    const original = db.client.from.bind(db.client);
    (db.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = original(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const update = b.update;
      // RLS hides the row from the update: it matches nothing.
      b.update = (...args: unknown[]) => { const r = update(...args) as Record<string, (...a: unknown[]) => unknown>; r.eq("assignment_id", "nothing"); return r; };
      return b;
    };
    await expect(storeFor(db).amend(admin, EVALUATED_ID, input)).rejects.toBeInstanceOf(EvaluationForbiddenError);
  });

  it("never writes the assignments table and has no delete", async () => {
    const db = fakeDb(world());
    const store = storeFor(db);
    await store.create(admin, CLOSED_ID, input);
    await store.amend(admin, CLOSED_ID, { evaluation: "Second thoughts.", clientFeedback: "" });
    await store.create(admin, OPEN_ID, input).catch(() => {});
    expect(db.writes().every(c => c.table === "assignment_evaluations")).toBe(true);
    expect(db.writes().some(c => c.method === "delete")).toBe(false);
    expect("delete" in store).toBe(false);
    expect("remove" in store).toBe(false);
  });
});
