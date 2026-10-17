import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AssessmentForbiddenError, AssessmentNotFoundError, AssessmentsUnavailableError, AssessmentValidationError, createAssessmentsStore,
  toEvaluation, toSkill, type EvaluationRow, type SkillRow,
} from "@/server/assessments-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import { many, pagedClient } from "./support/paged-client";

type Mode = "ok" | "error" | "throw" | "null";
type Call = { table: string; method: string; args: unknown[] };
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null } | "throw";

/** Stand-in for supabase-js: records every table call and rpc; applies eq/in filters to in-memory rows. */
function fakeClient(tables: { skills?: SkillRow[]; evaluations?: EvaluationRow[] } = {}, mode: Mode = "ok", rpcAnswer: RpcAnswer = { data: "Nadia Rahman", error: null }) {
  const calls: Call[][] = [];
  const rpcs: [string, Record<string, unknown>][] = [];
  const rowsOf = (table: string): Record<string, unknown>[] =>
    (table === "employee_skills" ? tables.skills ?? [] : table === "employee_evaluations" ? tables.evaluations ?? [] : []) as Record<string, unknown>[];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        if (mode === "error") return { data: null, error: { code: "PGRST205", message: "relation does not exist" } };
        if (mode === "null") return { data: null, error: null };
        const eqs = query.filter(c => c.method === "eq").map(c => c.args as [string, unknown]);
        const ins = query.filter(c => c.method === "in").map(c => c.args as [string, unknown[]]);
        return {
          data: rowsOf(table).filter(r => eqs.every(([col, val]) => r[col] === val) && ins.every(([col, vals]) => vals.includes(r[col]))),
          error: null,
        };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        in: (...args: unknown[]) => { record("in", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        range: (...args: unknown[]) => { record("range", args); return builder; },
        returns: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push([fn, args]);
      if (rpcAnswer === "throw") throw new TypeError("fetch failed");
      return rpcAnswer;
    },
  };
  return { client: client as unknown as SupabaseClient, calls, rpcs };
}

function fakeScope(ids: string[], fail?: Error) {
  const calls: unknown[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw fail;
      return { departmentIds: new Set(["d"]), employeeIds: new Set(ids) };
    },
  };
  return { scope, calls };
}

const skillRow = (employee_id: string, name: string, level: number, id = `${employee_id}-${name}`): SkillRow =>
  ({ id, employee_id, name, level, evidence: `Evidence for ${name}` });
const evaluationRow = (employee_id: string): EvaluationRow => ({
  employee_id, strengths: "Strong", development_priorities: "Grow", readiness: "Ready", reviewer: "Ayesha Karim · Administrator", reviewed_on: "2026-10-14",
});
const skills = [skillRow("BS-1001", "React", 4), skillRow("BS-1001", "Communication", 3), skillRow("BS-1002", "Python", 4), skillRow("BS-1003", "C#", 2)];
const evaluations = [evaluationRow("BS-1001"), evaluationRow("BS-1002"), evaluationRow("BS-1003")];

const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const manager = { role: "manager", employeeId: "BS-1099", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const storeFor = (client: SupabaseClient, scope: ManagerScope = fakeScope(["BS-1001", "BS-1002"]).scope) =>
  createAssessmentsStore({ userClient: async () => client, scope });

const SKILL_COLUMNS = "id,employee_id,name,level,evidence";
const EVALUATION_COLUMNS = "employee_id,strengths,development_priorities,readiness,reviewer,reviewed_on";
const rating = { name: "  React  Native ", level: 4, evidence: " Shipped   the app " };
const evaluation = { strengths: " Clear  reasoning ", developmentPriorities: "Present more", readiness: "Ready" };

describe("assessments-store mapping", () => {
  it("maps rows to entries", () => {
    expect(toSkill(skills[0])).toEqual({ employeeId: "BS-1001", name: "React", level: 4, evidence: "Evidence for React" });
    expect(toEvaluation(evaluations[0])).toEqual({
      employeeId: "BS-1001", strengths: "Strong", developmentPriorities: "Grow", readiness: "Ready",
      reviewer: "Ayesha Karim · Administrator", reviewedOn: "2026-10-14",
    });
  });
});

describe("assessments-store reads by role", () => {
  it("reads every skill and evaluation for an admin, skills strongest first per employee, without a filter", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const result = await storeFor(client).listFor(admin);
    expect(result.skills).toHaveLength(4);
    expect(result.evaluations).toHaveLength(3);
    const skillQuery = calls.find(q => q[0].table === "employee_skills")!;
    expect(skillQuery.map(c => [c.method, ...c.args])).toEqual([
      ["select", SKILL_COLUMNS],
      ["order", "employee_id"],
      ["order", "level", { ascending: false }],
      ["order", "name"],
      ["order", "id"],
      ["range", 0, 999],
    ]);
    const evaluationQuery = calls.find(q => q[0].table === "employee_evaluations")!;
    expect(evaluationQuery.map(c => [c.method, ...c.args])).toEqual([["select", EVALUATION_COLUMNS], ["order", "employee_id"], ["range", 0, 999]]);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const result = await storeFor(client).listFor(admin, "BS-1002");
    expect(result.skills.map(s => s.name)).toEqual(["Python"]);
    expect(result.evaluations.map(e => e.employeeId)).toEqual(["BS-1002"]);
    for (const query of calls) expect(query).toContainEqual(expect.objectContaining({ method: "eq", args: ["employee_id", "BS-1002"] }));
  });

  it("reads only the staff member's own rows, filtering in the query", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const store = storeFor(client);
    for (const result of [await store.listFor(staff), await store.listFor(staff, "BS-1001")]) {
      expect(result.skills.map(s => s.employeeId)).toEqual(["BS-1001", "BS-1001"]);
      expect(result.evaluations.map(e => e.employeeId)).toEqual(["BS-1001"]);
    }
    for (const query of calls) expect(query).toContainEqual(expect.objectContaining({ method: "eq", args: ["employee_id", "BS-1001"] }));
  });

  it("returns nothing, without a query, when staff ask for another employee", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    expect(await storeFor(client).listFor(staff, "BS-1002")).toEqual({ skills: [], evaluations: [] });
    expect(calls).toHaveLength(0);
  });

  it("never hands staff another employee's row, even if the database returned one", async () => {
    const { client } = fakeClient({ skills, evaluations });
    const leaky = {
      from: (table: string) => { const b = client.from(table) as unknown as Record<string, unknown>; b.eq = () => b; return b; },
    } as unknown as SupabaseClient;
    const result = await storeFor(leaky).listFor(staff);
    expect(result.skills.every(s => s.employeeId === "BS-1001")).toBe(true);
    expect(result.evaluations.map(e => e.employeeId)).toEqual(["BS-1001"]);
  });

  it("reads only a manager's subtree, filtering in the query", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const result = await storeFor(client, fakeScope(["BS-1001", "BS-1002"]).scope).listFor(manager);
    expect(result.skills.map(s => s.employeeId)).toEqual(["BS-1001", "BS-1001", "BS-1002"]);
    expect(result.evaluations.map(e => e.employeeId)).toEqual(["BS-1001", "BS-1002"]);
    for (const query of calls) expect(query).toContainEqual(expect.objectContaining({ method: "in", args: ["employee_id", ["BS-1001", "BS-1002"]] }));
  });

  it("narrows a manager to one in-scope employee, and returns nothing without a query outside the scope", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const store = storeFor(client, fakeScope(["BS-1001"]).scope);
    expect((await store.listFor(manager, "BS-1001")).skills.map(s => s.name)).toEqual(["React", "Communication"]);
    calls.length = 0;
    expect(await store.listFor(manager, "BS-1003")).toEqual({ skills: [], evaluations: [] });
    expect(await storeFor(client, fakeScope([]).scope).listFor(manager)).toEqual({ skills: [], evaluations: [] });
    expect(calls).toHaveLength(0);
  });

  it("never hands a manager a row outside the scope, even if the database returned one", async () => {
    const { client } = fakeClient({ skills, evaluations });
    const leaky = {
      from: (table: string) => { const b = client.from(table) as unknown as Record<string, unknown>; b.in = () => b; return b; },
    } as unknown as SupabaseClient;
    const result = await storeFor(leaky, fakeScope(["BS-1001", "BS-1002"]).scope).listFor(manager);
    expect(result.skills.some(s => s.employeeId === "BS-1003")).toBe(false);
    expect(result.evaluations.some(e => e.employeeId === "BS-1003")).toBe(false);
  });

  it("is unavailable when a manager's scope cannot be read, without a query", async () => {
    const { client, calls } = fakeClient({ skills, evaluations });
    const store = storeFor(client, fakeScope([], new ManagerScopeUnavailableError()).scope);
    await expect(store.listFor(manager)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
    await expect(store.listFor(manager, "BS-1001")).rejects.toBeInstanceOf(AssessmentsUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("never asks the scope for Administrator or Staff reads", async () => {
    const { client } = fakeClient({ skills, evaluations });
    const scope = fakeScope(["BS-1001"]);
    await storeFor(client, scope.scope).listFor(admin);
    await storeFor(client, scope.scope).listFor(staff);
    expect(scope.calls).toEqual([]);
  });

  for (const mode of ["error", "throw", "null"] as const) {
    it(`throws AssessmentsUnavailableError (never "no assessments") when the read fails (${mode})`, async () => {
      const { client } = fakeClient({ skills, evaluations }, mode);
      const store = storeFor(client);
      for (const call of [() => store.listFor(admin), () => store.listFor(staff), () => store.listFor(manager)]) {
        await expect(call()).rejects.toBeInstanceOf(AssessmentsUnavailableError);
      }
    });
  }

  it("throws AssessmentsUnavailableError when the user client cannot be created", async () => {
    const store = createAssessmentsStore({ userClient: async () => { throw new Error("Supabase is not configured"); }, scope: fakeScope(["BS-1001"]).scope });
    await expect(store.listFor(admin)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
  });
});

describe("assessments-store paging", () => {
  it("reads skills in 1000-row pages until a short page", async () => {
    const row = (i: number) => skillRow("BS-1001", `Skill ${i}`, 3, `id-${i}`);
    // Requests alternate between the two tables as Promise.all starts them: skills page 1, evaluations, skills pages 2 and 3.
    const { client, ranges } = pagedClient<unknown>([many(1000, row), [], many(1000, row, 1000), many(2, row, 2000)]);
    const result = await storeFor(client).listFor(admin);
    expect(result.skills).toHaveLength(2002);
    expect(ranges).toContainEqual([2000, 2999]);
  });

  it("throws the unavailable error when a later page fails, never a partial list", async () => {
    const row = (i: number) => skillRow("BS-1001", `Skill ${i}`, 3, `id-${i}`);
    const { client } = pagedClient<unknown>([many(1000, row), [], "error"]);
    await expect(storeFor(client).listFor(admin)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
  });
});

describe("assessments-store writes", () => {
  it("rates a skill for an admin through the function, with the normalised values, and returns the name", async () => {
    const { client, rpcs, calls } = fakeClient();
    expect(await storeFor(client).rateSkill(admin, "BS-1001", rating)).toEqual({ employeeId: "BS-1001", name: "Nadia Rahman" });
    expect(rpcs).toEqual([["rate_employee_skill", { p_employee_id: "BS-1001", p_name: "React Native", p_level: 4, p_evidence: "Shipped the app" }]]);
    // Never a direct table write.
    expect(calls).toHaveLength(0);
  });

  it("saves an evaluation through the function, sending only the three texts (never a reviewer or date)", async () => {
    const { client, rpcs } = fakeClient();
    expect(await storeFor(client).saveEvaluation(admin, "BS-1001", evaluation)).toEqual({ employeeId: "BS-1001", name: "Nadia Rahman" });
    expect(rpcs).toEqual([["update_employee_evaluation", {
      p_employee_id: "BS-1001", p_strengths: "Clear reasoning", p_development_priorities: "Present more", p_readiness: "Ready",
    }]]);
  });

  it("lets a manager write within the subtree, checking the scope fresh each time", async () => {
    const { client, rpcs } = fakeClient();
    const scope = fakeScope(["BS-1001"]);
    const store = storeFor(client, scope.scope);
    await store.rateSkill(manager, "BS-1001", rating);
    await store.saveEvaluation(manager, "BS-1001", evaluation);
    expect(rpcs.map(r => r[0])).toEqual(["rate_employee_skill", "update_employee_evaluation"]);
    expect(scope.calls).toHaveLength(2);
  });

  it("refuses Staff, even on their own record, without an rpc", async () => {
    const { client, rpcs } = fakeClient();
    const store = storeFor(client);
    await expect(store.rateSkill(staff, "BS-1001", rating)).rejects.toBeInstanceOf(AssessmentForbiddenError);
    await expect(store.saveEvaluation(staff, "BS-1001", evaluation)).rejects.toBeInstanceOf(AssessmentForbiddenError);
    expect(rpcs).toEqual([]);
  });

  it("refuses a manager outside the subtree without an rpc", async () => {
    const { client, rpcs } = fakeClient();
    const store = storeFor(client, fakeScope(["BS-1001"]).scope);
    await expect(store.rateSkill(manager, "BS-1003", rating)).rejects.toBeInstanceOf(AssessmentForbiddenError);
    await expect(store.saveEvaluation(manager, "BS-1003", evaluation)).rejects.toBeInstanceOf(AssessmentForbiddenError);
    expect(rpcs).toEqual([]);
  });

  it("is unavailable, without an rpc, when a manager's scope cannot be read", async () => {
    const { client, rpcs } = fakeClient();
    const store = storeFor(client, fakeScope([], new ManagerScopeUnavailableError()).scope);
    await expect(store.rateSkill(manager, "BS-1001", rating)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
    expect(rpcs).toEqual([]);
  });

  it.each([
    [{ ...rating, level: 0 }, ["level"]], [{ ...rating, level: 6 }, ["level"]], [{ ...rating, level: 3.5 }, ["level"]],
    [{ ...rating, name: "  " }, ["name"]], [{ ...rating, evidence: "" }, ["evidence"]], [{ ...rating, name: "x".repeat(81) }, ["name"]],
  ])("refuses an invalid rating (%o) without an rpc", async (input, fields) => {
    const { client, rpcs } = fakeClient();
    await expect(storeFor(client).rateSkill(admin, "BS-1001", input)).rejects.toMatchObject({ name: "AssessmentValidationError", fields });
    expect(rpcs).toEqual([]);
  });

  it("refuses an invalid evaluation without an rpc", async () => {
    const { client, rpcs } = fakeClient();
    const store = storeFor(client);
    await expect(store.saveEvaluation(admin, "BS-1001", { ...evaluation, strengths: " " })).rejects.toMatchObject({ fields: ["strengths"] });
    await expect(store.saveEvaluation(admin, "BS-1001", { ...evaluation, readiness: "r".repeat(121) })).rejects.toMatchObject({ fields: ["readiness"] });
    await expect(store.saveEvaluation(admin, "BS-1001", { ...evaluation, developmentPriorities: "d".repeat(1001) })).rejects.toBeInstanceOf(AssessmentValidationError);
    expect(rpcs).toEqual([]);
  });

  it.each([
    ["not_authorized", AssessmentForbiddenError],
    ["employee_not_found", AssessmentNotFoundError],
    ["permission denied for function", AssessmentsUnavailableError],
    ["Could not find the function public.rate_employee_skill", AssessmentsUnavailableError],
  ] as const)("maps the function refusal %s", async (message, type) => {
    const { client } = fakeClient({}, "ok", { data: null, error: { code: "P0001", message } });
    const store = storeFor(client);
    await expect(store.rateSkill(admin, "BS-1001", rating)).rejects.toBeInstanceOf(type);
    await expect(store.saveEvaluation(admin, "BS-1001", evaluation)).rejects.toBeInstanceOf(type);
  });

  it("maps invalid_input to a validation error without a field", async () => {
    const { client } = fakeClient({}, "ok", { data: null, error: { code: "P0001", message: "invalid_input" } });
    await expect(storeFor(client).rateSkill(admin, "BS-1001", rating)).rejects.toMatchObject({ name: "AssessmentValidationError", fields: ["input"] });
  });

  it("is unavailable when the rpc throws or returns no name", async () => {
    const thrown = fakeClient({}, "ok", "throw");
    await expect(storeFor(thrown.client).rateSkill(admin, "BS-1001", rating)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
    const empty = fakeClient({}, "ok", { data: null, error: null });
    await expect(storeFor(empty.client).saveEvaluation(admin, "BS-1001", evaluation)).rejects.toBeInstanceOf(AssessmentsUnavailableError);
  });

  it("has no removal path", () => {
    const { client } = fakeClient();
    expect(Object.keys(storeFor(client)).sort()).toEqual(["listFor", "rateSkill", "saveEvaluation"]);
  });
});
