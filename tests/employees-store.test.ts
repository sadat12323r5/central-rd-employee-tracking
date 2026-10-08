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
  const queries: { table: string; filters: [string, string][] }[] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query = { table, filters: [] as [string, string][] };
      queries.push(query);
      const result = () => {
        if (mode === "error") return { data: null, error: { message: "connection refused" } };
        const matched = rows.filter(r => query.filters.every(([col, val]) => (r as Record<string, string>)[col] === val));
        return { data: [...matched].sort((a, b) => a.employee_id.localeCompare(b.employee_id)), error: null };
      };
      const builder = {
        select: () => builder,
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

const seeded = ["BS-1001", "BS-1002", "BS-1003"].map(rowFor);
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1002" } as const;

describe("employees-store role scoping", () => {
  it("lists every employee for an admin", async () => {
    const { client } = fakeClient(seeded);
    const list = await createEmployeesStore(() => client).listFor(admin);
    expect(list.map(e => e.id)).toEqual(["BS-1001", "BS-1002", "BS-1003"]);
  });

  it("lists only the session's own record for staff, filtering in the query", async () => {
    const { client, queries } = fakeClient(seeded);
    const list = await createEmployeesStore(() => client).listFor(staff);
    expect(list.map(e => e.id)).toEqual(["BS-1002"]);
    expect(queries[0].filters).toEqual([["employee_id", "BS-1002"]]);
  });

  it("lets an admin get any employee", async () => {
    const { client } = fakeClient(seeded);
    expect((await createEmployeesStore(() => client).getFor(admin, "BS-1003"))?.name).toBe("Meera Das");
  });

  it("lets staff get their own record but returns null for anyone else's without querying", async () => {
    const { client, queries } = fakeClient(seeded);
    const store = createEmployeesStore(() => client);
    expect((await store.getFor(staff, "BS-1002"))?.id).toBe("BS-1002");
    queries.length = 0;
    expect(await store.getFor(staff, "BS-1001")).toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe("employees-store data", () => {
  it("merges each row with the fixture's nested profile data by id", async () => {
    const { client } = fakeClient(seeded);
    const employee = await createEmployeesStore(() => client).getFor(admin, "BS-1001");
    expect(employee).toEqual(fixture.find(e => e.id === "BS-1001"));
  });

  it("uses the database's basic fields over the fixture's", async () => {
    const changed = { ...rowFor("BS-1001"), title: "Software Engineer II", office: "Chattogram, Bangladesh" };
    const { client } = fakeClient([changed]);
    const employee = await createEmployeesStore(() => client).getFor(admin, "BS-1001");
    expect(employee).toMatchObject({ title: "Software Engineer II", location: "Chattogram, Bangladesh" });
    expect(employee?.skills).toEqual(fixture.find(e => e.id === "BS-1001")!.skills);
  });

  it("gives an employee with no fixture entry empty nested data", async () => {
    const { client } = fakeClient([{ ...rowFor("BS-1001"), employee_id: "BS-9001", email: "new@example.com" }]);
    const employee = await createEmployeesStore(() => client).getFor(admin, "BS-9001");
    expect(employee).toMatchObject({ id: "BS-9001", skills: [], interviews: [], history: [] });
  });

  it("returns null when the employee does not exist", async () => {
    const { client } = fakeClient(seeded);
    const store = createEmployeesStore(() => client);
    expect(await store.getFor(admin, "BS-1999")).toBeNull();
    expect(await store.findByEmail("nobody@example.com")).toBeNull();
    expect(await store.findByEmail("   ")).toBeNull();
  });

  it("finds by email case-insensitively", async () => {
    const { client } = fakeClient(seeded);
    expect((await createEmployeesStore(() => client).findByEmail("  Meera.Das@Example.com "))?.id).toBe("BS-1003");
  });
});

describe("employees-store unavailability", () => {
  const calls = (store: ReturnType<typeof createEmployeesStore>) => [
    () => store.listFor(admin), () => store.listFor(staff), () => store.getFor(admin, "BS-1001"), () => store.findByEmail("nadia.rahman@example.com"),
  ];

  it("throws EmployeesUnavailableError when the database returns an error", async () => {
    const { client } = fakeClient(seeded, "error");
    for (const call of calls(createEmployeesStore(() => client))) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("throws EmployeesUnavailableError on a network failure", async () => {
    const { client } = fakeClient(seeded, "throw");
    for (const call of calls(createEmployeesStore(() => client))) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });

  it("throws EmployeesUnavailableError when Supabase is not configured", async () => {
    const store = createEmployeesStore(() => { throw new Error("Supabase is not configured"); });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(EmployeesUnavailableError);
  });
});
