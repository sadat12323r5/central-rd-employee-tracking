import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture } from "@/data/employees";
import { createEmployeesStore, EmployeesUnavailableError, type EmployeeRow } from "@/server/employees-store";
import { many, pagedClient } from "./support/paged-client";
import { InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";
import { TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "@/server/training-store";

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
  const queries: { table: string; filters: [string, string][]; columns?: string; range?: [number, number] }[] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query = { table, filters: [] as [string, string][], columns: undefined as string | undefined, range: undefined as [number, number] | undefined };
      queries.push(query);
      const result = () => {
        if (mode === "error") return { data: null, error: { message: "connection refused" } };
        const matched = rows.filter(r => query.filters.every(([col, val]) => (r as Record<string, string>)[col] === val));
        const sorted = [...matched].sort((a, b) => a.employee_id.localeCompare(b.employee_id));
        return { data: query.range ? sorted.slice(query.range[0], query.range[1] + 1) : sorted, error: null };
      };
      const builder = {
        select: (columns: string) => { query.columns = columns; return builder; },
        eq: (col: string, val: string) => { query.filters.push([col, val]); return builder; },
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

const both = (client: SupabaseClient, interviews = fakeInterviews().store, training = fakeTraining().store) => ({
  userClient: async () => client, interviews, training,
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

describe("employees-store data", () => {
  it("merges each row with the fixture's nested profile data by id, but interviews and training from their stores", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-1001");
    expect(employee).toEqual({
      ...fixture.find(e => e.id === "BS-1001"), hasAccount: false, archived: false,
      interviews: [withoutEmployee(stored[0]), withoutEmployee(stored[2])],
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
    const store = createEmployeesStore({ userClient: async () => unconfigured(), interviews: fakeInterviews().store, training: fakeTraining().store });
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
    const store = createEmployeesStore({ userClient: async () => user.client, interviews: fakeInterviews().store, training: fakeTraining().store });
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
    const store = createEmployeesStore({ userClient: async () => { throw new Error("cookies unavailable"); }, interviews: fakeInterviews().store, training: fakeTraining().store });
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
