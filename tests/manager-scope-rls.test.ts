// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and
// employees (a per-run slot of BS-92xx, a range no other test uses), never the seeded demo data, and
// removes everything it created in afterAll through the service role.
// Rules under test (Story 4.3): a department manager reads the departments in their subtree (the ones
// they manage and every descendant) and the employees in them, plus those employees' attendance,
// training history and LMS stub enrolments; nothing outside the subtree, nothing upwards, and no writes.
// A manager of the child department sees only the child. Unmanaged Staff and the Administrator read
// exactly what they did before. The store-side manager-scope and employees/training/attendance stores
// agree with RLS.
// Fails with 42P01 / PGRST205 until the departments migration is applied, 42703 until the
// department_managers migration is, and returns 0 rows to managers (failing the visibility checks)
// until the manager_scope migration is.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAttendanceStore } from "@/server/attendance-store";
import { createDepartmentsStore } from "@/server/departments-store";
import { createEmployeesStore } from "@/server/employees-store";
import { createInterviewsStore } from "@/server/interviews-store";
import { createStubLmsClient } from "@/server/lms-client";
import { createManagerScope } from "@/server/manager-scope";
import { createTrainingStore } from "@/server/training-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Scope ${run}`;
// One per-run slot of six consecutive ids (BS-9200..BS-9295).
const base = randomInt(0, 16) * 6;
const idAt = (offset: number) => `BS-92${String(base + offset).padStart(2, "0")}`;
const parentEmployee = idAt(0);   // in the parent department
const childEmployee = idAt(1);    // in the child department
const outsideEmployee = idAt(2);  // in an unrelated department
const parentManagerId = idAt(3);  // the parent's manager (no department of their own)
const childManagerId = idAt(4);   // the child's manager (no department of their own)
const staffId = idAt(5);          // plain Staff, placed in the child department, manages nothing
const employeeIds = [parentEmployee, childEmployee, outsideEmployee, parentManagerId, childManagerId, staffId];
const subjects = [parentEmployee, childEmployee, outsideEmployee];

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Scope ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-scope-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RS", avatar_color: "mint", summary: "Throwaway row created by tests/manager-scope-rls.test.ts.",
  auth_user_id, department_id,
});
const attendanceRow = (employee_id: string) => ({
  id: randomUUID(), employee_id, work_date: "2026-02-02", clock_in: "2026-02-02T03:00:00Z", clock_out: null,
  break_minutes: 0, work_mode: "Office", log: null,
});
const trainingRow = (employee_id: string) => ({
  id: randomUUID(), employee_id, programme: `Scope Programme ${run}`, provider: "Test provider", result: "Completed",
  completed_on: "2026-08-20",
});
const enrolmentRow = (employee_id: string) => ({
  id: randomUUID(), employee_id, programme: `Scope LMS ${run}`, provider: "Test provider", status: "in_progress",
  progress: 40, target_date: "2026-12-01",
});

const sortedIds = (rows: { employee_id: string }[] | null) => (rows ?? []).map(r => r.employee_id).sort();

describe.skipIf(!configured)("manager scope RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-scope-admin-${run}@example.com`;
  const parentManagerEmail = `rls-scope-parent-mgr-${run}@example.com`;
  const childManagerEmail = `rls-scope-child-mgr-${run}@example.com`;
  const staffEmail = `rls-scope-staff-${run}@example.com`;
  let parentManagerUserId = "";
  let childManagerUserId = "";
  let parentId = "";
  let childId = "";
  let outsideId = "";

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

  async function cleanup() {
    for (const table of ["lms_stub_enrolments", "training_history", "attendance_entries", "employees"]) {
      const deleted = await service.from(table).delete().in("employee_id", employeeIds);
      if (deleted.error) throw new Error(`Could not delete test ${table} (${deleted.error.code}): ${deleted.error.message}`);
    }
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (deleted.error) throw new Error(`Could not delete test departments (${deleted.error.code}): ${deleted.error.message}`);
  }

  async function insertDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run in the same slot
    await createUser(adminEmail, { role: "admin" });
    parentManagerUserId = await createUser(parentManagerEmail, { role: "staff", employee_id: parentManagerId });
    childManagerUserId = await createUser(childManagerEmail, { role: "staff", employee_id: childManagerId });
    const staffUserId = await createUser(staffEmail, { role: "staff", employee_id: staffId });
    parentId = await insertDepartment(`${PREFIX} Parent`, null, parentManagerUserId);
    childId = await insertDepartment(`${PREFIX} Child`, parentId, childManagerUserId);
    outsideId = await insertDepartment(`${PREFIX} Outside`, null, null);
    const employees = await service.from("employees").insert([
      employeeRow(parentEmployee, null, parentId),
      employeeRow(childEmployee, null, childId),
      employeeRow(outsideEmployee, null, outsideId),
      employeeRow(parentManagerId, parentManagerUserId, null),
      employeeRow(childManagerId, childManagerUserId, null),
      employeeRow(staffId, staffUserId, childId),
    ], { defaultToNull: false });
    if (employees.error) throw new Error(`Could not insert test employees (${employees.error.code}): ${employees.error.message}`);
    for (const [table, row] of [["attendance_entries", attendanceRow], ["training_history", trainingRow], ["lms_stub_enrolments", enrolmentRow]] as const) {
      const inserted = await service.from(table).insert(subjects.map(id => row(id)), { defaultToNull: false });
      if (inserted.error) throw new Error(`Could not insert test ${table} (${inserted.error.code}): ${inserted.error.message}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the parent's manager read the parent and child departments, not an unrelated one", async () => {
    const manager = await signedIn(parentManagerEmail);
    const { data, error } = await manager.from("departments").select("id").like("name", `${PREFIX}%`);
    expect(error).toBeNull();
    expect((data ?? []).map(d => d.id).sort()).toEqual([parentId, childId].sort());
  });

  it("lets the child's manager read only the child department (never upwards)", async () => {
    const manager = await signedIn(childManagerEmail);
    const { data, error } = await manager.from("departments").select("id").like("name", `${PREFIX}%`);
    expect(error).toBeNull();
    expect((data ?? []).map(d => d.id)).toEqual([childId]);
  });

  it("shows the parent's manager the subtree's employees (plus their own row), not the outside one", async () => {
    const manager = await signedIn(parentManagerEmail);
    const { data, error } = await manager.from("employees").select("employee_id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(sortedIds(data)).toEqual([parentEmployee, childEmployee, parentManagerId, staffId].sort());
  });

  it("shows the child's manager only the child's employees (plus their own row)", async () => {
    const manager = await signedIn(childManagerEmail);
    const { data, error } = await manager.from("employees").select("employee_id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(sortedIds(data)).toEqual([childEmployee, childManagerId, staffId].sort());
  });

  for (const table of ["attendance_entries", "training_history", "lms_stub_enrolments"]) {
    it(`scopes ${table} to the manager's subtree`, async () => {
      const parent = await signedIn(parentManagerEmail);
      const child = await signedIn(childManagerEmail);
      const asParent = await parent.from(table).select("employee_id").in("employee_id", employeeIds);
      expect(asParent.error).toBeNull();
      expect(sortedIds(asParent.data)).toEqual([parentEmployee, childEmployee].sort());
      const asChild = await child.from(table).select("employee_id").in("employee_id", employeeIds);
      expect(asChild.error).toBeNull();
      expect(sortedIds(asChild.data)).toEqual([childEmployee]);
      // Directly asking for the outside employee returns 0 rows.
      const outside = await parent.from(table).select("employee_id").eq("employee_id", outsideEmployee);
      expect(outside.data ?? []).toEqual([]);
    });
  }

  it("gives a manager no write access to employees, departments or the scoped tables", async () => {
    const manager = await signedIn(parentManagerEmail);
    const renamed = await manager.from("employees").update({ title: "Changed" }).eq("employee_id", childEmployee).select("employee_id");
    expect(renamed.data ?? []).toEqual([]);
    const reparented = await manager.from("departments").update({ name: `${PREFIX} Renamed` }).eq("id", childId).select("id");
    expect(reparented.data ?? []).toEqual([]);
    expect((await manager.from("attendance_entries").insert(attendanceRow(childEmployee))).error).not.toBeNull();
    expect((await manager.from("training_history").insert(trainingRow(childEmployee))).error).not.toBeNull();
    expect((await manager.from("lms_stub_enrolments").insert(enrolmentRow(childEmployee))).error).not.toBeNull();
    const deleted = await manager.from("attendance_entries").delete().eq("employee_id", childEmployee).select("id");
    expect(deleted.data ?? []).toEqual([]);
    const { data } = await service.from("attendance_entries").select("id").eq("employee_id", childEmployee);
    expect(data).toHaveLength(1);
  });

  it("leaves unmanaged Staff on their own record only, even inside a managed department", async () => {
    const staff = await signedIn(staffEmail);
    const employees = await staff.from("employees").select("employee_id").in("employee_id", employeeIds);
    expect(sortedIds(employees.data)).toEqual([staffId]);
    for (const table of ["attendance_entries", "training_history", "lms_stub_enrolments"]) {
      const { data } = await staff.from(table).select("employee_id").in("employee_id", employeeIds);
      expect(data ?? []).toEqual([]);
    }
    const departments = await staff.from("departments").select("id").like("name", `${PREFIX}%`);
    expect(departments.data ?? []).toEqual([]);
  });

  it("leaves the Administrator reading everything", async () => {
    const admin = await signedIn(adminEmail);
    const employees = await admin.from("employees").select("employee_id").in("employee_id", employeeIds);
    expect(sortedIds(employees.data)).toEqual([...employeeIds].sort());
    for (const table of ["attendance_entries", "training_history", "lms_stub_enrolments"]) {
      const { data } = await admin.from(table).select("employee_id").in("employee_id", employeeIds);
      expect(sortedIds(data)).toEqual([...subjects].sort());
    }
    const departments = await admin.from("departments").select("id").like("name", `${PREFIX}%`);
    expect((departments.data ?? []).map(d => d.id).sort()).toEqual([parentId, childId, outsideId].sort());
  });

  it("has the store-side scope agree with RLS for both managers", async () => {
    const parent = await signedIn(parentManagerEmail);
    const child = await signedIn(childManagerEmail);
    const parentScope = await createManagerScope({ userClient: async () => parent })
      .forManager({ role: "manager", employeeId: parentManagerId, userId: parentManagerUserId });
    expect([...parentScope.departmentIds].sort()).toEqual([parentId, childId].sort());
    expect([...parentScope.employeeIds].sort()).toEqual([parentEmployee, childEmployee, staffId].sort());
    const childScope = await createManagerScope({ userClient: async () => child })
      .forManager({ role: "manager", employeeId: childManagerId, userId: childManagerUserId });
    expect([...childScope.departmentIds]).toEqual([childId]);
    expect([...childScope.employeeIds].sort()).toEqual([childEmployee, staffId].sort());
  });

  it("scopes the employees, training, attendance and departments stores for a manager", async () => {
    const client = await signedIn(childManagerEmail);
    const session = { role: "manager", employeeId: childManagerId, userId: childManagerUserId } as const;
    const userClient = async () => client;
    const scope = createManagerScope({ userClient });
    const training = createTrainingStore({ userClient, lms: createStubLmsClient({ userClient }), scope });
    const employees = createEmployeesStore({ userClient, interviews: createInterviewsStore({ userClient }), training, scope });
    const list = await employees.listFor(session);
    expect(list.map(e => e.id).sort()).toEqual([childEmployee, staffId].sort());
    expect(list.every(e => e.departmentId === childId && e.interviews.length === 0)).toBe(true);
    expect(list.find(e => e.id === childEmployee)?.training).toHaveLength(1);
    expect(await employees.getFor(session, parentEmployee)).toBeNull();
    expect(await employees.getFor(session, outsideEmployee)).toBeNull();
    expect((await employees.getFor(session, childEmployee))?.id).toBe(childEmployee);
    expect(await training.listFor(session, parentEmployee)).toEqual([]);
    const current = await training.currentFor(session, [childEmployee, parentEmployee, outsideEmployee]);
    expect(current.status === "ok" && current.inProgress.map(t => t.employeeId)).toEqual([childEmployee]);
    const attendance = createAttendanceStore({ userClient, scope });
    expect(await attendance.listFor(session, childEmployee)).toHaveLength(1);
    expect(await attendance.listFor(session, parentEmployee)).toEqual([]);
    const departments = await createDepartmentsStore({ userClient, scope }).listFor(session);
    expect(departments.map(d => d.id)).toEqual([childId]);
  });
});
