import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { DepartmentHierarchyError } from "@/domain/departments";
import { createManagerScope, ManagerScopeUnavailableError } from "@/server/manager-scope";

type DeptRow = { id: string; parent_department_id: string | null; manager_user_id: string | null };
type EmpRow = { employee_id: string; department_id: string | null };
type Options = { throws?: boolean; departmentsError?: boolean; employeesError?: boolean; ignoreIn?: boolean };

/** Minimal stand-in for the supabase-js query builder over departments and employees; records each query. */
function fakeClient(departments: DeptRow[], employees: EmpRow[], options: Options = {}) {
  const queries: { table: string; columns?: string; within?: [string, unknown[]]; range?: [number, number] }[] = [];
  const client = {
    from(table: string) {
      if (options.throws) throw new TypeError("fetch failed");
      const query: { table: string; columns?: string; within?: [string, unknown[]]; range?: [number, number] } = { table };
      queries.push(query);
      const result = () => {
        if (table === "departments" && options.departmentsError) return { data: null, error: { code: "08006", message: "down" } };
        if (table === "employees" && options.employeesError) return { data: null, error: { code: "08006", message: "down" } };
        const rows = (table === "departments" ? departments : employees) as Record<string, unknown>[];
        const within = query.within;
        const matched = within && !options.ignoreIn ? rows.filter(r => within[1].includes(r[within[0]])) : rows;
        return { data: query.range ? matched.slice(query.range[0], query.range[1] + 1) : matched, error: null };
      };
      const builder = {
        select: (columns: string) => { query.columns = columns; return builder; },
        in: (col: string, vals: unknown[]) => { query.within = [col, vals]; return builder; },
        order: () => builder,
        range: (from: number, to: number) => { query.range = [from, to]; return builder; },
        returns: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const LND = "lnd", CRD = "crd", QA = "qa", OPS = "ops";
const departments: DeptRow[] = [
  { id: LND, parent_department_id: null, manager_user_id: "u-lnd" },
  { id: CRD, parent_department_id: LND, manager_user_id: "u-crd" },
  { id: QA, parent_department_id: CRD, manager_user_id: null },
  { id: OPS, parent_department_id: null, manager_user_id: "u-ops" },
];
const employees: EmpRow[] = [
  { employee_id: "BS-1001", department_id: LND },
  { employee_id: "BS-1002", department_id: CRD },
  { employee_id: "BS-1003", department_id: QA },
  { employee_id: "BS-1004", department_id: OPS },
  { employee_id: "BS-1005", department_id: null },
];
const managerOf = (userId: string) => ({ role: "manager", employeeId: "BS-1099", userId } as const);
const scopeFor = (client: SupabaseClient) => createManagerScope({ userClient: async () => client });
const sorted = (set: Set<string>) => [...set].sort();

describe("manager-scope forManager", () => {
  it("covers the managed department and every sub-department, and their employees", async () => {
    const { client, queries } = fakeClient(departments, employees);
    const scope = await scopeFor(client).forManager(managerOf("u-lnd"));
    expect(sorted(scope.departmentIds)).toEqual([CRD, LND, QA]);
    expect(sorted(scope.employeeIds)).toEqual(["BS-1001", "BS-1002", "BS-1003"]);
    expect(queries.map(q => [q.table, q.columns])).toEqual([
      ["departments", "id,parent_department_id,manager_user_id"],
      ["employees", "employee_id,department_id"],
    ]);
    expect(queries[1].within?.[0]).toBe("department_id");
  });

  it("never reaches upwards: a child department's manager gets the child subtree only", async () => {
    const { client } = fakeClient(departments, employees);
    const scope = await scopeFor(client).forManager(managerOf("u-crd"));
    expect(sorted(scope.departmentIds)).toEqual([CRD, QA]);
    expect(sorted(scope.employeeIds)).toEqual(["BS-1002", "BS-1003"]);
  });

  it("works from the partial list a manager's RLS returns (ancestors not visible)", async () => {
    const { client } = fakeClient(departments.filter(d => d.id === CRD || d.id === QA), employees);
    const scope = await scopeFor(client).forManager(managerOf("u-crd"));
    expect(sorted(scope.departmentIds)).toEqual([CRD, QA]);
  });

  it("is empty, without an employees query, when the user manages nothing (e.g. just unassigned)", async () => {
    const { client, queries } = fakeClient(departments, employees);
    const scope = await scopeFor(client).forManager(managerOf("u-nobody"));
    expect(scope.departmentIds.size).toBe(0);
    expect(scope.employeeIds.size).toBe(0);
    expect(queries.map(q => q.table)).toEqual(["departments"]);
  });

  it("keeps only employees whose department is in scope, whatever the query returned", async () => {
    const { client } = fakeClient(departments, employees, { ignoreIn: true });
    const scope = await scopeFor(client).forManager(managerOf("u-crd"));
    expect(sorted(scope.employeeIds)).toEqual(["BS-1002", "BS-1003"]);
  });

  it("computes the scope fresh on every call (never cached)", async () => {
    const rows = structuredClone(departments);
    const { client, queries } = fakeClient(rows, employees);
    const scope = scopeFor(client);
    expect(sorted((await scope.forManager(managerOf("u-ops"))).departmentIds)).toEqual([OPS]);
    rows[3].manager_user_id = null;
    expect((await scope.forManager(managerOf("u-ops"))).departmentIds.size).toBe(0);
    expect(queries.filter(q => q.table === "departments")).toHaveLength(2);
  });

  it("throws ManagerScopeUnavailableError when a read fails, never a partial scope", async () => {
    for (const options of [{ throws: true }, { departmentsError: true }, { employeesError: true }]) {
      const { client } = fakeClient(departments, employees, options);
      await expect(scopeFor(client).forManager(managerOf("u-lnd"))).rejects.toBeInstanceOf(ManagerScopeUnavailableError);
    }
    const unconfigured = createManagerScope({ userClient: async () => { throw new Error("Supabase is not configured"); } });
    await expect(unconfigured.forManager(managerOf("u-lnd"))).rejects.toBeInstanceOf(ManagerScopeUnavailableError);
  });

  it("throws ManagerScopeUnavailableError (caused by DepartmentHierarchyError) when the stored hierarchy loops", async () => {
    const looped: DeptRow[] = [
      { id: "a", parent_department_id: "b", manager_user_id: "u-a" },
      { id: "b", parent_department_id: "a", manager_user_id: null },
    ];
    const { client } = fakeClient(looped, employees);
    const error = await scopeFor(client).forManager(managerOf("u-a")).catch(e => e);
    expect(error).toBeInstanceOf(ManagerScopeUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(DepartmentHierarchyError);
  });
});

describe("manager-scope paging (Story 8.2)", () => {
  it("pages departments and employees past 1000 rows, so the scope is never truncated", async () => {
    const depts: DeptRow[] = Array.from({ length: 1002 }, (_, i) => ({ id: `d-${i}`, parent_department_id: i === 0 ? null : "d-0", manager_user_id: i === 0 ? "u-root" : null }));
    // The managed root is the last row: it is only on the second page.
    depts.reverse();
    const emps: EmpRow[] = Array.from({ length: 1500 }, (_, i) => ({ employee_id: `BS-${i}`, department_id: `d-${i % 1002}` }));
    const { client, queries } = fakeClient(depts, emps);
    const scope = await scopeFor(client).forManager(managerOf("u-root"));
    expect(scope.departmentIds.size).toBe(1002);
    expect(scope.employeeIds.size).toBe(1500);
    expect(queries.map(q => [q.table, q.range])).toEqual([
      ["departments", [0, 999]], ["departments", [1000, 1999]], ["employees", [0, 999]], ["employees", [1000, 1999]],
    ]);
  });
});
