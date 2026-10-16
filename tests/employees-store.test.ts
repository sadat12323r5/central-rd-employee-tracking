import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture } from "@/data/employees";
import { createEmployeesStore, EmployeesUnavailableError, type EmployeeRow } from "@/server/employees-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import { many, pagedClient } from "./support/paged-client";
import { InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";
import { TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "@/server/training-store";
import { AssignmentsUnavailableError, type Assignment, type AssignmentsStore } from "@/server/assignments-store";
import { EvaluationsUnavailableError, type AssignmentEvaluation, type AssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import { BackfillUnavailableError, type BackfilledProject, type BackfilledProjectStore } from "@/server/backfilled-project-store";

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
  id, employeeId, departmentId: "dept-1", client: "Old client", projectName: `Past ${id}`, completionDate: "2025-06-30",
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

const both = (
  client: SupabaseClient, interviews = fakeInterviews().store, training = fakeTraining().store, assignments = fakeAssignments().store,
  evaluations = fakeEvaluations().store, backfilled = fakeBackfilled().store,
) => ({
  userClient: async () => client, interviews, training, assignments, evaluations, backfilled,
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
  const storeWith = (client: SupabaseClient, scope: ManagerScope, interviews = fakeInterviews(), training = managerTraining()) =>
    createEmployeesStore({ userClient: async () => client, interviews: interviews.store, training: training.store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, scope });

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

const entry = (employeeId: string, id: string, extra: Partial<TrainingEntry> = {}): TrainingEntry => ({
  id, employeeId, name: `Programme ${id}`, provider: "BS23 Learning & Development", progress: 100, date: "2026-08-20", result: "Completed", ...extra,
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
    const store = createEmployeesStore({ userClient: async () => unconfigured(), interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store });
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
    const store = createEmployeesStore({ userClient: async () => user.client, interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store });
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
    const store = createEmployeesStore({ userClient: async () => { throw new Error("cookies unavailable"); }, interviews: fakeInterviews().store, training: fakeTraining().store, assignments: fakeAssignments().store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store });
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
    const store = createEmployeesStore({ userClient: async () => client, interviews: fakeInterviews().store, training: noTraining, assignments: fakeAssignments([]).store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, scope: scopeOf(ids) });
    const list = await store.listFor(manager);
    expect(list).toHaveLength(2003);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("throws the unavailable error when a later manager page fails", async () => {
    const { client } = pagedClient([many(1000, rowAt), "error"]);
    const store = createEmployeesStore({ userClient: async () => client, interviews: fakeInterviews().store, training: noTraining, assignments: fakeAssignments([]).store, evaluations: fakeEvaluations([]).store, backfilled: fakeBackfilled([]).store, scope: scopeOf(["BS-0001"]) });
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
