// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and
// employees (a per-run slot of BS-8700..BS-8747, a range no other test uses; the Story 7.2 e2e uses
// BS-8750..BS-8799), never the seeded demo data, and removes everything it created in afterAll through
// the service role.
// Rules under test (Story 7.2): public.update_employee_details lets the Administrator edit anyone's basic
// details and a department manager those of employees in their subtree; it changes only title, team,
// manager, office and employment_type (never department_id or any other column). Staff (even on their
// own record), a manager outside their subtree and a caller whose own row is archived get
// not_authorized; bad values get invalid_input; an unknown id employee_not_found. There is still no
// update policy on employees, so a direct table update changes 0 rows. employees-store agrees.
// Fails with 42P01 / PGRST205 until the departments migration is applied, 42703 until the
// department_managers migration is, 42883 until manager_scope is, and PGRST202 until
// employee_details_update is.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmploymentHistoryStore } from "@/server/employment-history-store";
import { createEmployeesStore, EmployeeForbiddenError } from "@/server/employees-store";
import { createAssessmentsStore } from "@/server/assessments-store";
import { createAssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import { createAssignmentsStore } from "@/server/assignments-store";
import { createBackfilledProjectStore } from "@/server/backfilled-project-store";
import { createInterviewsStore } from "@/server/interviews-store";
import { createManagerScope } from "@/server/manager-scope";
import { createTrainingStore } from "@/server/training-store";
import { createStubLmsClient } from "@/server/lms-client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Details ${run}`;
// One per-run slot of six consecutive ids (BS-8700..BS-8747).
const base = randomInt(0, 8) * 6;
const idAt = (offset: number) => `BS-87${String(base + offset).padStart(2, "0")}`;
const managerId = idAt(0);         // manager of P (linked Staff account, no department)
const staffId = idAt(1);           // plain Staff in C, manages nothing
const childEmployee = idAt(2);     // in C (inside the P manager's subtree)
const unrelatedEmployee = idAt(3); // in U (outside it)
const archivedManagerId = idAt(4); // manager of C, own row archived
const missing = idAt(5);           // never inserted
const employeeIds = [managerId, staffId, childEmployee, unrelatedEmployee, archivedManagerId, missing];

const row = (employee_id: string, department_id: string | null, extra: Record<string, unknown> = {}) => ({
  employee_id, name: `RLS Details ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-details-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-10-01", manager: "Test", office: "Test",
  status: "Available", initials: "RD", avatar_color: "mint", summary: "Unchanged summary", department_id, ...extra,
});

const ALL_COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary,department_id,auth_user_id,archived_at";

const args = (employeeId: string, extra: Record<string, string> = {}) => ({
  p_employee_id: employeeId, p_title: "Edited Title", p_team: "Edited Team", p_manager: "Edited Manager", p_office: "Edited Office",
  p_employment_type: "Intern", ...extra,
});

describe.skipIf(!configured)("employee details update (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-details-admin-${run}@example.com`;
  const managerEmail = `rls-details-mgr-${run}@example.com`;
  const staffEmail = `rls-details-staff-${run}@example.com`;
  const archivedEmail = `rls-details-archived-${run}@example.com`;
  let managerUserId = "";
  let childId = "";
  let unrelatedId = "";

  async function createUser(address: string, app_metadata: Record<string, string>) {
    const { data, error } = await service.auth.admin.createUser({ email: address, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  // One sign-in per test user per file (Supabase Auth rate-limits sign-ins per IP).
  const sessions = new Map<string, Promise<SupabaseClient>>();
  function signedIn(address: string): Promise<SupabaseClient> {
    let session = sessions.get(address);
    if (!session) {
      session = (async () => {
        const client = createClient(url!, anonKey!, noSession);
        const { error } = await client.auth.signInWithPassword({ email: address, password });
        if (error) throw new Error(`Could not sign in test user: ${error.message}`);
        return client;
      })();
      sessions.set(address, session);
    }
    return session;
  }

  async function cleanup() {
    const deleted = await service.from("employees").delete().in("employee_id", employeeIds);
    if (deleted.error) throw new Error(`Could not delete test employees (${deleted.error.code}): ${deleted.error.message}`);
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const removed = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (removed.error) throw new Error(`Could not delete test departments (${removed.error.code}): ${removed.error.message}`);
  }

  async function insertDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  async function read(id: string): Promise<Record<string, unknown>> {
    const { data, error } = await service.from("employees").select(ALL_COLUMNS).eq("employee_id", id).single();
    if (error) throw new Error(`Could not read test employee (${error.code}): ${error.message}`);
    return data as Record<string, unknown>;
  }

  async function reset(id: string, department_id: string) {
    const { error } = await service.from("employees").update({
      title: "Test", team: "Test", manager: "Test", office: "Test", employment_type: "Permanent", department_id,
    }).eq("employee_id", id);
    if (error) throw new Error(`Could not reset test employee (${error.code}): ${error.message}`);
  }

  /** employees-store as the app builds it, through the given user's client. */
  function storeFor(client: SupabaseClient) {
    const userClient = async () => client;
    return createEmployeesStore({
      userClient,
      interviews: createInterviewsStore({ userClient }),
      training: createTrainingStore({ userClient, lms: createStubLmsClient({ userClient }) }),
      assessments: createAssessmentsStore({ userClient }),
      // Epic 4 merge: the store also reads assignments (4.5), their evaluations (4.6) and backfilled projects (4.7);
      // Story 7.3 merge: and employment history.
      assignments: createAssignmentsStore({ userClient, scope: createManagerScope({ userClient }) }),
      evaluations: createAssignmentEvaluationsStore({ userClient, scope: createManagerScope({ userClient }) }),
      backfilled: createBackfilledProjectStore({ userClient, scope: createManagerScope({ userClient }) }),
      history: createEmploymentHistoryStore({ userClient, scope: createManagerScope({ userClient }) }),
      scope: createManagerScope({ userClient }),
    });
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run in the same slot
    await createUser(adminEmail, { role: "admin" });
    managerUserId = await createUser(managerEmail, { role: "staff", employee_id: managerId });
    const staffUserId = await createUser(staffEmail, { role: "staff", employee_id: staffId });
    const archivedUserId = await createUser(archivedEmail, { role: "staff", employee_id: archivedManagerId });
    const parentId = await insertDepartment(`${PREFIX} Parent`, null, managerUserId);
    childId = await insertDepartment(`${PREFIX} Child`, parentId, archivedUserId);
    unrelatedId = await insertDepartment(`${PREFIX} Unrelated`, null, null);
    const employees = await service.from("employees").insert([
      row(managerId, null, { auth_user_id: managerUserId }),
      row(staffId, childId, { auth_user_id: staffUserId }),
      row(childEmployee, childId),
      row(unrelatedEmployee, unrelatedId),
      row(archivedManagerId, null, { auth_user_id: archivedUserId, archived_at: "2026-10-01T00:00:00Z" }),
    ], { defaultToNull: false });
    if (employees.error) throw new Error(`Could not insert test employees (${employees.error.code}): ${employees.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the Administrator change the five fields of anyone, and nothing else", async () => {
    await reset(childEmployee, childId);
    const before = await read(childEmployee);
    const admin = await signedIn(adminEmail);
    const { data, error } = await admin.rpc("update_employee_details", args(childEmployee, { p_title: "  Edited   Title " }));
    expect(error).toBeNull();
    expect(data).toBe(`RLS Details ${childEmployee}`);
    expect(await read(childEmployee)).toEqual({
      ...before, title: "Edited Title", team: "Edited Team", manager: "Edited Manager", office: "Edited Office", employment_type: "Intern",
    });
  });

  it("lets the P manager change the five fields of an employee in C, leaving the department alone", async () => {
    await reset(childEmployee, childId);
    const before = await read(childEmployee);
    const manager = await signedIn(managerEmail);
    const { error } = await manager.rpc("update_employee_details", args(childEmployee, { p_employment_type: "Trainee" }));
    expect(error).toBeNull();
    const after = await read(childEmployee);
    expect(after).toEqual({
      ...before, title: "Edited Title", team: "Edited Team", manager: "Edited Manager", office: "Edited Office", employment_type: "Trainee",
    });
    expect(after.department_id).toBe(childId);
  });

  it("refuses the P manager an employee outside the subtree, without changing it", async () => {
    const before = await read(unrelatedEmployee);
    const manager = await signedIn(managerEmail);
    const { error } = await manager.rpc("update_employee_details", args(unrelatedEmployee));
    expect(error?.message).toBe("not_authorized");
    // An id that does not exist looks the same to a non-admin: nothing is learned about ids outside scope.
    expect((await manager.rpc("update_employee_details", args(missing))).error?.message).toBe("not_authorized");
    expect(await read(unrelatedEmployee)).toEqual(before);
  });

  it("refuses plain Staff, even on their own record", async () => {
    const before = await read(staffId);
    const staff = await signedIn(staffEmail);
    expect((await staff.rpc("update_employee_details", args(staffId))).error?.message).toBe("not_authorized");
    expect((await staff.rpc("update_employee_details", args(childEmployee))).error?.message).toBe("not_authorized");
    expect(await read(staffId)).toEqual(before);
  });

  it("refuses a manager whose own employee row is archived", async () => {
    const before = await read(childEmployee);
    const archived = await signedIn(archivedEmail);
    expect((await archived.rpc("update_employee_details", args(childEmployee))).error?.message).toBe("not_authorized");
    expect(await read(childEmployee)).toEqual(before);
  });

  it("refuses invalid values and reports an unknown employee to the Administrator", async () => {
    const before = await read(childEmployee);
    const admin = await signedIn(adminEmail);
    expect((await admin.rpc("update_employee_details", args(childEmployee, { p_title: "   " }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("update_employee_details", args(childEmployee, { p_employment_type: "Contractor" }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("update_employee_details", args(childEmployee, { p_office: "x".repeat(121) }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("update_employee_details", args(missing))).error?.message).toBe("employee_not_found");
    expect(await read(childEmployee)).toEqual(before);
  });

  it("still has no update policy: a direct table update through a manager or admin JWT changes 0 rows", async () => {
    await reset(childEmployee, childId);
    const before = await read(childEmployee);
    for (const address of [managerEmail, adminEmail]) {
      const client = await signedIn(address);
      const department = await client.from("employees").update({ department_id: unrelatedId }).eq("employee_id", childEmployee).select("employee_id");
      expect(department.data ?? []).toHaveLength(0);
      const title = await client.from("employees").update({ title: "Direct" }).eq("employee_id", childEmployee).select("employee_id");
      expect(title.data ?? []).toHaveLength(0);
    }
    expect(await read(childEmployee)).toEqual(before);
  });

  it("refuses anon", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc("update_employee_details", args(childEmployee));
    expect(error?.code).toBe("42501");
  });

  it("agrees at the store: the manager saves within the subtree and is refused outside it", async () => {
    const store = storeFor(await signedIn(managerEmail));
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    const input = { title: "Store  Title", team: "Store Team", manager: "Store Manager", office: "Store Office", employmentType: "Permanent" };
    expect(await store.updateDetails(manager, childEmployee, input)).toEqual({ employeeId: childEmployee, name: `RLS Details ${childEmployee}` });
    expect(await read(childEmployee)).toMatchObject({ title: "Store Title", office: "Store Office", department_id: childId });
    await expect(store.updateDetails(manager, unrelatedEmployee, input)).rejects.toBeInstanceOf(EmployeeForbiddenError);
  });
});
