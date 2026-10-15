// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and
// employees (a per-run slot of BS-89xx, a range no other test uses), never the seeded demo data, and
// removes everything it created in afterAll through the service role.
// Rules under test (Story 7.1): the Administrator may insert an employee into any department; a manager
// only into a department in their subtree (their own or any descendant; not upwards, not an unrelated one); plain Staff never. Every
// inserted employee needs a department, and starts with no sign-in account link and not archived. A
// duplicate Employee ID or email is refused. employees-store.create agrees with RLS.
// Fails with 42P01 / PGRST205 until the departments migration is applied, 42703 until the
// department_managers migration is, 42883 until manager_scope is, and with 42501 on the inserts expected
// to succeed until the employee_create migration is.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmploymentHistoryStore } from "@/server/employment-history-store";
import { createEmployeesStore, EmployeeExistsError, EmployeeForbiddenError } from "@/server/employees-store";
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
const PREFIX = `RLS Create ${run}`;
// One per-run slot of eight consecutive ids (BS-8900..BS-8995).
const base = randomInt(0, 12) * 8;
const idAt = (offset: number) => `BS-89${String(base + offset).padStart(2, "0")}`;
const managerId = idAt(0);       // the child department's manager (linked Staff account, no department)
const staffId = idAt(1);         // plain Staff, manages nothing
const adminAdded = idAt(2);      // inserted by the Administrator into the unrelated department
const managerAdded = idAt(3);    // inserted by the manager into their own department
const storeAdded = idAt(4);      // inserted through employees-store by the manager
const spare = idAt(5);           // refused inserts only
const spare2 = idAt(6);          // refused inserts only
const grandchildAdded = idAt(7); // inserted by the manager into a sub-department of their own
const employeeIds = [managerId, staffId, adminAdded, managerAdded, storeAdded, spare, spare2, grandchildAdded];

const email = (employee_id: string) => `rls-create-${employee_id.toLowerCase()}-${run}@example.com`;
const newRow = (employee_id: string, department_id: string | null, extra: Record<string, unknown> = {}) => ({
  employee_id, name: `RLS Create ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: email(employee_id), joined_on: "2026-10-01", manager: "Test", office: "Test",
  status: "Available", initials: "RC", avatar_color: "mint", summary: "", department_id, ...extra,
});

describe.skipIf(!configured)("employee create RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-create-admin-${run}@example.com`;
  const managerEmail = `rls-create-mgr-${run}@example.com`;
  const staffEmail = `rls-create-staff-${run}@example.com`;
  let managerUserId = "";
  let parentId = "";
  let childId = "";
  let grandchildId = "";
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

  async function exists(id: string): Promise<boolean> {
    const { data, error } = await service.from("employees").select("employee_id").eq("employee_id", id);
    if (error) throw new Error(`Could not read test employee (${error.code}): ${error.message}`);
    return (data ?? []).length > 0;
  }

  /** employees-store as the app builds it, reading and writing through the given user's client. */
  function storeFor(client: SupabaseClient) {
    const userClient = async () => client;
    return createEmployeesStore({
      userClient,
      interviews: createInterviewsStore({ userClient }),
      training: createTrainingStore({ userClient, lms: createStubLmsClient({ userClient }) }),
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
    parentId = await insertDepartment(`${PREFIX} Parent`, null, null);
    childId = await insertDepartment(`${PREFIX} Child`, parentId, managerUserId);
    grandchildId = await insertDepartment(`${PREFIX} Grandchild`, childId, null);
    unrelatedId = await insertDepartment(`${PREFIX} Unrelated`, null, null);
    const employees = await service.from("employees").insert([
      newRow(managerId, null, { auth_user_id: managerUserId }),
      newRow(staffId, null, { auth_user_id: staffUserId }),
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

  it("lets the Administrator add an employee to any department", async () => {
    const admin = await signedIn(adminEmail);
    const { error } = await admin.from("employees").insert(newRow(adminAdded, unrelatedId));
    expect(error).toBeNull();
    expect(await exists(adminAdded)).toBe(true);
  });

  it("refuses the Administrator an employee without a department, or one already linked or archived", async () => {
    const admin = await signedIn(adminEmail);
    expect((await admin.from("employees").insert(newRow(spare, null))).error?.code).toBe("42501");
    expect((await admin.from("employees").insert(newRow(spare, childId, { auth_user_id: managerUserId }))).error?.code).toBe("42501");
    expect((await admin.from("employees").insert(newRow(spare, childId, { archived_at: "2026-10-01T00:00:00Z" }))).error?.code).toBe("42501");
    expect(await exists(spare)).toBe(false);
  });

  it("lets a manager add an employee to their own department", async () => {
    const manager = await signedIn(managerEmail);
    const { error } = await manager.from("employees").insert(newRow(managerAdded, childId));
    expect(error).toBeNull();
    expect(await exists(managerAdded)).toBe(true);
  });

  it("lets a manager add an employee to a sub-department of their own (the recursive subtree)", async () => {
    const manager = await signedIn(managerEmail);
    const { error } = await manager.from("employees").insert(newRow(grandchildAdded, grandchildId));
    expect(error).toBeNull();
    expect(await exists(grandchildAdded)).toBe(true);
  });

  it("refuses a manager a department outside their subtree (unrelated or upwards), or no department", async () => {
    const manager = await signedIn(managerEmail);
    expect((await manager.from("employees").insert(newRow(spare, unrelatedId))).error?.code).toBe("42501");
    expect((await manager.from("employees").insert(newRow(spare, parentId))).error?.code).toBe("42501");
    expect((await manager.from("employees").insert(newRow(spare, null))).error?.code).toBe("42501");
    expect(await exists(spare)).toBe(false);
  });

  it("refuses plain Staff", async () => {
    const staff = await signedIn(staffEmail);
    expect((await staff.from("employees").insert(newRow(spare, childId))).error?.code).toBe("42501");
    expect((await staff.from("employees").insert(newRow(spare, unrelatedId))).error?.code).toBe("42501");
    expect(await exists(spare)).toBe(false);
  });

  it("refuses a duplicate Employee ID (even one outside the manager's scope) and a duplicate email", async () => {
    const admin = await signedIn(adminEmail);
    const manager = await signedIn(managerEmail);
    const duplicateId = await admin.from("employees").insert({ ...newRow(managerAdded, unrelatedId), email: email(spare2) });
    expect(duplicateId.error?.code).toBe("23505");
    const outsideScope = await manager.from("employees").insert({ ...newRow(adminAdded, childId), email: email(spare2) });
    expect(outsideScope.error?.code).toBe("23505");
    const duplicateEmail = await admin.from("employees").insert({ ...newRow(spare2, childId), email: email(adminAdded) });
    expect(duplicateEmail.error?.code).toBe("23505");
    expect(await exists(spare2)).toBe(false);
  });

  it("agrees at the store: a manager adds within the subtree, is refused outside it, and duplicates are named", async () => {
    const store = storeFor(await signedIn(managerEmail));
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    const input = {
      employeeId: storeAdded, name: "RLS  Create Store", title: "Test", team: "Test", email: email(storeAdded).toUpperCase(),
      departmentId: childId, manager: "Test", office: "Test", employmentType: "Intern",
    };
    expect(await store.create(manager, input)).toEqual({ employeeId: storeAdded, name: "RLS Create Store" });
    const { data } = await service.from("employees")
      .select("email,status,initials,avatar_color,summary,department_id,auth_user_id,archived_at").eq("employee_id", storeAdded).single();
    expect(data).toMatchObject({
      email: email(storeAdded), status: "Available", initials: "RS", summary: "", department_id: childId, auth_user_id: null, archived_at: null,
    });
    await expect(store.create(manager, { ...input, employeeId: spare, email: email(spare), departmentId: unrelatedId }))
      .rejects.toBeInstanceOf(EmployeeForbiddenError);
    await expect(store.create(manager, { ...input, email: email(spare) })).rejects.toMatchObject({ name: "EmployeeExistsError", field: "employeeId" });
    await expect(store.create(manager, { ...input, employeeId: spare })).rejects.toBeInstanceOf(EmployeeExistsError);
    await expect(store.create(manager, { ...input, employeeId: spare })).rejects.toMatchObject({ field: "email" });
    expect(await exists(spare)).toBe(false);
  });
});
