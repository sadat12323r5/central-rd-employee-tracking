import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture, type LeaveRecord } from "@/data/employees";
import { LeaveUnavailableError, type LeaveStore } from "@/server/leave-store";
import {
  createEmployeesStore, EmployeeExistsError, EmployeeForbiddenError, EmployeeNotFoundError, EmployeesUnavailableError, EmployeeValidationError,
  TransferDepartmentError, TransferForbiddenError, TransferInvalidError, TransferNotFoundError, TransferOpenAssignmentError,
  TransferSameDepartmentError, type EmployeeRow,
} from "@/server/employees-store";
import { todayInDhaka, type EmployeeDetailsInput, type NewEmployeeInput } from "@/domain/employee-input";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import { many, pagedClient } from "./support/paged-client";
import { InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";
import { TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "@/server/training-store";
import { AssignmentsUnavailableError, type Assignment, type AssignmentsStore } from "@/server/assignments-store";
import { EvaluationsUnavailableError, type AssignmentEvaluation, type AssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import { BackfillUnavailableError, type BackfilledProject, type BackfilledProjectStore } from "@/server/backfilled-project-store";
import { AssessmentsUnavailableError, type Assessments, type AssessmentsStore } from "@/server/assessments-store";
import {
  EmploymentHistoryUnavailableError, type EmploymentHistoryEntry, type EmploymentHistoryStore,
} from "@/server/employment-history-store";

const rowFor = (id: string): EmployeeRow => {
  const e = fixture.find(x => x.id === id)!;
  return {
    employee_id: e.id, name: e.name, title: e.title, team: e.team, employment_type: e.type, email: e.email,
    joined_on: e.joined, manager: e.manager, office: e.location, status: e.status, initials: e.initials,
    avatar_color: e.color, summary: e.summary,
  };
};

type Mode = "ok" | "error" | "throw";

/** Minimal stand-in for the supabase-js query builder: applies eq filters to in-memory rows. */
function fakeClient(rows: EmployeeRow[], mode: Mode = "ok") {
  const queries: { table: string; filters: [string, string][]; columns?: string; within?: [string, string[]]; range?: [number, number] }[] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query = {
        table, filters: [] as [string, string][], columns: undefined as string | undefined,
        within: undefined as [string, string[]] | undefined, range: undefined as [number, number] | undefined,
      };
      queries.push(query);
      const result = () => {
        if (mode === "error") return { data: null, error: { message: "connection refused" } };
        const matched = rows.filter(r => query.filters.every(([col, val]) => (r as Record<string, string>)[col] === val)
          && (!query.within || query.within[1].includes((r as Record<string, string>)[query.within[0]])));
        const sorted = [...matched].sort((a, b) => a.employee_id.localeCompare(b.employee_id));
        return { data: query.range ? sorted.slice(query.range[0], query.range[1] + 1) : sorted, error: null };
      };
      const builder = {
        select: (columns: string) => { query.columns = columns; return builder; },
        eq: (col: string, val: string) => { query.filters.push([col, val]); return builder; },
        in: (col: string, vals: string[]) => { query.within = [col, vals]; return builder; },
        order: () => builder,
        range: (from: number, to: number) => { query.range = [from, to]; return builder; },
        returns: () => builder,
        maybeSingle: async () => {
          const r = result();
          return r.error ? r : { data: r.data![0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const interview = (employeeId: string, id: string, extra: Partial<ExternalInterview> = {}): ExternalInterview => ({
  id, employeeId, company: `Company ${id}`, role: "Engineer", date: "2026-10-01", stage: "Screening", outcome: "", feedback: "", withdrawn: false, ...extra,
});
const stored = [interview("BS-1001", "i-1"), interview("BS-1002", "i-2"), interview("BS-1001", "i-3")];

/** Stand-in for interviews-store: applies the same session scoping and records every call. */
function fakeInterviews(rows: ExternalInterview[] = stored, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<InterviewsStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new InterviewsUnavailableError({ cause: "connection refused" });
      const scope = session.role === "admin" ? employeeId : session.employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

/** What training-store would return for the fixture: each employee's entries, in profile order. */
const fixtureTraining: TrainingEntry[] = fixture.flatMap(e => e.training.map(t => ({ ...t, employeeId: e.id })));

/** Stand-in for training-store: applies the same session scoping and records every call. */
function fakeTraining(rows: TrainingEntry[] = fixtureTraining, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<TrainingStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new TrainingUnavailableError({ cause: "connection refused" });
      if (session.role !== "admin" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "admin" ? employeeId : session.employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

const assignment = (employeeId: string, id: string, extra: Partial<Assignment> = {}): Assignment => ({
  id, employeeId, departmentId: "dept-1", client: "Not recorded", projectName: `Project ${id}`, role: "Engineer", allocation: 80,
  startDate: "2026-09-14", latestUpdate: "", status: "open", completionDate: null, createdAt: "2026-10-14T00:00:00Z", closedAt: null,
  provenance: "assignment", ...extra,
});
const storedAssignments = [
  assignment("BS-1001", "a-1"),
  assignment("BS-1001", "a-0", { status: "closed", completionDate: "2026-08-31", closedAt: "2026-09-01T00:00:00Z" }),
  assignment("BS-1002", "a-2"),
];

/** Stand-in for assignments-store: applies the same session scoping and records every call. */
function fakeAssignments(rows: Assignment[] = storedAssignments, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<AssignmentsStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new AssignmentsUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

/** What employment-history-store would return for the fixture: each employee's entries, newest first. */
const fixtureHistory: EmploymentHistoryEntry[] = fixture.flatMap(e => e.history.map(h => ({ ...h, employeeId: e.id, createdAt: "2026-10-15T00:00:00Z" })));

/** Stand-in for employment-history-store: applies the same session scoping and records every call. */
function fakeHistory(rows: EmploymentHistoryEntry[] = fixtureHistory, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<EmploymentHistoryStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new EmploymentHistoryUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

const leaveRecord = (employeeId: string, id: string, extra: Partial<LeaveRecord> = {}): LeaveRecord => ({
  id, employeeId, startDate: "2026-03-02", endDate: "2026-03-05", workingDays: 4, category: "FOUR_TO_FOURTEEN", calendarVersionId: "cal-v3",
  cancelledAt: null, createdAt: "2026-10-17T00:00:00Z", ...extra,
});

/** Stand-in for leave-store (Story 5.2): applies the same session scoping and records every call. */
function fakeLeave(rows: LeaveRecord[] = [], fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<LeaveStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new LeaveUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

/** What assessments-store would return for the fixture's skills and evaluations (as the seed moved them). */
const fixtureAssessments: Assessments = {
  skills: fixture.flatMap(e => e.skills.map(skill => ({ employeeId: e.id, ...skill }))),
  evaluations: fixture.map(e => ({
    employeeId: e.id, strengths: e.review.strengths, developmentPriorities: e.review.next, readiness: e.review.readiness,
    reviewer: e.review.reviewer, reviewedOn: e.review.date,
  })),
};

/** Stand-in for assessments-store (Story 7.4): applies staff scoping, records every call. */
function fakeAssessments(data: Assessments = fixtureAssessments, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<AssessmentsStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new AssessmentsUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return { skills: [], evaluations: [] };
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      const keep = <T extends { employeeId: string }>(list: T[]) => list.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
      return { skills: keep(data.skills), evaluations: keep(data.evaluations) };
    },
  };
  return { store, calls };
}

const evaluation = (employeeId: string, id: string, assignmentId: string, extra: Partial<AssignmentEvaluation> = {}): AssignmentEvaluation => ({
  id, assignmentId, employeeId, departmentId: "dept-1", evaluation: `Evaluation ${id}`, clientFeedback: "",
  createdBy: "u-1", createdAt: "2026-10-16T00:00:00Z", authoredBy: "u-1", updatedAt: "2026-10-16T00:00:00Z",
  createdByName: null, createdByRole: "manager", authoredByName: null, authoredByRole: "manager", ...extra,
});
const storedEvaluations = [evaluation("BS-1001", "ev-0", "a-0"), evaluation("BS-1002", "ev-9", "a-9")];

/** Stand-in for assignment-evaluations-store: applies the same session scoping and records every call. */
function fakeEvaluations(rows: AssignmentEvaluation[] = storedEvaluations, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<AssignmentEvaluationsStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new EvaluationsUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

const backfilledProject = (employeeId: string, id: string, extra: Partial<BackfilledProject> = {}): BackfilledProject => ({
  id, employeeId, departmentId: "dept-1", departmentName: "Dept 1", client: "Old client", projectName: `Past ${id}`, completionDate: "2025-06-30",
  outcome: "Delivered.", status: "active", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", withdrawnAt: null,
  provenance: "backfilled", ...extra,
});
const storedBackfilled = [backfilledProject("BS-1001", "bp-0"), backfilledProject("BS-1002", "bp-9", { status: "withdrawn", withdrawnAt: "2026-10-16T01:00:00Z" })];

/** Stand-in for backfilled-project-store: applies the same session scoping and records every call. */
function fakeBackfilled(rows: BackfilledProject[] = storedBackfilled, fail = false) {
  const calls: [SessionIdentity, string | undefined][] = [];
  const store: Pick<BackfilledProjectStore, "listFor"> = {
    async listFor(session, employeeId) {
      calls.push([session, employeeId]);
      if (fail) throw new BackfillUnavailableError({ cause: "connection refused" });
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "staff" ? session.employeeId : employeeId;
      return rows.filter(r => scope === undefined || r.employeeId === scope).map(r => ({ ...r }));
    },
  };
  return { store, calls };
}

// Story 7.4's assessments come after the Epic 4 stores (merge of Epics 4 and 7), and Story 7.3's history is the
// last positional argument (merge of Story 7.3).
const both = (
  client: SupabaseClient, interviews = fakeInterviews().store, training = fakeTraining().store, assignments = fakeAssignments().store,
  evaluations = fakeEvaluations().store, backfilled = fakeBackfilled().store, assessments = fakeAssessments().store,
  history = fakeHistory().store, leave = fakeLeave().store,
) => ({
  userClient: async () => client, interviews, training, assignments, evaluations, backfilled, assessments, history, leave,
});
const withoutEmployee = ({ employeeId: _, ...rest }: ExternalInterview) => rest;

const seeded = ["BS-1001", "BS-1002", "BS-1003"].map(rowFor);
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1002" } as const;

describe("employees-store role scoping", () => {
  it("lists every employee for an admin", async () => {
    const { client } = fakeClient(seeded);
    const list = await createEmployeesStore(both(client)).listFor(admin);
    expect(list.map(e => e.id)).toEqual(["BS-1001", "BS-1002", "BS-1003"]);
  });

  it("lists only the session's own record for staff, filtering in the query", async () => {
    const { client, queries } = fakeClient(seeded);
    const list = await createEmployeesStore(both(client)).listFor(staff);
    expect(list.map(e => e.id)).toEqual(["BS-1002"]);
    expect(queries[0].filters).toEqual([["employee_id", "BS-1002"]]);
  });

  it("lets an admin get any employee", async () => {
    const { client } = fakeClient(seeded);
    expect((await createEmployeesStore(both(client)).getFor(admin, "BS-1003"))?.name).toBe("Meera Das");
  });

  it("lets staff get their own record but returns null for anyone else's without querying", async () => {
    const { client, queries } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    expect((await store.getFor(staff, "BS-1002"))?.id).toBe("BS-1002");
    queries.length = 0;
    expect(await store.getFor(staff, "BS-1001")).toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe("employees-store and manager sessions (Story 4.3: scoped to the department subtree)", () => {
  const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
  const DEPT = "de9a0000-0000-4000-8000-000000000002";
  const rows = (): EmployeeRow[] => [
    { ...rowFor("BS-1001"), department_id: DEPT, archived_at: null, auth_user_id: "6f1d2c1e-0000-4000-8000-000000000001" },
    { ...rowFor("BS-1002"), department_id: DEPT, archived_at: "2026-10-08T09:00:00+00:00", auth_user_id: null },
    { ...rowFor("BS-1003"), department_id: "de9a0000-0000-4000-8000-0000000000ff", archived_at: null, auth_user_id: null },
  ];

  /** A stand-in manager-scope returning the given employee ids (or failing), recording each call. */
  function fakeScope(employeeIds: string[], fail?: Error) {
    const calls: unknown[] = [];
    const scope: ManagerScope = {
      async forManager(session) {
        calls.push(session);
        if (fail) throw fail;
        return { departmentIds: new Set([DEPT]), employeeIds: new Set(employeeIds) };
      },
    };
    return { scope, calls };
  }
  const managerTraining = (rowsIn: TrainingEntry[] = [entry("BS-1001", "t-1"), entry("BS-1003", "t-3")]) => {
    const calls: [SessionIdentity, string | undefined][] = [];
    const store: Pick<TrainingStore, "listFor"> = {
      async listFor(session, employeeId) {
        calls.push([session, employeeId]);
        return rowsIn.filter(r => r.employeeId !== "BS-1003" && (employeeId === undefined || r.employeeId === employeeId));
      },
    };
    return { store, calls };
  };
  const storeWith = (client: SupabaseClient, scope: ManagerScope, interviews = fakeInterviews(), training = managerTraining(), history = fakeHistory(), leave = fakeLeave()) =>
    createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => client, interviews: interviews.store, training: training.store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: history.store, leave: leave.store, scope });

  it("attaches each in-scope employee's employment history from the history store, read as the manager", async () => {
    const { client } = fakeClient(rows());
    const history = fakeHistory();
    const store = storeWith(client, fakeScope(["BS-1001", "BS-1002"]).scope, fakeInterviews(), managerTraining(), history);
    const list = await store.listFor(manager);
    expect(list.map(e => [e.id, e.history.map(h => h.id)])).toEqual([
      ["BS-1001", fixture.find(e => e.id === "BS-1001")!.history.map(h => h.id)],
      ["BS-1002", fixture.find(e => e.id === "BS-1002")!.history.map(h => h.id)],
    ]);
    expect((await store.getFor(manager, "BS-1001"))?.history).toEqual(fixture.find(e => e.id === "BS-1001")!.history);
    expect(history.calls).toEqual([[manager, undefined], [manager, "BS-1001"]]);
  });

  it("attaches each in-scope employee's leave from the leave store, read as the manager (Story 5.2)", async () => {
    const { client } = fakeClient(rows());
    const leave = fakeLeave([leaveRecord("BS-1001", "l-1"), leaveRecord("BS-1002", "l-2")]);
    const store = storeWith(client, fakeScope(["BS-1001", "BS-1002"]).scope, fakeInterviews(), managerTraining(), fakeHistory(), leave);
    expect((await store.listFor(manager)).map(e => [e.id, e.leave.map(l => l.id)])).toEqual([["BS-1001", ["l-1"]], ["BS-1002", ["l-2"]]]);
    expect((await store.getFor(manager, "BS-1002"))?.leave.map(l => l.id)).toEqual(["l-2"]);
    expect(leave.calls).toEqual([[manager, undefined], [manager, "BS-1002"]]);
    await expect(storeWith(client, fakeScope(["BS-1001"]).scope, fakeInterviews(), managerTraining(), fakeHistory(), fakeLeave([], true)).listFor(manager))
      .rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("reports a manager's records unavailable when the history read fails", async () => {
    const { client } = fakeClient(rows());
    const store = storeWith(client, fakeScope(["BS-1001"]).scope, fakeInterviews(), managerTraining(), fakeHistory([], true));
    await expect(store.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("lists only in-scope employees, archived ones flagged, with their department and never the account link", async () => {
    const { client, queries } = fakeClient(rows());
    const list = await storeWith(client, fakeScope(["BS-1001", "BS-1002"]).scope).listFor(manager);
    expect(list.map(e => [e.id, e.archived, e.departmentId])).toEqual([["BS-1001", false, DEPT], ["BS-1002", true, DEPT]]);
    for (const e of list) expect(e).not.toHaveProperty("hasAccount");
    expect(queries[0].within).toEqual(["employee_id", ["BS-1001", "BS-1002"]]);
    expect(queries[0].columns).toContain("department_id");
    expect(queries[0].columns).toContain("archived_at");
    for (const q of queries) expect(q.columns).not.toContain("auth_user_id");
  });

  it("drops a returned row outside the scope (defence in depth)", async () => {
    const { client } = fakeClient(rows());
    const leaky = { from: (t: string) => { const b = client.from(t) as unknown as Record<string, unknown>; b.in = () => b; return b; } } as unknown as SupabaseClient;
    const list = await storeWith(leaky, fakeScope(["BS-1001"]).scope).listFor(manager);
    expect(list.map(e => e.id)).toEqual(["BS-1001"]);
  });

  it("returns an empty list, without an employees query, when nothing is in scope", async () => {
    const { client, queries } = fakeClient(rows());
    expect(await storeWith(client, fakeScope([]).scope).listFor(manager)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("never reads interviews for a manager: interviews are always empty", async () => {
    const { client } = fakeClient(rows());
    const interviews = fakeInterviews();
    const store = storeWith(client, fakeScope(["BS-1001", "BS-1002"]).scope, interviews);
    expect((await store.listFor(manager)).flatMap(e => e.interviews)).toEqual([]);
    expect((await store.getFor(manager, "BS-1001"))?.interviews).toEqual([]);
    expect(interviews.calls).toEqual([]);
  });

  it("attaches each in-scope employee's training from the training store, read as the manager", async () => {
    const { client } = fakeClient(rows());
    const training = managerTraining();
    const store = storeWith(client, fakeScope(["BS-1001", "BS-1002"]).scope, fakeInterviews(), training);
    const list = await store.listFor(manager);
    expect(list.map(e => [e.id, e.training.map(t => t.id)])).toEqual([["BS-1001", ["t-1"]], ["BS-1002", []]]);
    expect(training.calls).toEqual([[manager, undefined]]);
  });

  it("gets an in-scope profile, and null for an out-of-scope id without querying the employee", async () => {
    const { client, queries } = fakeClient(rows());
    const training = managerTraining();
    const store = storeWith(client, fakeScope(["BS-1001"]).scope, fakeInterviews(), training);
    const own = await store.getFor(manager, "BS-1001");
    expect(own).toMatchObject({ id: "BS-1001", archived: false, departmentId: DEPT });
    expect(own).not.toHaveProperty("hasAccount");
    expect(own?.training.map(t => t.id)).toEqual(["t-1"]);
    queries.length = 0;
    training.calls.length = 0;
    expect(await store.getFor(manager, "BS-1003")).toBeNull();
    // Out of scope even though it is the manager's own record: "My record" is Story 4.10.
    expect(await store.getFor(manager, "BS-1002")).toBeNull();
    expect(queries).toHaveLength(0);
    expect(training.calls).toEqual([]);
  });

  it("works the scope out fresh on every call", async () => {
    const { client } = fakeClient(rows());
    const scope = fakeScope(["BS-1001"]);
    const store = storeWith(client, scope.scope);
    await store.listFor(manager);
    await store.getFor(manager, "BS-1001");
    expect(scope.calls).toEqual([manager, manager]);
  });

  it("reports the records unavailable, never a partial list, when the scope cannot be read", async () => {
    const { client, queries } = fakeClient(rows());
    const store = storeWith(client, fakeScope([], new ManagerScopeUnavailableError()).scope);
    await expect(store.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    expect(queries).toHaveLength(0);
  });

  it("never asks the scope for Administrator or Staff reads", async () => {
    const { client } = fakeClient(seeded);
    const scope = fakeScope(["BS-1001"]);
    const store = createEmployeesStore({ ...both(client), scope: scope.scope });
    await store.listFor(admin);
    await store.getFor(admin, "BS-1001");
    await store.listFor(staff);
    await store.getFor(staff, "BS-1002");
    expect(scope.calls).toEqual([]);
  });
});

describe("employees-store data", () => {
  it("merges each row with the fixture's nested profile data by id, but interviews, training and assignments from their stores", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-1001");
    expect(employee).toEqual({
      ...fixture.find(e => e.id === "BS-1001"), hasAccount: false, archived: false, departmentId: null,
      interviews: [withoutEmployee(stored[0]), withoutEmployee(stored[2])],
      assignments: [storedAssignments[0], storedAssignments[1]],
      evaluations: [storedEvaluations[0]],
      backfilledProjects: [storedBackfilled[0]],
    });
  });

  it("passes withdrawn entries through unchanged, flagged (Story 2.2: views split active from history)", async () => {
    const { client } = fakeClient(seeded);
    const rows = [interview("BS-1001", "i-1"), interview("BS-1001", "i-w", { withdrawn: true })];
    const employee = await createEmployeesStore(both(client, fakeInterviews(rows).store)).getFor(admin, "BS-1001");
    expect(employee?.interviews.map(i => [i.id, i.withdrawn])).toEqual([["i-1", false], ["i-w", true]]);
  });

  it("never reads interviews from the fixture", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews([]).store));
    expect((await store.getFor(admin, "BS-1001"))?.interviews).toEqual([]);
    expect((await store.listFor(admin)).flatMap(e => e.interviews)).toEqual([]);
    expect(fixture.find(e => e.id === "BS-1001")!.interviews.length).toBeGreaterThan(0);
  });

  it("makes one interviews query for an admin's whole list and groups the interviews by employee", async () => {
    const { client } = fakeClient(seeded);
    const interviews = fakeInterviews();
    const list = await createEmployeesStore(both(client, interviews.store)).listFor(admin);
    expect(interviews.calls).toEqual([[admin, undefined]]);
    expect(list.map(e => [e.id, e.interviews.map(i => i.id)])).toEqual([["BS-1001", ["i-1", "i-3"]], ["BS-1002", ["i-2"]], ["BS-1003", []]]);
  });

  it("gives staff only their own interviews, on the list and on their own record", async () => {
    const { client } = fakeClient(seeded);
    const interviews = fakeInterviews();
    const store = createEmployeesStore(both(client, interviews.store));
    expect((await store.listFor(staff)).map(e => e.interviews.map(i => i.id))).toEqual([["i-2"]]);
    expect((await store.getFor(staff, "BS-1002"))?.interviews.map(i => i.id)).toEqual(["i-2"]);
    expect(interviews.calls).toEqual([[staff, undefined], [staff, "BS-1002"]]);
  });

  it("does not read interviews for an employee that does not exist or is out of scope", async () => {
    const { client } = fakeClient(seeded);
    const interviews = fakeInterviews();
    const store = createEmployeesStore(both(client, interviews.store));
    expect(await store.getFor(admin, "BS-1999")).toBeNull();
    expect(await store.getFor(staff, "BS-1001")).toBeNull();
    expect(interviews.calls).toEqual([]);
  });

  it("uses the database's basic fields over the fixture's", async () => {
    const changed = { ...rowFor("BS-1001"), title: "Software Engineer II", office: "Chattogram, Bangladesh" };
    const { client } = fakeClient([changed]);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-1001");
    expect(employee).toMatchObject({ title: "Software Engineer II", location: "Chattogram, Bangladesh" });
    expect(employee?.skills).toEqual(fixture.find(e => e.id === "BS-1001")!.skills);
  });

  it("gives an employee with no fixture entry empty nested data", async () => {
    const { client } = fakeClient([{ ...rowFor("BS-1001"), employee_id: "BS-9001", email: "new@example.com" }]);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-9001");
    expect(employee).toMatchObject({ id: "BS-9001", skills: [], interviews: [], history: [] });
  });

  it("returns null when the employee does not exist", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    expect(await store.getFor(admin, "BS-1999")).toBeNull();
    expect(await store.getFor(staff, "BS-1002")).not.toBeNull();
  });

  it("has no email lookup any more (staff sign-in goes through Supabase Auth)", () => {
    const { client } = fakeClient(seeded);
    expect("findByEmail" in createEmployeesStore(both(client))).toBe(false);
  });
});

describe("employees-store employment history (Story 7.3)", () => {
  // Merge of Story 7.3 with Epics 4 and 7.4: history is now both()'s last positional argument (after the
  // assignments, evaluations, backfilled and assessments stores), hence the four `undefined`s below.
  const historyEntry = (employeeId: string, id: string, period: string): EmploymentHistoryEntry => ({
    id, employeeId, role: `Role ${id}`, company: "Brain Station 23", period, detail: "", createdAt: "2026-10-15T00:00:00Z",
  });

  it("takes history from the history store, never from the fixture", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, fakeHistory([]).store));
    expect((await store.getFor(admin, "BS-1001"))?.history).toEqual([]);
    expect((await store.listFor(admin)).flatMap(e => e.history)).toEqual([]);
    expect(fixture.find(e => e.id === "BS-1001")!.history.length).toBeGreaterThan(0);
  });

  it("keeps the store's order and drops the store's employeeId and createdAt", async () => {
    const { client } = fakeClient(seeded);
    const rows = [historyEntry("BS-1001", "h-new", "Mar 2023 – Present"), historyEntry("BS-1001", "h-old", "2021 – 2022")];
    const employee = await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, fakeHistory(rows).store)).getFor(admin, "BS-1001");
    expect(employee?.history).toEqual([
      { id: "h-new", role: "Role h-new", company: "Brain Station 23", period: "Mar 2023 – Present", detail: "" },
      { id: "h-old", role: "Role h-old", company: "Brain Station 23", period: "2021 – 2022", detail: "" },
    ]);
  });

  it("makes one history read for an admin's whole list and groups it by employee", async () => {
    const { client } = fakeClient(seeded);
    const history = fakeHistory([historyEntry("BS-1001", "h-1", "2023"), historyEntry("BS-1002", "h-2", "2022"), historyEntry("BS-1001", "h-3", "2020")]);
    const list = await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, history.store)).listFor(admin);
    expect(history.calls).toEqual([[admin, undefined]]);
    expect(list.map(e => [e.id, e.history.map(h => h.id)])).toEqual([["BS-1001", ["h-1", "h-3"]], ["BS-1002", ["h-2"]], ["BS-1003", []]]);
  });

  it("gives staff only their own history, on the list and on their own record", async () => {
    const { client } = fakeClient(seeded);
    const history = fakeHistory([historyEntry("BS-1001", "h-1", "2023"), historyEntry("BS-1002", "h-2", "2022")]);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, history.store));
    expect((await store.listFor(staff)).map(e => e.history.map(h => h.id))).toEqual([["h-2"]]);
    expect((await store.getFor(staff, "BS-1002"))?.history.map(h => h.id)).toEqual(["h-2"]);
    expect(history.calls).toEqual([[staff, undefined], [staff, "BS-1002"]]);
  });

  it("throws EmployeesUnavailableError (never a profile with missing history) when the history read fails", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, fakeHistory([], true).store));
    for (const call of [() => store.listFor(admin), () => store.listFor(staff), () => store.getFor(admin, "BS-1001"), () => store.getFor(staff, "BS-1002")]) {
      await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
    }
  });

  it("rethrows a non-availability error from the history read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBe(bug);
  });
});

describe("employees-store leave (Story 5.2)", () => {
  // leave is both()'s last positional argument (after history).
  const withLeave = (client: SupabaseClient, leave: Pick<LeaveStore, "listFor">) =>
    createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, undefined, undefined, undefined, undefined, undefined, leave));

  it("takes leave from the leave store (the fixture has none), keeping the store's order, cancelled periods included", async () => {
    const { client } = fakeClient(seeded);
    const rows = [leaveRecord("BS-1001", "l-new", { startDate: "2026-06-01", endDate: "2026-06-02" }), leaveRecord("BS-1001", "l-old", { cancelledAt: "2026-10-10T00:00:00Z" })];
    const employee = await withLeave(client, fakeLeave(rows).store).getFor(admin, "BS-1001");
    expect(employee?.leave).toEqual(rows);
    expect(fixture.every(e => e.leave.length === 0)).toBe(true);
  });

  it("makes one leave read for an admin's whole list and groups it by employee", async () => {
    const { client } = fakeClient(seeded);
    const leave = fakeLeave([leaveRecord("BS-1001", "l-1"), leaveRecord("BS-1002", "l-2"), leaveRecord("BS-1001", "l-3")]);
    const list = await withLeave(client, leave.store).listFor(admin);
    expect(leave.calls).toEqual([[admin, undefined]]);
    expect(list.map(e => [e.id, e.leave.map(l => l.id)])).toEqual([["BS-1001", ["l-1", "l-3"]], ["BS-1002", ["l-2"]], ["BS-1003", []]]);
  });

  it("gives staff only their own leave, on the list and on their own record", async () => {
    const { client } = fakeClient(seeded);
    const leave = fakeLeave([leaveRecord("BS-1001", "l-1"), leaveRecord("BS-1002", "l-2")]);
    const store = withLeave(client, leave.store);
    expect((await store.listFor(staff)).map(e => e.leave.map(l => l.id))).toEqual([["l-2"]]);
    expect((await store.getFor(staff, "BS-1002"))?.leave.map(l => l.id)).toEqual(["l-2"]);
    expect(leave.calls).toEqual([[staff, undefined], [staff, "BS-1002"]]);
  });

  it("throws EmployeesUnavailableError (never a profile with missing leave) when the leave read fails; other errors pass through", async () => {
    const { client } = fakeClient(seeded);
    const store = withLeave(client, fakeLeave([], true).store);
    for (const call of [() => store.listFor(admin), () => store.listFor(staff), () => store.getFor(admin, "BS-1001"), () => store.getFor(staff, "BS-1002")]) {
      await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
    }
    const bug = new TypeError("bug");
    await expect(withLeave(client, { listFor: async () => { throw bug; } }).getFor(admin, "BS-1001")).rejects.toBe(bug);
  });
});

const entry = (employeeId: string, id: string, extra: Partial<TrainingEntry> = {}): TrainingEntry => ({
  id, employeeId, name: `Programme ${id}`, provider: "BS23 Learning & Development", progress: 100, date: "2026-08-20", result: "Completed", ...extra,
});

describe("employees-store skills and evaluation (Story 7.4)", () => {
  const skill = (employeeId: string, name: string, level: number) => ({ employeeId, name, level, evidence: `Evidence for ${name}` });
  const stored: Assessments = {
    skills: [skill("BS-1001", "Kotlin", 5), skill("BS-1001", "Go", 2), skill("BS-1002", "Rust", 4)],
    evaluations: [{
      employeeId: "BS-1001", strengths: "Stored strengths", developmentPriorities: "Stored priorities", readiness: "Stored readiness",
      reviewer: "Rahim Uddin · Department manager", reviewedOn: "2026-10-14",
    }],
  };
  const emptyReview = { date: "", reviewer: "", readiness: "", strengths: "", next: "" };

  it("takes skills (in the store's order) and the review from assessments-store, never from the fixture", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client, undefined, undefined, undefined, undefined, undefined, fakeAssessments(stored).store)).getFor(admin, "BS-1001");
    expect(employee?.skills).toEqual([
      { name: "Kotlin", level: 5, evidence: "Evidence for Kotlin" }, { name: "Go", level: 2, evidence: "Evidence for Go" },
    ]);
    expect(employee?.review).toEqual({
      date: "2026-10-14", reviewer: "Rahim Uddin · Department manager", readiness: "Stored readiness",
      strengths: "Stored strengths", next: "Stored priorities",
    });
    const fromFixture = fixture.find(e => e.id === "BS-1001")!;
    expect(employee?.skills).not.toEqual(fromFixture.skills);
    expect(employee?.review).not.toEqual(fromFixture.review);
  });

  it("gives an employee with nothing stored no skills and an all-empty review (no fixture fallback)", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, undefined, undefined, fakeAssessments({ skills: [], evaluations: [] }).store));
    const employee = await store.getFor(admin, "BS-1003");
    expect(employee).toMatchObject({ skills: [], review: emptyReview });
    expect((await store.listFor(admin)).every(e => e.skills.length === 0 && e.review.date === "")).toBe(true);
  });

  it("makes one assessments read for an admin's whole list and groups it by employee", async () => {
    const { client } = fakeClient(seeded);
    const assessments = fakeAssessments(stored);
    const list = await createEmployeesStore(both(client, undefined, undefined, undefined, undefined, undefined, assessments.store)).listFor(admin);
    expect(assessments.calls).toEqual([[admin, undefined]]);
    expect(list.map(e => [e.id, e.skills.map(s => s.name), e.review.readiness])).toEqual([
      ["BS-1001", ["Kotlin", "Go"], "Stored readiness"], ["BS-1002", ["Rust"], ""], ["BS-1003", [], ""],
    ]);
  });

  it("reads staff assessments as the staff session, on the list and on their own record", async () => {
    const { client } = fakeClient(seeded);
    const assessments = fakeAssessments(stored);
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, undefined, undefined, assessments.store));
    expect((await store.listFor(staff)).map(e => e.skills.map(s => s.name))).toEqual([["Rust"]]);
    expect((await store.getFor(staff, "BS-1002"))?.skills.map(s => s.name)).toEqual(["Rust"]);
    expect(assessments.calls).toEqual([[staff, undefined], [staff, "BS-1002"]]);
  });

  it("reads a manager's assessments as the manager, for the list and one in-scope profile", async () => {
    const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
    const scope: ManagerScope = { forManager: async () => ({ departmentIds: new Set(["d"]), employeeIds: new Set(["BS-1001", "BS-1002"]) }) };
    const { client } = fakeClient(seeded.map(r => ({ ...r, department_id: "d", archived_at: null })));
    const assessments = fakeAssessments(stored);
    const store = createEmployeesStore({ ...both(client, undefined, undefined, undefined, undefined, undefined, assessments.store), scope });
    expect((await store.listFor(manager)).map(e => [e.id, e.skills.length])).toEqual([["BS-1001", 2], ["BS-1002", 1]]);
    expect((await store.getFor(manager, "BS-1001"))?.review.reviewer).toBe("Rahim Uddin · Department manager");
    // Out of scope: null, without reading assessments.
    expect(await store.getFor(manager, "BS-1003")).toBeNull();
    expect(assessments.calls).toEqual([[manager, undefined], [manager, "BS-1001"]]);
  });

  it("makes the records unavailable (never a profile with missing assessments) when the assessments read fails", async () => {
    const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
    const scope: ManagerScope = { forManager: async () => ({ departmentIds: new Set(["d"]), employeeIds: new Set(["BS-1001"]) }) };
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore({ ...both(client, undefined, undefined, undefined, undefined, undefined, fakeAssessments(stored, true).store), scope });
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.listFor(staff)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(staff, "BS-1002")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("rethrows a non-availability error from the assessments read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, undefined, undefined, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBe(bug);
  });
});

describe("employees-store training (Story 3.1)", () => {
  it("takes training from the training store, never from the fixture", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining([]).store));
    expect((await store.getFor(admin, "BS-1001"))?.training).toEqual([]);
    expect((await store.listFor(admin)).flatMap(e => e.training)).toEqual([]);
    expect(fixture.find(e => e.id === "BS-1001")!.training.length).toBeGreaterThan(0);
  });

  it("keeps the store's order (completed newest first, then in progress) and drops the store's employeeId", async () => {
    const { client } = fakeClient(seeded);
    const rows = [
      entry("BS-1001", "t-new", { date: "2026-09-01" }), entry("BS-1001", "t-old", { date: "2026-03-01" }),
      entry("BS-1001", "t-prog", { progress: 60, date: "2026-12-01", result: "In progress" }),
    ];
    const employee = await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining(rows).store)).getFor(admin, "BS-1001");
    expect(employee?.training).toEqual([
      { id: "t-new", name: "Programme t-new", provider: "BS23 Learning & Development", progress: 100, date: "2026-09-01", result: "Completed" },
      { id: "t-old", name: "Programme t-old", provider: "BS23 Learning & Development", progress: 100, date: "2026-03-01", result: "Completed" },
      { id: "t-prog", name: "Programme t-prog", provider: "BS23 Learning & Development", progress: 60, date: "2026-12-01", result: "In progress" },
    ]);
  });

  it("makes one training read for an admin's whole list and groups it by employee", async () => {
    const { client } = fakeClient(seeded);
    const training = fakeTraining([entry("BS-1001", "t-1"), entry("BS-1002", "t-2"), entry("BS-1001", "t-3")]);
    const list = await createEmployeesStore(both(client, fakeInterviews().store, training.store)).listFor(admin);
    expect(training.calls).toEqual([[admin, undefined]]);
    expect(list.map(e => [e.id, e.training.map(t => t.id)])).toEqual([["BS-1001", ["t-1", "t-3"]], ["BS-1002", ["t-2"]], ["BS-1003", []]]);
  });

  it("gives staff only their own training, on the list and on their own record", async () => {
    const { client } = fakeClient(seeded);
    const training = fakeTraining([entry("BS-1001", "t-1"), entry("BS-1002", "t-2")]);
    const store = createEmployeesStore(both(client, fakeInterviews().store, training.store));
    expect((await store.listFor(staff)).map(e => e.training.map(t => t.id))).toEqual([["t-2"]]);
    expect((await store.getFor(staff, "BS-1002"))?.training.map(t => t.id)).toEqual(["t-2"]);
    expect(training.calls).toEqual([[staff, undefined], [staff, "BS-1002"]]);
  });

  it("does not read training for an employee that does not exist or is out of scope", async () => {
    const { client } = fakeClient(seeded);
    const training = fakeTraining();
    const store = createEmployeesStore(both(client, fakeInterviews().store, training.store));
    expect(await store.getFor(admin, "BS-1999")).toBeNull();
    expect(await store.getFor(staff, "BS-1001")).toBeNull();
    expect(training.calls).toEqual([]);
  });

  it("throws EmployeesUnavailableError (never a profile without training) when the training read fails", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining(fixtureTraining, true).store));
    for (const call of [() => store.listFor(admin), () => store.listFor(staff), () => store.getFor(admin, "BS-1001"), () => store.getFor(staff, "BS-1002")]) {
      await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
    }
  });

  it("rethrows a non-availability error from the training read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, fakeInterviews().store, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBe(bug);
  });
});

describe("employees-store unavailability", () => {
  const calls = (store: ReturnType<typeof createEmployeesStore>) => [
    () => store.listFor(admin), () => store.listFor(staff), () => store.getFor(admin, "BS-1001"), () => store.getFor(staff, "BS-1002"),
  ];

  it("throws EmployeesUnavailableError when the database returns an error", async () => {
    const { client } = fakeClient(seeded, "error");
    for (const call of calls(createEmployeesStore(both(client)))) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("throws EmployeesUnavailableError on a network failure", async () => {
    const { client } = fakeClient(seeded, "throw");
    for (const call of calls(createEmployeesStore(both(client)))) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("throws EmployeesUnavailableError when Supabase is not configured", async () => {
    const unconfigured = () => { throw new Error("Supabase is not configured"); };
    const store = createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => unconfigured(), interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: fakeHistory().store, leave: fakeLeave().store });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("rethrows a non-availability error from the interviews read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBe(bug);
  });

  it("throws EmployeesUnavailableError (never a profile without interviews) when the interviews read fails", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews(stored, true).store));
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store client and columns", () => {
  it("reads with the user's JWT client (RLS) for both roles; it has no service-role client to use", async () => {
    const user = fakeClient(seeded);
    const store = createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => user.client, interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: fakeHistory().store, leave: fakeLeave().store });
    await store.listFor(admin);
    await store.getFor(admin, "BS-1003");
    await store.listFor(staff);
    await store.getFor(staff, "BS-1002");
    expect(user.queries).toHaveLength(4);
  });

  it("maps auth_user_id to hasAccount on admin reads", async () => {
    const linked = { ...rowFor("BS-1001"), auth_user_id: "6f1d2c1e-0000-4000-8000-000000000001" };
    const unlinked = { ...rowFor("BS-1002"), auth_user_id: null };
    const { client, queries } = fakeClient([linked, unlinked]);
    const list = await createEmployeesStore(both(client)).listFor(admin);
    expect(list.map(e => [e.id, e.hasAccount])).toEqual([["BS-1001", true], ["BS-1002", false]]);
    expect(queries[0].columns).toContain("auth_user_id");
    expect(list[0]).not.toHaveProperty("auth_user_id");
  });

  it("maps department_id to departmentId on admin reads, null when unset (Story 4.1)", async () => {
    const placed = { ...rowFor("BS-1001"), department_id: "de9a0000-0000-4000-8000-000000000002" };
    const unplaced = { ...rowFor("BS-1002"), department_id: null };
    const { client, queries } = fakeClient([placed, unplaced]);
    const list = await createEmployeesStore(both(client)).listFor(admin);
    expect(list.map(e => [e.id, e.departmentId])).toEqual([["BS-1001", "de9a0000-0000-4000-8000-000000000002"], ["BS-1002", null]]);
    expect(queries[0].columns).toContain("department_id");
    expect(list[0]).not.toHaveProperty("department_id");
  });

  it("never selects department_id or sets departmentId on staff reads (Story 4.1)", async () => {
    const { client, queries } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    const own = await store.getFor(staff, "BS-1002");
    expect(own).not.toHaveProperty("departmentId");
    for (const q of queries) expect(q.columns).not.toContain("department_id");
  });

  it("never selects auth_user_id or archived_at, or sets hasAccount or archived, on staff reads", async () => {
    const { client, queries } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    const own = await store.getFor(staff, "BS-1002");
    const list = await store.listFor(staff);
    for (const employee of [own, list[0]]) {
      expect(employee).not.toHaveProperty("hasAccount");
      expect(employee).not.toHaveProperty("archived");
    }
    for (const q of queries) {
      expect(q.columns).not.toContain("auth_user_id");
      expect(q.columns).not.toContain("archived_at");
    }
  });

  it("maps archived_at to archived on admin reads, keeping archived employees listed", async () => {
    const archivedRow = { ...rowFor("BS-1001"), archived_at: "2026-10-08T09:00:00+00:00" };
    const activeRow = { ...rowFor("BS-1002"), archived_at: null };
    const { client, queries } = fakeClient([archivedRow, activeRow]);
    const list = await createEmployeesStore(both(client)).listFor(admin);
    expect(list.map(e => [e.id, e.archived])).toEqual([["BS-1001", true], ["BS-1002", false]]);
    expect(queries[0].columns).toContain("archived_at");
    expect(list[0]).not.toHaveProperty("archived_at");
  });

  it("reports the directory unavailable when the user client cannot be created", async () => {
    const store = createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => { throw new Error("cookies unavailable"); }, interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: fakeHistory().store, leave: fakeLeave().store });
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(staff, "BS-1002")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store.isActive", () => {
  it("is true for the staff member's own unarchived row, reading only archived_at through the JWT client", async () => {
    const { client, queries } = fakeClient([{ ...rowFor("BS-1002"), archived_at: null }]);
    expect(await createEmployeesStore(both(client)).isActive(staff)).toBe(true);
    expect(queries).toEqual([{ table: "employees", filters: [["employee_id", "BS-1002"]], columns: "archived_at" }]);
  });

  it("is false when the row is archived", async () => {
    const { client } = fakeClient([{ ...rowFor("BS-1002"), archived_at: "2026-10-08T09:00:00+00:00" }]);
    expect(await createEmployeesStore(both(client)).isActive(staff)).toBe(false);
  });

  it("is false when the row is not visible (missing, or not linked to this user under RLS)", async () => {
    const { client } = fakeClient([rowFor("BS-1001")]);
    expect(await createEmployeesStore(both(client)).isActive(staff)).toBe(false);
  });

  it.each(["error", "throw"] as const)("throws EmployeesUnavailableError when the read fails (%s)", async mode => {
    const { client } = fakeClient(seeded, mode);
    await expect(createEmployeesStore(both(client)).isActive(staff)).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store.linkedEmployeeId (Story 4.10)", () => {
  const linked = (id: string, userId: string, archived_at: string | null = null) =>
    ({ ...rowFor(id), auth_user_id: userId, archived_at }) as EmployeeRow;

  it("returns the employee id linked to the auth user, reading only the link columns through the JWT client", async () => {
    const { client, queries } = fakeClient([linked("BS-1001", "other"), linked("BS-1002", "admin-1")]);
    expect(await createEmployeesStore(both(client)).linkedEmployeeId("admin-1")).toBe("BS-1002");
    expect(queries).toEqual([{ table: "employees", filters: [["auth_user_id", "admin-1"]], columns: "employee_id,archived_at" }]);
  });

  it("returns null when no row is linked to the auth user", async () => {
    const { client } = fakeClient([linked("BS-1001", "other")]);
    expect(await createEmployeesStore(both(client)).linkedEmployeeId("admin-1")).toBeNull();
  });

  it("returns null when the linked row is archived", async () => {
    const { client } = fakeClient([linked("BS-1002", "admin-1", "2026-10-08T09:00:00+00:00")]);
    expect(await createEmployeesStore(both(client)).linkedEmployeeId("admin-1")).toBeNull();
  });

  it.each(["error", "throw"] as const)("throws EmployeesUnavailableError when the read fails (%s)", async mode => {
    const { client } = fakeClient(seeded, mode);
    await expect(createEmployeesStore(both(client)).linkedEmployeeId("admin-1")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store paging (Story 8.2)", () => {
  const rowAt = (i: number): EmployeeRow => ({ ...rowFor("BS-1001"), employee_id: `BS-${String(i).padStart(4, "0")}` });

  it("reads the employees in 1000-row pages until a short page, using every row", async () => {
    const { client, ranges } = pagedClient([many(1000, rowAt), many(1000, rowAt, 1000), many(3, rowAt, 2000)]);
    const all = await createEmployeesStore(both(client)).listFor(admin);
    expect(all).toHaveLength(2003);
    expect(all[2002].id).toBe("BS-2002");
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("throws the unavailable error when a later page fails", async () => {
    const { client, requests } = pagedClient([many(1000, rowAt), "error", many(3, rowAt)]);
    await expect(createEmployeesStore(both(client)).listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    expect(requests()).toBe(2);
  });
});

describe("employees-store manager paging (Story 4.3 with Story 8.2)", () => {
  const manager = { role: "manager", employeeId: "BS-1099", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
  const rowAt = (i: number): EmployeeRow => ({ ...rowFor("BS-1001"), employee_id: `BS-${String(i).padStart(4, "0")}`, department_id: "d", archived_at: null });
  const scopeOf = (ids: string[]): ManagerScope => ({ forManager: async () => ({ departmentIds: new Set(["d"]), employeeIds: new Set(ids) }) });
  const noTraining: Pick<TrainingStore, "listFor"> = { listFor: async () => [] };

  it("pages a manager's subtree past 1000 rows, never truncating it", async () => {
    const ids = many(2003, i => `BS-${String(i).padStart(4, "0")}`);
    const { client, ranges } = pagedClient([many(1000, rowAt), many(1000, rowAt, 1000), many(3, rowAt, 2000)]);
    const store = createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => client, interviews: fakeInterviews().store, training: noTraining, assignments: fakeAssignments([]).store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: fakeHistory().store, leave: fakeLeave().store, scope: scopeOf(ids) });
    const list = await store.listFor(manager);
    expect(list).toHaveLength(2003);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("throws the unavailable error when a later manager page fails", async () => {
    const { client } = pagedClient([many(1000, rowAt), "error"]);
    const store = createEmployeesStore({ assessments: fakeAssessments().store, userClient: async () => client, interviews: fakeInterviews().store, training: noTraining, assignments: fakeAssignments([]).store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, history: fakeHistory().store, leave: fakeLeave().store, scope: scopeOf(["BS-0001"]) });
    await expect(store.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store assignments (Story 4.5)", () => {
  const manager = { role: "manager", employeeId: "BS-1008", userId: "u-mgr" } as const;
  const scopeOf = (ids: string[]): ManagerScope => ({ forManager: async () => ({ departmentIds: new Set(["dept-1"]), employeeIds: new Set(ids) }) });

  it("has no `work` field any more: the fixture's current work is never read at runtime", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, fakeAssignments([]).store)).getFor(admin, "BS-1001");
    expect(employee).not.toHaveProperty("work");
    expect(employee?.assignments).toEqual([]);
  });

  it("gives each listed employee their own assignments, in the store's order, from one read", async () => {
    const { client } = fakeClient(seeded);
    const assignments = fakeAssignments();
    const list = await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, assignments.store)).listFor(admin);
    expect(list.find(e => e.id === "BS-1001")?.assignments.map(a => a.id)).toEqual(["a-1", "a-0"]);
    expect(list.find(e => e.id === "BS-1002")?.assignments.map(a => a.id)).toEqual(["a-2"]);
    expect(list.find(e => e.id === "BS-1003")?.assignments).toEqual([]);
    expect(assignments.calls).toEqual([[admin, undefined]]);
  });

  it("reads a profile's assignments for that employee only", async () => {
    const { client } = fakeClient(seeded);
    const assignments = fakeAssignments();
    await createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, assignments.store)).getFor(admin, "BS-1002");
    expect(assignments.calls).toEqual([[admin, "BS-1002"]]);
  });

  it("gives Staff only their own assignments", async () => {
    const { client } = fakeClient(seeded);
    const list = await createEmployeesStore(both(client)).listFor(staff);
    expect(list.map(e => [e.id, e.assignments.map(a => a.id)])).toEqual([["BS-1002", ["a-2"]]]);
  });

  it("gives a manager the assignments of in-scope employees (interviews stay empty)", async () => {
    const { client } = fakeClient(seeded);
    const assignments = fakeAssignments();
    const store = createEmployeesStore({ ...both(client, fakeInterviews().store, fakeTraining().store, assignments.store), scope: scopeOf(["BS-1001"]) });
    const list = await store.listFor(manager);
    expect(list.map(e => [e.id, e.assignments.map(a => a.id), e.interviews])).toEqual([["BS-1001", ["a-1", "a-0"], []]]);
    expect((await store.getFor(manager, "BS-1001"))?.assignments.map(a => a.id)).toEqual(["a-1", "a-0"]);
    expect(assignments.calls).toEqual([[manager, undefined], [manager, "BS-1001"]]);
  });

  it("makes the records unavailable (never a profile without assignments) when the assignments read fails", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, fakeAssignments([], true).store));
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.listFor(staff)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    const managed = createEmployeesStore({ ...both(client, fakeInterviews().store, fakeTraining().store, fakeAssignments([], true).store), scope: scopeOf(["BS-1001"]) });
    await expect(managed.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(managed.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("rethrows a non-availability error from the assignments read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, fakeInterviews().store, fakeTraining().store, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
  });
});

describe("employees-store assignment evaluations (Story 4.6)", () => {
  const manager = { role: "manager", employeeId: "BS-1008", userId: "u-mgr" } as const;
  const scopeOf = (ids: string[]): ManagerScope => ({ forManager: async () => ({ departmentIds: new Set(["dept-1"]), employeeIds: new Set(ids) }) });

  it("gives each listed employee their own evaluations from one read (admin)", async () => {
    const { client } = fakeClient(seeded);
    const evaluations = fakeEvaluations();
    const list = await createEmployeesStore(both(client, undefined, undefined, undefined, evaluations.store)).listFor(admin);
    expect(list.find(e => e.id === "BS-1001")?.evaluations.map(e => e.id)).toEqual(["ev-0"]);
    expect(list.find(e => e.id === "BS-1002")?.evaluations.map(e => e.id)).toEqual(["ev-9"]);
    expect(list.find(e => e.id === "BS-1003")?.evaluations).toEqual([]);
    expect(evaluations.calls).toEqual([[admin, undefined]]);
  });

  it("reads a profile's evaluations for that employee only", async () => {
    const { client } = fakeClient(seeded);
    const evaluations = fakeEvaluations();
    const employee = await createEmployeesStore(both(client, undefined, undefined, undefined, evaluations.store)).getFor(admin, "BS-1001");
    expect(employee?.evaluations.map(e => e.id)).toEqual(["ev-0"]);
    expect(evaluations.calls).toEqual([[admin, "BS-1001"]]);
  });

  it("gives Staff only their own evaluations, on both reads", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    expect((await store.listFor(staff)).map(e => [e.id, e.evaluations.map(v => v.id)])).toEqual([["BS-1002", ["ev-9"]]]);
    expect((await store.getFor(staff, "BS-1002"))?.evaluations.map(v => v.id)).toEqual(["ev-9"]);
  });

  it("gives a manager the evaluations of in-scope employees", async () => {
    const { client } = fakeClient(seeded);
    const evaluations = fakeEvaluations();
    const store = createEmployeesStore({ ...both(client, undefined, undefined, undefined, evaluations.store), scope: scopeOf(["BS-1001"]) });
    expect((await store.listFor(manager)).map(e => [e.id, e.evaluations.map(v => v.id)])).toEqual([["BS-1001", ["ev-0"]]]);
    expect((await store.getFor(manager, "BS-1001"))?.evaluations.map(v => v.id)).toEqual(["ev-0"]);
    expect(evaluations.calls).toEqual([[manager, undefined], [manager, "BS-1001"]]);
  });

  it("makes the records unavailable (never a profile without evaluations) when the evaluations read fails", async () => {
    const { client } = fakeClient(seeded);
    const failing = fakeEvaluations([], true).store;
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, failing));
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.listFor(staff)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    const managed = createEmployeesStore({ ...both(client, undefined, undefined, undefined, failing), scope: scopeOf(["BS-1001"]) });
    await expect(managed.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(managed.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("rethrows a non-availability error from the evaluations read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
  });
});

describe("employees-store backfilled projects (Story 4.7)", () => {
  const manager = { role: "manager", employeeId: "BS-1008", userId: "u-mgr" } as const;
  const scopeOf = (ids: string[]): ManagerScope => ({ forManager: async () => ({ departmentIds: new Set(["dept-1"]), employeeIds: new Set(ids) }) });

  it("gives each listed employee their own backfilled projects from one read (admin), withdrawn ones included", async () => {
    const { client } = fakeClient(seeded);
    const backfilled = fakeBackfilled();
    const list = await createEmployeesStore(both(client, undefined, undefined, undefined, undefined, backfilled.store)).listFor(admin);
    expect(list.find(e => e.id === "BS-1001")?.backfilledProjects.map(b => b.id)).toEqual(["bp-0"]);
    expect(list.find(e => e.id === "BS-1002")?.backfilledProjects).toMatchObject([{ id: "bp-9", status: "withdrawn", provenance: "backfilled" }]);
    expect(list.find(e => e.id === "BS-1003")?.backfilledProjects).toEqual([]);
    expect(backfilled.calls).toEqual([[admin, undefined]]);
  });

  it("reads a profile's backfilled projects for that employee only", async () => {
    const { client } = fakeClient(seeded);
    const backfilled = fakeBackfilled();
    const employee = await createEmployeesStore(both(client, undefined, undefined, undefined, undefined, backfilled.store)).getFor(admin, "BS-1001");
    expect(employee?.backfilledProjects.map(b => b.id)).toEqual(["bp-0"]);
    expect(backfilled.calls).toEqual([[admin, "BS-1001"]]);
  });

  it("gives Staff only their own, and a manager those of in-scope employees", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    expect((await store.listFor(staff)).map(e => [e.id, e.backfilledProjects.map(b => b.id)])).toEqual([["BS-1002", ["bp-9"]]]);
    expect((await store.getFor(staff, "BS-1002"))?.backfilledProjects.map(b => b.id)).toEqual(["bp-9"]);
    const backfilled = fakeBackfilled();
    const managed = createEmployeesStore({ ...both(client, undefined, undefined, undefined, undefined, backfilled.store), scope: scopeOf(["BS-1001"]) });
    expect((await managed.listFor(manager)).map(e => [e.id, e.backfilledProjects.map(b => b.id)])).toEqual([["BS-1001", ["bp-0"]]]);
    expect((await managed.getFor(manager, "BS-1001"))?.backfilledProjects.map(b => b.id)).toEqual(["bp-0"]);
    expect(backfilled.calls).toEqual([[manager, undefined], [manager, "BS-1001"]]);
  });

  it("makes the records unavailable (never a profile without past projects) when the backfilled read fails", async () => {
    const { client } = fakeClient(seeded);
    const failing = fakeBackfilled([], true).store;
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, undefined, failing));
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(admin, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.listFor(staff)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    const managed = createEmployeesStore({ ...both(client, undefined, undefined, undefined, undefined, failing), scope: scopeOf(["BS-1001"]) });
    await expect(managed.listFor(manager)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(managed.getFor(manager, "BS-1001")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("rethrows a non-availability error from the backfilled read unchanged", async () => {
    const { client } = fakeClient(seeded);
    const bug = new TypeError("bug");
    const store = createEmployeesStore(both(client, undefined, undefined, undefined, undefined, { listFor: async () => { throw bug; } }));
    await expect(store.listFor(admin)).rejects.toBe(bug);
  });
});

describe("employees-store.create (Story 7.1)", () => {
  const DEPT = "de9a0000-0000-4000-8000-0000000000c1";
  const OTHER = "de9a0000-0000-4000-8000-0000000000d1";
  const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
  const input: NewEmployeeInput = {
    employeeId: "BS-4321", name: "  Tanvir   Hasan ", title: "QA Engineer", team: "Quality", email: " Tanvir.Hasan@Example.com ",
    departmentId: DEPT, manager: "Meera Das", office: "Dhaka HQ", employmentType: "Trainee", joinedOn: "2026-10-01",
  };

  type Insert = { table: string; row: Record<string, unknown>; options?: unknown };
  /** A client whose insert answers with `error` (or throws), recording what was inserted. */
  function insertClient(error: { code?: string; message?: string; details?: string } | null = null, throws = false) {
    const inserts: Insert[] = [];
    let calls = 0;
    const client = {
      from(table: string) {
        calls++;
        if (throws) throw new TypeError("fetch failed");
        return {
          insert(row: Record<string, unknown>, options?: unknown) {
            inserts.push({ table, row, options });
            const result = { data: null, error };
            // A thenable without .select(): the store never reads the row back.
            return { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject) };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, inserts, calls: () => calls };
  }

  function fakeScope(departmentIds: string[], fail?: Error) {
    const calls: SessionIdentity[] = [];
    const scope: ManagerScope = {
      async forManager(session) {
        calls.push(session);
        if (fail) throw fail;
        return { departmentIds: new Set(departmentIds), employeeIds: new Set() };
      },
    };
    return { scope, calls };
  }

  const storeWith = (client: SupabaseClient, scope = fakeScope([DEPT]).scope) =>
    createEmployeesStore({ ...both(client), scope });

  it("lets an admin add an employee with normalised input and derived fields, never an account link or archive flag", async () => {
    const { client, inserts } = insertClient();
    const scope = fakeScope([]);
    expect(await storeWith(client, scope.scope).create(admin, input)).toEqual({ employeeId: "BS-4321", name: "Tanvir Hasan" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("employees");
    expect(inserts[0].row).toEqual({
      employee_id: "BS-4321", name: "Tanvir Hasan", title: "QA Engineer", team: "Quality", email: "tanvir.hasan@example.com",
      department_id: DEPT, manager: "Meera Das", office: "Dhaka HQ", employment_type: "Trainee", joined_on: "2026-10-01",
      status: "Available", initials: "TH", avatar_color: "mint", summary: "",
    });
    expect(inserts[0].row).not.toHaveProperty("auth_user_id");
    expect(inserts[0].row).not.toHaveProperty("archived_at");
    // The Administrator's department authority is not limited by a scope.
    expect(scope.calls).toEqual([]);
  });

  // Story 9.1: the server-only summary option (the simulator's cohort label); employee-actions never passes it.
  it("stores a trimmed summary option in place of the derived empty summary", async () => {
    const { client, inserts } = insertClient();
    await storeWith(client).create(admin, input, { summary: "  Simulation cohort c00ab12. Trainee.  " });
    expect(inserts[0].row.summary).toBe("Simulation cohort c00ab12. Trainee.");
    const plain = insertClient();
    await storeWith(plain.client).create(admin, input, {});
    expect(plain.inserts[0].row.summary).toBe("");
  });

  it("refuses a summary option over 500 characters before any insert", async () => {
    const { client, inserts } = insertClient();
    await storeWith(client).create(admin, input, { summary: "x".repeat(500) });
    expect(inserts).toHaveLength(1);
    const refused = insertClient();
    await expect(storeWith(refused.client).create(admin, input, { summary: "x".repeat(501) }))
      .rejects.toMatchObject({ name: "EmployeeValidationError", fields: ["summary"] });
    expect(refused.inserts).toEqual([]);
  });

  it("defaults the join date to today in Asia/Dhaka", async () => {
    const { client, inserts } = insertClient();
    await storeWith(client).create(admin, { ...input, joinedOn: undefined });
    expect(inserts[0].row.joined_on).toBe(todayInDhaka());
  });

  it("ignores extra properties smuggled into the input", async () => {
    const { client, inserts } = insertClient();
    const forged = { ...input, auth_user_id: "aaaa0000-0000-4000-8000-0000000000ff", status: "On project", archived_at: "2026-01-01" };
    await storeWith(client).create(admin, forged as NewEmployeeInput);
    expect(inserts[0].row).not.toHaveProperty("auth_user_id");
    expect(inserts[0].row).not.toHaveProperty("archived_at");
    expect(inserts[0].row.status).toBe("Available");
  });

  it("lets a manager add to a department in their subtree, working the scope out fresh", async () => {
    const { client, inserts } = insertClient();
    const scope = fakeScope([DEPT]);
    await storeWith(client, scope.scope).create(manager, input);
    expect(inserts).toHaveLength(1);
    expect(scope.calls).toEqual([manager]);
  });

  it("refuses a manager adding outside their subtree, without an insert", async () => {
    const { client, inserts } = insertClient();
    await expect(storeWith(client, fakeScope([DEPT]).scope).create(manager, { ...input, departmentId: OTHER }))
      .rejects.toBeInstanceOf(EmployeeForbiddenError);
    expect(inserts).toHaveLength(0);
  });

  it("reports unavailable, without an insert, when a manager's scope cannot be read", async () => {
    const { client, inserts } = insertClient();
    await expect(storeWith(client, fakeScope([], new ManagerScopeUnavailableError()).scope).create(manager, input))
      .rejects.toBeInstanceOf(EmployeesUnavailableError);
    expect(inserts).toHaveLength(0);
  });

  it("refuses Staff without any query", async () => {
    const { client, calls } = insertClient();
    const scope = fakeScope([DEPT]);
    await expect(storeWith(client, scope.scope).create(staff, input)).rejects.toBeInstanceOf(EmployeeForbiddenError);
    expect(calls()).toBe(0);
    expect(scope.calls).toEqual([]);
  });

  it("refuses a missing department and other bad input without an insert", async () => {
    const { client, inserts } = insertClient();
    const store = storeWith(client);
    await expect(store.create(admin, { ...input, departmentId: "" })).rejects.toMatchObject({ fields: ["departmentId"] });
    await expect(store.create(admin, { ...input, employeeId: "BS-12", email: "nope" })).rejects.toMatchObject({ fields: ["employeeId", "email"] });
    await expect(store.create(admin, { ...input, employmentType: "Contractor" })).rejects.toBeInstanceOf(EmployeeValidationError);
    await expect(store.create(admin, { ...input, joinedOn: "2026-02-30" })).rejects.toBeInstanceOf(EmployeeValidationError);
    expect(inserts).toHaveLength(0);
  });

  it.each([
    [{ code: "23505", message: 'duplicate key value violates unique constraint "employees_pkey"', details: "Key (employee_id)=(BS-4321) already exists." }, "employeeId"],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "employees_email_key"', details: "Key (email)=(x@example.com) already exists." }, "email"],
  ] as const)("maps a unique violation (%j) to EmployeeExistsError(%s)", async (error, field) => {
    const { client } = insertClient(error);
    const refused = await storeWith(client).create(admin, input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(EmployeeExistsError);
    expect((refused as InstanceType<typeof EmployeeExistsError>).field).toBe(field);
  });

  it("maps an unknown department (23503) to a department validation error", async () => {
    const { client } = insertClient({ code: "23503", message: "insert or update on table \"employees\" violates foreign key constraint" });
    await expect(storeWith(client).create(admin, input)).rejects.toMatchObject({ name: "EmployeeValidationError", fields: ["departmentId"] });
  });

  it("maps a malformed department id (22P02) to a department validation error", async () => {
    const { client } = insertClient({ code: "22P02", message: 'invalid input syntax for type uuid: "not-a-uuid"' });
    await expect(storeWith(client).create(admin, { ...input, departmentId: "not-a-uuid" }))
      .rejects.toMatchObject({ name: "EmployeeValidationError", fields: ["departmentId"] });
  });

  it("maps an RLS refusal (42501) to EmployeeForbiddenError", async () => {
    const { client } = insertClient({ code: "42501", message: "new row violates row-level security policy for table \"employees\"" });
    await expect(storeWith(client).create(manager, input)).rejects.toBeInstanceOf(EmployeeForbiddenError);
  });

  it.each([
    [{ code: "08006", message: "connection failure" }],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "employees_auth_user_id_key"' }],
    [{ message: "Bad gateway" }],
  ])("maps any other error (%j) to EmployeesUnavailableError", async error => {
    const { client } = insertClient(error);
    await expect(storeWith(client).create(admin, input)).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("maps a thrown client error to EmployeesUnavailableError", async () => {
    const { client } = insertClient(null, true);
    await expect(storeWith(client).create(admin, input)).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store.updateDetails (Story 7.2)", () => {
  const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
  const input: EmployeeDetailsInput = {
    title: "  Senior   QA Engineer ", team: "Quality", manager: "Meera Das", office: " Dhaka  HQ ", employmentType: "Permanent",
  };

  type Rpc = { fn: string; args: Record<string, unknown> };
  /** A client whose rpc answers with `data`/`error` (or throws), recording every call. No table access. */
  function rpcClient(answer: { data?: unknown; error?: { code?: string; message?: string } | null } = { data: "Tanvir Hasan" }, throws = false) {
    const rpcs: Rpc[] = [];
    let tables = 0;
    const client = {
      from() { tables++; throw new Error("updateDetails must not touch a table directly"); },
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcs.push({ fn, args });
        if (throws) throw new TypeError("fetch failed");
        return { data: answer.data ?? null, error: answer.error ?? null };
      },
    } as unknown as SupabaseClient;
    return { client, rpcs, tables: () => tables };
  }

  function fakeScope(employeeIds: string[], fail?: Error) {
    const calls: SessionIdentity[] = [];
    const scope: ManagerScope = {
      async forManager(session) {
        calls.push(session);
        if (fail) throw fail;
        return { departmentIds: new Set(), employeeIds: new Set(employeeIds) };
      },
    };
    return { scope, calls };
  }

  const storeWith = (client: SupabaseClient, scope = fakeScope(["BS-4321"]).scope) =>
    createEmployeesStore({ ...both(client), scope });

  it("lets an admin save the five fields, normalised, through the rpc only", async () => {
    const { client, rpcs, tables } = rpcClient();
    const scope = fakeScope([]);
    expect(await storeWith(client, scope.scope).updateDetails(admin, "BS-4321", input)).toEqual({ employeeId: "BS-4321", name: "Tanvir Hasan" });
    expect(rpcs).toEqual([{ fn: "update_employee_details", args: {
      p_employee_id: "BS-4321", p_title: "Senior QA Engineer", p_team: "Quality", p_manager: "Meera Das", p_office: "Dhaka HQ",
      p_employment_type: "Permanent",
    } }]);
    expect(tables()).toBe(0);
    expect(scope.calls).toEqual([]);
  });

  it("never sends a department or any other column, even when smuggled into the input", async () => {
    const { client, rpcs } = rpcClient();
    const forged = { ...input, departmentId: "de9a0000-0000-4000-8000-0000000000d1", name: "X", archived_at: "2026-01-01" };
    await storeWith(client).updateDetails(admin, "BS-4321", forged as EmployeeDetailsInput);
    expect(Object.keys(rpcs[0].args).sort()).toEqual(
      ["p_employee_id", "p_employment_type", "p_manager", "p_office", "p_team", "p_title"],
    );
  });

  it("lets a manager edit an employee in their subtree, working the scope out fresh", async () => {
    const { client, rpcs } = rpcClient();
    const scope = fakeScope(["BS-4321"]);
    await storeWith(client, scope.scope).updateDetails(manager, "BS-4321", input);
    expect(rpcs).toHaveLength(1);
    expect(scope.calls).toEqual([manager]);
  });

  it("refuses a manager outside their subtree without calling the rpc", async () => {
    const { client, rpcs } = rpcClient();
    await expect(storeWith(client, fakeScope(["BS-4321"]).scope).updateDetails(manager, "BS-9999", input))
      .rejects.toBeInstanceOf(EmployeeForbiddenError);
    expect(rpcs).toHaveLength(0);
  });

  it("reports unavailable, without the rpc, when a manager's scope cannot be read", async () => {
    const { client, rpcs } = rpcClient();
    await expect(storeWith(client, fakeScope([], new ManagerScopeUnavailableError()).scope).updateDetails(manager, "BS-4321", input))
      .rejects.toBeInstanceOf(EmployeesUnavailableError);
    expect(rpcs).toHaveLength(0);
  });

  it("refuses Staff, even on their own record, without any query", async () => {
    const { client, rpcs, tables } = rpcClient();
    const scope = fakeScope([staff.employeeId]);
    await expect(storeWith(client, scope.scope).updateDetails(staff, staff.employeeId, input)).rejects.toBeInstanceOf(EmployeeForbiddenError);
    expect(rpcs).toHaveLength(0);
    expect(tables()).toBe(0);
    expect(scope.calls).toEqual([]);
  });

  it("refuses blank, over-long and unknown values without the rpc", async () => {
    const { client, rpcs } = rpcClient();
    const store = storeWith(client);
    await expect(store.updateDetails(admin, "BS-4321", { ...input, title: "   " })).rejects.toMatchObject({ fields: ["title"] });
    await expect(store.updateDetails(admin, "BS-4321", { ...input, office: "x".repeat(121), team: "" }))
      .rejects.toMatchObject({ fields: ["team", "office"] });
    await expect(store.updateDetails(admin, "BS-4321", { ...input, employmentType: "Contractor" }))
      .rejects.toMatchObject({ name: "EmployeeValidationError", fields: ["employmentType"] });
    expect(rpcs).toHaveLength(0);
  });

  it.each([
    ["not_authorized", EmployeeForbiddenError],
    ["invalid_input", EmployeeValidationError],
    ["employee_not_found", EmployeeNotFoundError],
    ["something_else", EmployeesUnavailableError],
  ] as const)("maps the function error %s", async (message, type) => {
    const { client } = rpcClient({ error: { code: "P0001", message } });
    const refused = await storeWith(client).updateDetails(admin, "BS-4321", input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(type);
    if (refused instanceof EmployeeValidationError) expect(refused.fields).toEqual(["details"]);
  });

  it("maps a missing function (PGRST202), a thrown client error and a missing name to unavailable", async () => {
    await expect(storeWith(rpcClient({ error: { code: "PGRST202", message: "Could not find the function" } }).client)
      .updateDetails(admin, "BS-4321", input)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(storeWith(rpcClient({}, true).client).updateDetails(admin, "BS-4321", input)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(storeWith(rpcClient({ data: null }).client).updateDetails(admin, "BS-4321", input)).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store transfer (Story 4.8)", () => {
  const P = "de9a0000-0000-4000-8000-0000000000d1";
  const C = "de9a0000-0000-4000-8000-0000000000d2";
  const OUTSIDE = "de9a0000-0000-4000-8000-0000000000d9";
  const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;

  type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

  /** A client whose employees read returns `departmentId` for BS-1001 and whose rpc answers `rpcResult` (or throws). */
  function transferClient(rpcResult: RpcResult | Error = { data: "Nadia Rahman", error: null }, departmentId: string | null = P, readError = false) {
    const rpcCalls: [string, unknown][] = [];
    const reads: [string, string][] = [];
    const client = {
      from(table: string) {
        const filters: [string, string][] = [];
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => { filters.push([col, val]); return builder; },
          maybeSingle: async () => {
            reads.push([table, filters.map(f => f.join("=")).join("&")]);
            if (readError) return { data: null, error: { message: "connection refused" } };
            return { data: filters.some(([, v]) => v === "BS-1001") ? { department_id: departmentId } : null, error: null };
          },
        };
        return builder;
      },
      async rpc(name: string, args: unknown) {
        rpcCalls.push([name, args]);
        if (rpcResult instanceof Error) throw rpcResult;
        return rpcResult;
      },
    };
    return { client: client as unknown as SupabaseClient, rpcCalls, reads };
  }

  function fakeScope(employeeIds: string[] = ["BS-1001"], departmentIds: string[] = [P, C], fail?: Error) {
    const calls: unknown[] = [];
    const scope: ManagerScope = {
      async forManager(session) {
        calls.push(session);
        if (fail) throw fail;
        return { departmentIds: new Set(departmentIds), employeeIds: new Set(employeeIds) };
      },
    };
    return { scope, calls };
  }

  const storeFor = (client: SupabaseClient, scope: ManagerScope = fakeScope().scope) =>
    createEmployeesStore({ ...both(client), scope });

  it("moves an in-scope employee for a manager over both departments through the user client's rpc", async () => {
    const { client, rpcCalls } = transferClient();
    const result = await storeFor(client).transfer(manager, "BS-1001", C);
    expect(result).toEqual({ employeeId: "BS-1001", name: "Nadia Rahman", fromDepartmentId: P, toDepartmentId: C });
    expect(rpcCalls).toEqual([["transfer_employee", { p_employee_id: "BS-1001", p_to_department_id: C }]]);
  });

  it("moves any employee for the Administrator, without asking the manager scope, with from null when there was no department", async () => {
    const { client, rpcCalls } = transferClient({ data: "Nadia Rahman", error: null }, null);
    const { scope, calls } = fakeScope([], []);
    const result = await storeFor(client, scope).transfer(admin, " BS-1001 ", OUTSIDE);
    expect(result).toEqual({ employeeId: "BS-1001", name: "Nadia Rahman", fromDepartmentId: null, toDepartmentId: OUTSIDE });
    expect(rpcCalls).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it.each([
    ["the employee is outside the manager's subtree", ["BS-9999"], [P, C]],
    ["the destination is outside the manager's subtree", ["BS-1001"], [P]],
  ])("refuses a manager when %s, before any read or rpc", async (_case, employeeIds, departmentIds) => {
    const { client, rpcCalls, reads } = transferClient();
    await expect(storeFor(client, fakeScope(employeeIds, departmentIds).scope).transfer(manager, "BS-1001", C))
      .rejects.toBeInstanceOf(TransferForbiddenError);
    expect(rpcCalls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it.each([[staff], [{ role: "staff", employeeId: "BS-1001" } as const]])("refuses Staff %j (their own record included) before any call", async session => {
    const { client, rpcCalls, reads } = transferClient();
    const { scope, calls } = fakeScope();
    await expect(storeFor(client, scope).transfer(session, "BS-1001", C)).rejects.toBeInstanceOf(TransferForbiddenError);
    expect(rpcCalls).toEqual([]);
    expect(reads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["BS-1", C, ["employeeId"]],
    ["BS-1001", "not-a-uuid", ["toDepartmentId"]],
    ["", "", ["employeeId", "toDepartmentId"]],
  ])("rejects malformed input (%s, %s) with TransferInvalidError and no call", async (employeeId, to, fields) => {
    const { client, rpcCalls } = transferClient();
    const error = await storeFor(client).transfer(admin, employeeId, to).catch(e => e);
    expect(error).toBeInstanceOf(TransferInvalidError);
    expect((error as TransferInvalidError).fields).toEqual(fields);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    [{ message: "not_authorized", code: "P0001" }, TransferForbiddenError],
    [{ message: "permission denied for function transfer_employee", code: "42501" }, TransferForbiddenError],
    [{ message: "employee_not_found", code: "P0001" }, TransferNotFoundError],
    [{ message: "department_not_found", code: "P0001" }, TransferDepartmentError],
    [{ message: "same_department", code: "P0001" }, TransferSameDepartmentError],
    [{ message: "open_assignment", code: "P0001" }, TransferOpenAssignmentError],
    [{ message: "Could not find the function public.transfer_employee", code: "PGRST202" }, EmployeesUnavailableError],
    [{ message: "something else", code: "XX000" }, EmployeesUnavailableError],
  ])("maps the database error %j", async (dbError, expected) => {
    const { client } = transferClient({ data: null, error: dbError });
    await expect(storeFor(client).transfer(admin, "BS-1001", C)).rejects.toBeInstanceOf(expected);
  });

  it("reports the records unavailable when the rpc throws or returns no name", async () => {
    await expect(storeFor(transferClient(new TypeError("fetch failed")).client).transfer(admin, "BS-1001", C))
      .rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(storeFor(transferClient({ data: null, error: null }).client).transfer(admin, "BS-1001", C))
      .rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("still transfers, with from null, when the informational department read fails", async () => {
    const { client, rpcCalls } = transferClient(undefined, P, true);
    const result = await storeFor(client).transfer(admin, "BS-1001", C);
    expect(result).toEqual({ employeeId: "BS-1001", name: "Nadia Rahman", fromDepartmentId: null, toDepartmentId: C });
    expect(rpcCalls).toHaveLength(1);
  });

  it("reports the records unavailable, without an rpc, when the manager scope cannot be read", async () => {
    const { client, rpcCalls } = transferClient();
    const { scope } = fakeScope(undefined, undefined, new ManagerScopeUnavailableError({ cause: "down" }));
    await expect(storeFor(client, scope).transfer(manager, "BS-1001", C)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    expect(rpcCalls).toEqual([]);
  });

  it("leaves an unknown employee to the database for the Administrator (employee_not_found)", async () => {
    const { client, rpcCalls } = transferClient({ data: null, error: { message: "employee_not_found", code: "P0001" } });
    await expect(storeFor(client).transfer(admin, "BS-9999", C)).rejects.toBeInstanceOf(TransferNotFoundError);
    expect(rpcCalls).toHaveLength(1);
  });
});
