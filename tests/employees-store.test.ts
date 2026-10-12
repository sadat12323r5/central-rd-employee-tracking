import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture } from "@/data/employees";
import { createEmployeesStore, EmployeesUnavailableError, type EmployeeRow } from "@/server/employees-store";
import { InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";

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
  const queries: { table: string; filters: [string, string][]; columns?: string }[] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query = { table, filters: [] as [string, string][], columns: undefined as string | undefined };
      queries.push(query);
      const result = () => {
        if (mode === "error") return { data: null, error: { message: "connection refused" } };
        const matched = rows.filter(r => query.filters.every(([col, val]) => (r as Record<string, string>)[col] === val));
        return { data: [...matched].sort((a, b) => a.employee_id.localeCompare(b.employee_id)), error: null };
      };
      const builder = {
        select: (columns: string) => { query.columns = columns; return builder; },
        eq: (col: string, val: string) => { query.filters.push([col, val]); return builder; },
        order: () => builder,
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

const both = (client: SupabaseClient, interviews = fakeInterviews().store) => ({ userClient: async () => client, interviews });
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
  it("merges each row with the fixture's nested profile data by id, but interviews from the interviews store", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-1001");
    expect(employee).toEqual({
      ...fixture.find(e => e.id === "BS-1001"), hasAccount: false,
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
    const store = createEmployeesStore({ userClient: async () => unconfigured(), interviews: fakeInterviews().store });
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
    const store = createEmployeesStore({ userClient: async () => user.client, interviews: fakeInterviews().store });
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

  it("never selects auth_user_id or sets hasAccount on staff reads", async () => {
    const { client, queries } = fakeClient(seeded);
    const store = createEmployeesStore(both(client));
    const own = await store.getFor(staff, "BS-1002");
    const list = await store.listFor(staff);
    expect(own).not.toHaveProperty("hasAccount");
    expect(list[0]).not.toHaveProperty("hasAccount");
    for (const q of queries) expect(q.columns).not.toContain("auth_user_id");
  });

  it("reports the directory unavailable when the user client cannot be created", async () => {
    const store = createEmployeesStore({ userClient: async () => { throw new Error("cookies unavailable"); }, interviews: fakeInterviews().store });
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(staff, "BS-1002")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});
