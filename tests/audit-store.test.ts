import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AuditEmployeeNotFoundError, AuditUnavailableError, AuditValidationError, createAuditStore } from "@/server/audit-store";

const actorId = "11111111-1111-4111-8111-111111111111";
const valid = { actorId, employeeId: "BS-1001", from: "2026-09-01", to: "2026-09-30" };

function fakeClient(answer: { data: unknown; error: { message?: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("audit-store.recordActivityExport", () => {
  it("records one export through record_activity_export", async () => {
    const { client, rpc } = fakeClient({ data: 42, error: null });
    await createAuditStore(() => client).recordActivityExport(valid);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("record_activity_export", {
      p_actor: actorId, p_employee_id: "BS-1001", p_from: "2026-09-01", p_to: "2026-09-30",
    });
  });

  it.each([
    [{ ...valid, actorId: "not-a-uuid" }, ["actorId"]],
    [{ ...valid, employeeId: "1001" }, ["employeeId"]],
    [{ ...valid, from: "2026-02-30" }, ["from"]],
    [{ ...valid, from: "2026-10-01" }, ["to"]],
  ])("rejects %j without calling the database", async (input, fields) => {
    const { client, rpc } = fakeClient({ data: 1, error: null });
    const error = await createAuditStore(() => client).recordActivityExport(input).catch(e => e);
    expect(error).toBeInstanceOf(AuditValidationError);
    expect(error.fields).toEqual(fields);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps employee_not_found to AuditEmployeeNotFoundError", async () => {
    const { client } = fakeClient({ data: null, error: { message: "employee_not_found" } });
    await expect(createAuditStore(() => client).recordActivityExport(valid)).rejects.toBeInstanceOf(AuditEmployeeNotFoundError);
  });

  it.each([
    ["a database error", { data: null, error: { message: "permission denied" } }],
    ["no id returned", { data: null, error: null }],
    ["a network failure", new TypeError("fetch failed")],
  ] as const)("throws AuditUnavailableError on %s", async (_name, answer) => {
    const { client } = fakeClient(answer as never);
    await expect(createAuditStore(() => client).recordActivityExport(valid)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("throws AuditUnavailableError when Supabase is not configured", async () => {
    const store = createAuditStore(() => { throw new Error("Supabase is not configured"); });
    await expect(store.recordActivityExport(valid)).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

describe("audit-store.recordBulkActivityExport (Story 8.2)", () => {
  const bulk = { actorId, includeArchived: false, from: "2026-09-01", to: "2026-09-30" };

  it.each([false, true])("records one bulk export through record_bulk_activity_export (includeArchived %s)", async includeArchived => {
    const { client, rpc } = fakeClient({ data: 7, error: null });
    await createAuditStore(() => client).recordBulkActivityExport({ ...bulk, includeArchived });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("record_bulk_activity_export", {
      p_actor: actorId, p_include_archived: includeArchived, p_from: "2026-09-01", p_to: "2026-09-30",
    });
  });

  it.each([
    [{ ...bulk, actorId: "not-a-uuid" }, ["actorId"]],
    [{ ...bulk, includeArchived: "on" as unknown as boolean }, ["includeArchived"]],
    [{ ...bulk, to: "2026-13-01" }, ["to"]],
    [{ ...bulk, from: "2026-10-01" }, ["to"]],
  ])("rejects %j without calling the database", async (input, fields) => {
    const { client, rpc } = fakeClient({ data: 1, error: null });
    const error = await createAuditStore(() => client).recordBulkActivityExport(input).catch(e => e);
    expect(error).toBeInstanceOf(AuditValidationError);
    expect(error.fields).toEqual(fields);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["a database error", { data: null, error: { message: "invalid_period" } }],
    ["a missing function", { data: null, error: { message: "Could not find the function" } }],
    ["no id returned", { data: null, error: null }],
    ["a network failure", new TypeError("fetch failed")],
  ] as const)("throws AuditUnavailableError on %s", async (_name, answer) => {
    const { client } = fakeClient(answer as never);
    await expect(createAuditStore(() => client).recordBulkActivityExport(bulk)).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

describe("audit-store.recordDepartmentActivityExport (Story 8.3)", () => {
  const DEPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const DEPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const scoped = { actorId, departmentIds: [DEPT_A, DEPT_B], includeArchived: false, from: "2026-09-01", to: "2026-09-30" };

  it.each([false, true])("records one manager bulk export through record_department_activity_export (includeArchived %s)", async includeArchived => {
    const { client, rpc } = fakeClient({ data: 9, error: null });
    await createAuditStore(() => client).recordDepartmentActivityExport({ ...scoped, includeArchived });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("record_department_activity_export", {
      p_actor: actorId, p_department_ids: [DEPT_A, DEPT_B], p_include_archived: includeArchived, p_from: "2026-09-01", p_to: "2026-09-30",
    });
  });

  it.each([
    [{ ...scoped, actorId: "not-a-uuid" }, ["actorId"]],
    [{ ...scoped, departmentIds: [] }, ["departmentIds"]],
    [{ ...scoped, departmentIds: ["L&D"] }, ["departmentIds"]],
    [{ ...scoped, includeArchived: "on" as unknown as boolean }, ["includeArchived"]],
    [{ ...scoped, from: "2026-02-30" }, ["from"]],
    [{ ...scoped, from: "2026-10-01" }, ["to"]],
  ])("rejects %j without calling the database", async (input, fields) => {
    const { client, rpc } = fakeClient({ data: 1, error: null });
    const error = await createAuditStore(() => client).recordDepartmentActivityExport(input).catch(e => e);
    expect(error).toBeInstanceOf(AuditValidationError);
    expect(error.fields).toEqual(fields);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_scope", { data: null, error: { message: "invalid_scope" } }],
    ["invalid_period", { data: null, error: { message: "invalid_period" } }],
    ["a missing function", { data: null, error: { message: "Could not find the function" } }],
    ["no id returned", { data: null, error: null }],
    ["a network failure", new TypeError("fetch failed")],
  ] as const)("throws AuditUnavailableError on %s", async (_name, answer) => {
    const { client } = fakeClient(answer as never);
    await expect(createAuditStore(() => client).recordDepartmentActivityExport(scoped)).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

describe.skipIf(!configured)("activity export audit against the shared project", () => {
  const service = configured ? createClient(url!, serviceKey!, noSession) : (undefined as never);
  const run = randomBytes(4).toString("hex");
  // BS-9997: outside employees-rls.test.ts's BS-9900..BS-9995 slots and accounts-store.test.ts's BS-9998/BS-9999.
  const employeeId = "BS-9997";
  // A fresh actor id per run, so this run's audit rows are told apart from earlier runs' residue.
  const actor = randomUUID();

  afterAll(async () => {
    await service.from("employees").delete().eq("employee_id", employeeId);
  }, 30_000);

  const auditFor = async (by: string) => {
    const { data, error } = await service.from("audit_events").select("actor,target,action,period_from,period_to,occurred_at").eq("actor", by).order("id");
    expect(error).toBeNull();
    return data!;
  };

  it("writes exactly one export_activity row with the actor, the employee and the period; refuses unknown ids", async () => {
    await service.from("employees").delete().eq("employee_id", employeeId); // leftovers of an aborted run
    const { error: insertError } = await service.from("employees").insert({
      employee_id: employeeId, name: `Audit Test ${run}`, title: "Test", team: "Test", employment_type: "Permanent",
      email: `audit-export-${run}@example.test`, joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available",
      initials: "AT", avatar_color: "mint", summary: "Throwaway row created by tests/audit-store.test.ts.",
    });
    expect(insertError).toBeNull();

    const store = createAuditStore(() => service);
    await store.recordActivityExport({ actorId: actor, employeeId, from: "2026-09-01", to: "2026-09-30" });
    const rows = await auditFor(actor);
    expect(rows.map(r => [r.actor, r.target, r.action, r.period_from, r.period_to]))
      .toEqual([[actor, employeeId, "export_activity", "2026-09-01", "2026-09-30"]]);

    await expect(store.recordActivityExport({ actorId: actor, employeeId: "BS-0000", from: "2026-09-01", to: "2026-09-30" }))
      .rejects.toBeInstanceOf(AuditEmployeeNotFoundError);
    expect(await auditFor(actor)).toHaveLength(1);
  }, 30_000);

  it("is not callable by anon or authenticated users", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc("record_activity_export", { p_actor: actor, p_employee_id: employeeId, p_from: "2026-09-01", p_to: "2026-09-30" });
    expect(error).not.toBeNull();
    expect(await auditFor(actor)).toHaveLength(1);
  }, 30_000);
});

describe.skipIf(!configured)("bulk activity export audit against the shared project (Story 8.2)", () => {
  const service = configured ? createClient(url!, serviceKey!, noSession) : (undefined as never);
  // A fresh actor id per run, so this run's audit rows are told apart from earlier runs' residue.
  const actor = randomUUID();

  const auditFor = async (by: string) => {
    const { data, error } = await service.from("audit_events").select("actor,target,action,period_from,period_to").eq("actor", by).order("id");
    expect(error).toBeNull();
    return data!;
  };

  it("writes exactly one export_activity row per bulk export, targeting all-employees or all-employees+archived", async () => {
    const store = createAuditStore(() => service);
    await store.recordBulkActivityExport({ actorId: actor, includeArchived: false, from: "2026-09-01", to: "2026-09-30" });
    await store.recordBulkActivityExport({ actorId: actor, includeArchived: true, from: "2025-01-03", to: "2026-10-10" });
    expect((await auditFor(actor)).map(r => [r.actor, r.target, r.action, r.period_from, r.period_to])).toEqual([
      [actor, "all-employees", "export_activity", "2026-09-01", "2026-09-30"],
      [actor, "all-employees+archived", "export_activity", "2025-01-03", "2026-10-10"],
    ]);
  }, 30_000);

  it("refuses a reversed period and is not callable by anon users", async () => {
    const { error: reversed } = await service.rpc("record_bulk_activity_export", { p_actor: actor, p_include_archived: false, p_from: "2026-10-01", p_to: "2026-09-01" });
    expect(reversed?.message).toBe("invalid_period");
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc("record_bulk_activity_export", { p_actor: actor, p_include_archived: false, p_from: "2026-09-01", p_to: "2026-09-30" });
    expect(error).not.toBeNull();
    expect(await auditFor(actor)).toHaveLength(2);
  }, 30_000);
});

describe.skipIf(!configured)("department activity export audit against the shared project (Story 8.3)", () => {
  const service = configured ? createClient(url!, serviceKey!, noSession) : (undefined as never);
  // A fresh actor id per run, so this run's audit rows are told apart from earlier runs' residue.
  const actor = randomUUID();
  // Any uuids: the function records the scope as given, it does not look the departments up.
  const [first, second] = [randomUUID(), randomUUID()].sort();

  const auditFor = async (by: string) => {
    const { data, error } = await service.from("audit_events").select("actor,target,action,period_from,period_to").eq("actor", by).order("id");
    expect(error).toBeNull();
    return data!;
  };

  it("writes exactly one export_activity row per export, targeting the sorted department ids (+archived)", async () => {
    const store = createAuditStore(() => service);
    await store.recordDepartmentActivityExport({ actorId: actor, departmentIds: [second, first], includeArchived: false, from: "2026-09-01", to: "2026-09-30" });
    await store.recordDepartmentActivityExport({ actorId: actor, departmentIds: [first], includeArchived: true, from: "2025-01-03", to: "2026-10-10" });
    expect((await auditFor(actor)).map(r => [r.actor, r.target, r.action, r.period_from, r.period_to])).toEqual([
      [actor, `departments:${first},${second}`, "export_activity", "2026-09-01", "2026-09-30"],
      [actor, `departments:${first}+archived`, "export_activity", "2025-01-03", "2026-10-10"],
    ]);
  }, 30_000);

  it("refuses a reversed period or an empty scope, and is not callable by anon users", async () => {
    const args = { p_actor: actor, p_department_ids: [first], p_include_archived: false, p_from: "2026-09-01", p_to: "2026-09-30" };
    const { error: reversed } = await service.rpc("record_department_activity_export", { ...args, p_from: "2026-10-01" });
    expect(reversed?.message).toBe("invalid_period");
    const { error: empty } = await service.rpc("record_department_activity_export", { ...args, p_department_ids: [] });
    expect(empty?.message).toBe("invalid_scope");
    const { error: missing } = await service.rpc("record_department_activity_export", { ...args, p_department_ids: null });
    expect(missing?.message).toBe("invalid_scope");
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc("record_department_activity_export", args);
    expect(error).not.toBeNull();
    expect(await auditFor(actor)).toHaveLength(2);
  }, 30_000);
});
