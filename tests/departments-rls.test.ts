// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and departments (names carrying this run's id), never
// the seeded L&D / Central R&D rows, and removes everything it created in afterAll through the service
// role (children first: parent_department_id is ON DELETE RESTRICT).
// Rules under test (Story 4.1): only Administrators read, add or change departments; nobody deletes
// them through the API; names are unique case-insensitively; no department can be its own parent or
// ancestor (check constraint + cycle trigger), and departments-store maps those refusals.
// Story 4.2 adds department managers: a signed-in user reads only the departments they manage (besides
// Administrators, who read all); only Administrators set or clear manager_user_id; the store resolves a
// manager from an employee's linked, non-archived account. Throwaway employees use BS-93xx (a range no
// other test uses).
// Fails with 42P01 / PGRST205 until the departments migration is applied to the shared project, and with
// 42703 until the department_managers migration is.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDepartmentsStore, DepartmentCycleError, DepartmentNameTakenError, DepartmentsForbiddenError, ManagerArchivedError,
  ManagerHasNoAccountError,
} from "@/server/departments-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Dept ${run}`;
const admin = { role: "admin" } as const;
// One per-run slot of three consecutive ids (BS-9300..BS-9398): the manager (linked), unlinked, archived.
const base = randomInt(0, 33) * 3;
const idAt = (offset: number) => `BS-93${String(base + offset).padStart(2, "0")}`;
const managerEmployeeId = idAt(0);
const unlinkedEmployeeId = idAt(1);
const archivedEmployeeId = idAt(2);
const employeeIds = [managerEmployeeId, unlinkedEmployeeId, archivedEmployeeId];
const employeeRow = (employee_id: string, auth_user_id: string | null, archived_at: string | null = null) => ({
  employee_id, name: `RLS Dept ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-dept-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RD", avatar_color: "mint", summary: "Throwaway row created by tests/departments-rls.test.ts.",
  auth_user_id, archived_at,
});
const none = { managerUserId: null, managerEmployeeId: null };

describe.skipIf(!configured)("departments RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-dept-admin-${run}@example.com`;
  const staffEmail = `rls-dept-staff-${run}@example.com`;
  const managerEmail = `rls-dept-manager-${run}@example.com`;
  const archivedEmail = `rls-dept-archived-${run}@example.com`;
  let managerUserId = "";
  let archivedUserId = "";
  let parentId = "";
  let childId = "";

  async function createUser(email: string, app_metadata: Record<string, string>) {
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  // One sign-in per test user per file (Supabase Auth rate-limits sign-ins per IP).
  const sessions = new Map<string, Promise<SupabaseClient>>();
  function signedIn(email: string): Promise<SupabaseClient> {
    let session = sessions.get(email);
    if (!session) {
      session = (async () => {
        const client = createClient(url!, anonKey!, noSession);
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(`Could not sign in test user: ${error.message}`);
        return client;
      })();
      sessions.set(email, session);
    }
    return session;
  }

  /** Deletes this run's departments through the service role: detach parents first, then delete. */
  async function cleanup() {
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (deleted.error) throw new Error(`Could not delete test departments (${deleted.error.code}): ${deleted.error.message}`);
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await createUser(adminEmail, { role: "admin" });
    await createUser(staffEmail, { role: "staff", employee_id: "BS-9799" });
    await service.from("employees").delete().in("employee_id", employeeIds); // leftovers from an aborted run
    managerUserId = await createUser(managerEmail, { role: "staff", employee_id: managerEmployeeId });
    archivedUserId = await createUser(archivedEmail, { role: "staff", employee_id: archivedEmployeeId });
    const employees = await service.from("employees").insert([
      employeeRow(managerEmployeeId, managerUserId),
      employeeRow(unlinkedEmployeeId, null),
      employeeRow(archivedEmployeeId, archivedUserId, "2026-10-01T00:00:00Z"),
    ], { defaultToNull: false });
    if (employees.error) throw new Error(`Could not insert test employees (${employees.error.code}): ${employees.error.message}`);
    const parent = await service.from("departments").insert({ name: `${PREFIX} Parent` }).select("id").single();
    if (parent.error) throw new Error(`Could not insert test department (${parent.error.code}): ${parent.error.message}`);
    parentId = parent.data.id as string;
    const child = await service.from("departments").insert({ name: `${PREFIX} Child`, parent_department_id: parentId }).select("id").single();
    if (child.error) throw new Error(`Could not insert test department (${child.error.code}): ${child.error.message}`);
    childId = child.data.id as string;
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      await service.from("employees").delete().in("employee_id", employeeIds);
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets an Administrator list departments through the store", async () => {
    const client = await signedIn(adminEmail);
    const list = await createDepartmentsStore({ userClient: async () => client }).list(admin);
    expect(list).toEqual(expect.arrayContaining([
      { id: parentId, name: `${PREFIX} Parent`, parentId: null, ...none },
      { id: childId, name: `${PREFIX} Child`, parentId, ...none },
    ]));
  });

  it("returns no departments to staff and refuses their writes", async () => {
    const staff = await signedIn(staffEmail);
    const read = await staff.from("departments").select("id").like("name", `${PREFIX}%`);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    expect((await staff.from("departments").insert({ name: `${PREFIX} Staff` })).error).not.toBeNull();
    const updated = await staff.from("departments").update({ name: `${PREFIX} Renamed by staff` }).eq("id", parentId).select("id");
    expect(updated.data ?? []).toEqual([]);
    await expect(createDepartmentsStore({ userClient: async () => staff }).list({ role: "staff", employeeId: "BS-9799" }))
      .rejects.toBeInstanceOf(DepartmentsForbiddenError);
  });

  it("returns nothing to an anonymous client and refuses its writes", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("departments").select("id").like("name", `${PREFIX}%`);
    expect(data ?? []).toEqual([]);
    expect((await anon.from("departments").insert({ name: `${PREFIX} Anon` })).error).not.toBeNull();
  });

  it("lets an Administrator add, rename and re-parent through the store", async () => {
    const client = await signedIn(adminEmail);
    const store = createDepartmentsStore({ userClient: async () => client });
    const added = await store.create(admin, { name: `  ${PREFIX}   Added `, parentId: null });
    expect(added).toMatchObject({ name: `${PREFIX} Added`, parentId: null });
    const moved = await store.update(admin, added.id, { name: `${PREFIX} Added Renamed`, parentId: childId });
    expect(moved).toEqual({ id: added.id, name: `${PREFIX} Added Renamed`, parentId: childId, ...none });
  });

  it("deletes nothing for anyone through the API (no delete policy)", async () => {
    for (const email of [adminEmail, staffEmail]) {
      const client = await signedIn(email);
      const deleted = await client.from("departments").delete().eq("id", childId).select("id");
      expect(deleted.data ?? []).toEqual([]);
    }
    const { data } = await service.from("departments").select("id").eq("id", childId);
    expect(data).toEqual([{ id: childId }]);
  });

  it("enforces case-insensitive unique names in the database, mapped by the store", async () => {
    const client = await signedIn(adminEmail);
    const direct = await client.from("departments").insert({ name: `${PREFIX} parent`.toUpperCase() });
    expect(direct.error?.code).toBe("23505");
    await expect(createDepartmentsStore({ userClient: async () => client }).create(admin, { name: `${PREFIX} PARENT`, parentId: null }))
      .rejects.toBeInstanceOf(DepartmentNameTakenError);
  });

  it("rejects a department as its own parent and an ancestor cycle in the database", async () => {
    const client = await signedIn(adminEmail);
    const self = await client.from("departments").update({ parent_department_id: parentId }).eq("id", parentId).select("id");
    expect(self.error?.code).toBe("23514");
    const cycle = await client.from("departments").update({ parent_department_id: childId }).eq("id", parentId).select("id");
    expect(cycle.error?.code).toBe("23514");
    expect(cycle.error?.message).toContain("department_cycle");
    // The trigger also binds the service role.
    const serviceCycle = await service.from("departments").update({ parent_department_id: childId }).eq("id", parentId);
    expect(serviceCycle.error?.code).toBe("23514");
    await expect(createDepartmentsStore({ userClient: async () => client }).update(admin, parentId, { name: `${PREFIX} Parent`, parentId: childId }))
      .rejects.toBeInstanceOf(DepartmentCycleError);
    const { data } = await service.from("departments").select("parent_department_id").eq("id", parentId).single();
    expect(data).toEqual({ parent_department_id: null });
  });

  it("adds a nullable department_id to employees, readable by an Administrator", async () => {
    const client = await signedIn(adminEmail);
    const { error } = await client.from("employees").select("employee_id,department_id").limit(1);
    expect(error).toBeNull();
  });

  // Story 4.2 — department managers.
  it("lets a user read only the departments they manage, and nothing once removed", async () => {
    const set = await service.from("departments").update({ manager_user_id: managerUserId }).eq("id", parentId);
    if (set.error) throw new Error(`Could not set test manager (${set.error.code}): ${set.error.message}`);
    try {
      const manager = await signedIn(managerEmail);
      const read = await manager.from("departments").select("id,manager_user_id").like("name", `${PREFIX}%`);
      expect(read.error).toBeNull();
      expect(read.data).toEqual([{ id: parentId, manager_user_id: managerUserId }]);
      // The store's per-request check (auth.ts) through each user's own JWT.
      expect(await createDepartmentsStore({ userClient: async () => manager }).managesAny(managerUserId)).toBe(true);
      const staff = await signedIn(staffEmail);
      expect((await staff.from("departments").select("id").like("name", `${PREFIX}%`)).data).toEqual([]);
      expect(await createDepartmentsStore({ userClient: async () => staff }).managesAny(userIds[1])).toBe(false);
      // Even asked about someone else, a user sees only their own managed rows.
      expect(await createDepartmentsStore({ userClient: async () => staff }).managesAny(managerUserId)).toBe(false);
    } finally {
      await service.from("departments").update({ manager_user_id: null }).eq("id", parentId);
    }
    const manager = await signedIn(managerEmail);
    expect((await manager.from("departments").select("id").like("name", `${PREFIX}%`)).data).toEqual([]);
    expect(await createDepartmentsStore({ userClient: async () => manager }).managesAny(managerUserId)).toBe(false);
  });

  it("refuses manager_user_id changes from staff and managers, even on the department they manage", async () => {
    await service.from("departments").update({ manager_user_id: managerUserId }).eq("id", childId);
    try {
      const manager = await signedIn(managerEmail);
      const cleared = await manager.from("departments").update({ manager_user_id: null }).eq("id", childId).select("id");
      expect(cleared.data ?? []).toEqual([]);
      const taken = await manager.from("departments").update({ manager_user_id: managerUserId }).eq("id", parentId).select("id");
      expect(taken.data ?? []).toEqual([]);
      const staff = await signedIn(staffEmail);
      const byStaff = await staff.from("departments").update({ manager_user_id: userIds[1] }).eq("id", childId).select("id");
      expect(byStaff.data ?? []).toEqual([]);
      const { data } = await service.from("departments").select("id,manager_user_id").in("id", [parentId, childId]).order("id");
      expect(data).toEqual(expect.arrayContaining([
        { id: parentId, manager_user_id: null }, { id: childId, manager_user_id: managerUserId },
      ]));
      await expect(createDepartmentsStore({ userClient: async () => manager }).setManager({ role: "manager", employeeId: managerEmployeeId, userId: managerUserId }, childId, null))
        .rejects.toBeInstanceOf(DepartmentsForbiddenError);
    } finally {
      await service.from("departments").update({ manager_user_id: null }).eq("id", childId);
    }
  });

  it("lets an Administrator set and clear a manager through the store, listed with the Employee ID", async () => {
    const client = await signedIn(adminEmail);
    const store = createDepartmentsStore({ userClient: async () => client });
    const set = await store.setManager(admin, childId, managerEmployeeId);
    expect(set).toEqual({ id: childId, name: `${PREFIX} Child`, parentId, managerUserId, managerEmployeeId });
    expect((await store.list(admin)).find(d => d.id === childId)).toEqual(set);
    const cleared = await store.setManager(admin, childId, null);
    expect(cleared).toEqual({ id: childId, name: `${PREFIX} Child`, parentId, ...none });
    const { data } = await service.from("departments").select("manager_user_id").eq("id", childId).single();
    expect(data).toEqual({ manager_user_id: null });
  });

  it("refuses an employee with no account or an archived account, saving nothing", async () => {
    const client = await signedIn(adminEmail);
    const store = createDepartmentsStore({ userClient: async () => client });
    await expect(store.setManager(admin, childId, unlinkedEmployeeId)).rejects.toBeInstanceOf(ManagerHasNoAccountError);
    await expect(store.setManager(admin, childId, archivedEmployeeId)).rejects.toBeInstanceOf(ManagerArchivedError);
    const { data } = await service.from("departments").select("manager_user_id").eq("id", childId).single();
    expect(data).toEqual({ manager_user_id: null });
  });
});
