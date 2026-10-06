import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture } from "@/data/employees";
import { createEmployeesStore, EmployeesUnavailableError, type EmployeeRow } from "@/server/employees-store";

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

const both = (client: SupabaseClient) => ({ userClient: async () => client });

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
  it("merges each row with the fixture's nested profile data by id", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(both(client)).getFor(admin, "BS-1001");
    expect(employee).toEqual({ ...fixture.find(e => e.id === "BS-1001"), hasAccount: false });
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
    const store = createEmployeesStore({ userClient: async () => unconfigured() });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});

describe("employees-store client and columns", () => {
  it("reads with the user's JWT client (RLS) for both roles; it has no service-role client to use", async () => {
    const user = fakeClient(seeded);
    const store = createEmployeesStore({ userClient: async () => user.client });
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
    const store = createEmployeesStore({ userClient: async () => { throw new Error("cookies unavailable"); } });
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(EmployeesUnavailableError);
    await expect(store.getFor(staff, "BS-1002")).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});
