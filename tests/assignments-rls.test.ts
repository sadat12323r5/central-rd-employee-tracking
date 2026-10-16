// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, never the seeded demo data.
// Rules under test (Story 4.5): the Administrator, and a manager over the employee's department (the
// department's own manager or an ancestor's), read, create and update assignments; Staff read only their
// own and never write. Identifying fields are locked, closed rows are frozen, a second open assignment is
// refused by the one-open index (23505), department_id is always the employee's (the trigger overwrites
// what is sent), and nothing can be deleted, not even with the service role.
//
// Because assignments can never be deleted (and their employee and department foreign keys are ON DELETE
// RESTRICT), this test cannot remove what it creates. Instead it reuses a fixed slot of throwaway
// employees (BS-9100..BS-9123, a range no other test uses) and fixed-name departments ("RLS Assign slot
// N …"): beforeAll closes any assignment an earlier run left open and re-links the slot to this run's
// users; afterAll closes everything it opened, unlinks and archives the employees, clears the managers and
// deletes the auth users. Assertions only count rows by employee, so closed history from earlier runs in
// the same slot never matters.
// Fails with PGRST205 / 42P01 until the departments (4.1) and assignments (4.5) migrations are applied.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssignmentsForbiddenError, createAssignmentsStore } from "@/server/assignments-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One of four fixed slots of six consecutive ids (BS-9100..BS-9123).
const slot = randomInt(0, 4);
const idAt = (offset: number) => `BS-91${String(slot * 6 + offset).padStart(2, "0")}`;
const parentEmployee = idAt(0);   // in the parent department
const childEmployee = idAt(1);    // in the child department
const noDepartment = idAt(2);     // in no department
const parentManagerId = idAt(3);  // the parent's manager (no department of their own)
const childManagerId = idAt(4);   // the child's manager (no department of their own)
const staffId = idAt(5);          // plain Staff, placed in the child department, manages nothing
const employeeIds = [parentEmployee, childEmployee, noDepartment, parentManagerId, childManagerId, staffId];
const PARENT_NAME = `RLS Assign slot ${slot} Parent`;
const CHILD_NAME = `RLS Assign slot ${slot} Child`;
const FAR_FUTURE = "2099-12-31";

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Assign ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-assign-${employee_id.toLowerCase()}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RA", avatar_color: "mint", summary: "Throwaway row reused by tests/assignments-rls.test.ts.",
  auth_user_id, department_id, archived_at: null,
});
const assignmentRow = (employee_id: string, extra: Record<string, unknown> = {}) => ({
  employee_id, client: `RLS client ${run}`, project_name: `RLS project ${run}`, role: "Tester", allocation: 50,
  start_date: "2026-09-01", latest_update: "", ...extra,
});

const distinctEmployees = (rows: { employee_id: string }[] | null) => [...new Set((rows ?? []).map(r => r.employee_id))].sort();

describe.skipIf(!configured)("assignments RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-assign-admin-${run}@example.com`;
  const parentManagerEmail = `rls-assign-parent-mgr-${run}@example.com`;
  const childManagerEmail = `rls-assign-child-mgr-${run}@example.com`;
  const staffEmail = `rls-assign-staff-${run}@example.com`;
  let childManagerUserId = "";
  let parentId = "";
  let childId = "";
  /** The open assignment each subject got in beforeAll. */
  const openIds = new Map<string, string>();

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

  /** Closes every open assignment of the slot (the only way to retire one: nothing is ever deleted). */
  async function closeOpen() {
    const closed = await service.from("assignments").update({ status: "closed", completion_date: FAR_FUTURE })
      .in("employee_id", employeeIds).eq("status", "open");
    if (closed.error) throw new Error(`Could not close test assignments (${closed.error.code}): ${closed.error.message}`);
  }

  /** The slot's fixed-name department, created once and re-pointed at this run's manager. */
  async function ensureDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const found = await service.from("departments").select("id").eq("name", name).maybeSingle();
    if (found.error) throw new Error(`Could not read test department (${found.error.code}): ${found.error.message}`);
    if (found.data) {
      const updated = await service.from("departments").update({ parent_department_id, manager_user_id }).eq("id", found.data.id);
      if (updated.error) throw new Error(`Could not update test department (${updated.error.code}): ${updated.error.message}`);
      return found.data.id as string;
    }
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  async function openFor(employee_id: string): Promise<string> {
    const { data, error } = await service.from("assignments").insert(assignmentRow(employee_id)).select("id").single();
    if (error) throw new Error(`Could not insert test assignment (${error.code}): ${error.message}`);
    return data.id as string;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await createUser(adminEmail, { role: "admin" });
    const parentManagerUserId = await createUser(parentManagerEmail, { role: "staff", employee_id: parentManagerId });
    childManagerUserId = await createUser(childManagerEmail, { role: "staff", employee_id: childManagerId });
    const staffUserId = await createUser(staffEmail, { role: "staff", employee_id: staffId });
    parentId = await ensureDepartment(PARENT_NAME, null, parentManagerUserId);
    childId = await ensureDepartment(CHILD_NAME, parentId, childManagerUserId);
    await closeOpen(); // leftovers of an aborted run in the same slot
    const employees = await service.from("employees").upsert([
      employeeRow(parentEmployee, null, parentId),
      employeeRow(childEmployee, null, childId),
      employeeRow(noDepartment, null, null),
      employeeRow(parentManagerId, parentManagerUserId, null),
      employeeRow(childManagerId, childManagerUserId, null),
      employeeRow(staffId, staffUserId, childId),
    ], { onConflict: "employee_id", defaultToNull: false });
    if (employees.error) throw new Error(`Could not upsert test employees (${employees.error.code}): ${employees.error.message}`);
    for (const id of [parentEmployee, childEmployee, staffId]) openIds.set(id, await openFor(id));
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await closeOpen();
      // The rows stay (assignments reference them); unlink and archive them so they are inert.
      await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).in("employee_id", employeeIds);
      await service.from("departments").update({ manager_user_id: null }).in("name", [PARENT_NAME, CHILD_NAME]);
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("scopes reads: the parent's manager sees the subtree, the child's manager only the child, Staff only their own", async () => {
    const expectations: [string, string[]][] = [
      [parentManagerEmail, [parentEmployee, childEmployee, staffId]],
      [childManagerEmail, [childEmployee, staffId]],
      [staffEmail, [staffId]],
      [adminEmail, [parentEmployee, childEmployee, staffId]],
    ];
    for (const [email, expected] of expectations) {
      const client = await signedIn(email);
      const { data, error } = await client.from("assignments").select("employee_id").in("employee_id", employeeIds);
      expect(error).toBeNull();
      expect(distinctEmployees(data)).toEqual([...expected].sort());
    }
    // Staff asking directly for another employee's assignment get 0 rows.
    const staff = await signedIn(staffEmail);
    const other = await staff.from("assignments").select("id").eq("id", openIds.get(childEmployee)!);
    expect(other.data ?? []).toEqual([]);
  });

  it("lets a manager over the department insert; refuses an out-of-scope manager and Staff (RLS)", async () => {
    const child = await signedIn(childManagerEmail);
    const outside = await child.from("assignments").insert(assignmentRow(parentEmployee)).select("id");
    expect(outside.error).not.toBeNull();
    const staff = await signedIn(staffEmail);
    expect((await staff.from("assignments").insert(assignmentRow(staffId)).select("id")).error).not.toBeNull();
    // A manager inserting for an employee with an open assignment hits the one-open index (23505) after RLS allows it.
    const parent = await signedIn(parentManagerEmail);
    const second = await parent.from("assignments").insert(assignmentRow(childEmployee)).select("id");
    expect(second.error?.code).toBe("23505");
  });

  it("refuses an employee with no department (23514), even for the Administrator", async () => {
    const admin = await signedIn(adminEmail);
    const { error } = await admin.from("assignments").insert(assignmentRow(noDepartment)).select("id");
    expect(error?.code).toBe("23514");
  });

  it("closes an open assignment, then overwrites a caller-chosen department_id with the employee's own", async () => {
    const parent = await signedIn(parentManagerEmail);
    const closed = await parent.from("assignments").update({ status: "closed", completion_date: "2026-10-01" })
      .eq("id", openIds.get(parentEmployee)!).select("status,completion_date,closed_at");
    expect(closed.error).toBeNull();
    expect(closed.data?.[0]).toMatchObject({ status: "closed", completion_date: "2026-10-01" });
    expect(closed.data?.[0]?.closed_at).not.toBeNull();
    // A new one, sent with the child department and a forged status: stored open under the parent department.
    const created = await parent.from("assignments")
      .insert(assignmentRow(parentEmployee, { department_id: childId, status: "closed", completion_date: "2026-12-01" }))
      .select("id,department_id,status,completion_date").single();
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ department_id: parentId, status: "open", completion_date: null });
    openIds.set(parentEmployee, created.data!.id as string);
  });

  it("scopes note updates: in-scope managers update, an out-of-scope manager and Staff update 0 rows", async () => {
    const child = await signedIn(childManagerEmail);
    const outside = await child.from("assignments").update({ latest_update: "child edits parent" }).eq("id", openIds.get(parentEmployee)!).select("id");
    expect(outside.data ?? []).toEqual([]);
    const staff = await signedIn(staffEmail);
    const own = await staff.from("assignments").update({ latest_update: "staff edits own" }).eq("id", openIds.get(staffId)!).select("id");
    expect(own.data ?? []).toEqual([]);
    const parent = await signedIn(parentManagerEmail);
    const inside = await parent.from("assignments").update({ latest_update: "Parent manager note." }).eq("id", openIds.get(childEmployee)!).select("latest_update");
    expect(inside.error).toBeNull();
    expect(inside.data).toEqual([{ latest_update: "Parent manager note." }]);
    const { data } = await service.from("assignments").select("latest_update").eq("id", openIds.get(parentEmployee)!).single();
    expect(data?.latest_update).toBe("");
  });

  it("locks the identifying fields (23514), for the Administrator and the service role too", async () => {
    const admin = await signedIn(adminEmail);
    const id = openIds.get(childEmployee)!;
    const changes: Record<string, unknown>[] = [
      { client: "Changed" }, { project_name: "Changed" }, { role: "Changed" }, { allocation: 10 }, { start_date: "2026-01-01" },
      { department_id: parentId }, { employee_id: staffId }, { created_at: "2026-01-01T00:00:00Z" },
    ];
    for (const change of changes) {
      const { error } = await admin.from("assignments").update(change).eq("id", id).select("id");
      expect(error?.code, JSON.stringify(change)).toBe("23514");
    }
    expect((await service.from("assignments").update({ client: "Changed" }).eq("id", id)).error?.code).toBe("23514");
  });

  it("refuses a bad close and freezes a closed row (no note edit, no reopen)", async () => {
    const admin = await signedIn(adminEmail);
    const id = openIds.get(childEmployee)!;
    expect((await admin.from("assignments").update({ status: "closed", completion_date: "2026-08-31" }).eq("id", id).select("id")).error?.code).toBe("23514");
    expect((await admin.from("assignments").update({ status: "closed" }).eq("id", id).select("id")).error?.code).toBe("23514");
    expect((await admin.from("assignments").update({ completion_date: "2026-10-01" }).eq("id", id).select("id")).error?.code).toBe("23514");
    const closed = await admin.from("assignments").update({ status: "closed", completion_date: "2026-09-30" }).eq("id", id).select("id");
    expect(closed.error).toBeNull();
    expect((await admin.from("assignments").update({ latest_update: "late note" }).eq("id", id).select("id")).error?.code).toBe("23514");
    expect((await admin.from("assignments").update({ status: "open", completion_date: null, closed_at: null }).eq("id", id).select("id")).error?.code).toBe("23514");
    expect((await service.from("assignments").update({ completion_date: "2026-10-05" }).eq("id", id)).error?.code).toBe("23514");
  });

  it("never deletes an assignment: no policy for users, and the trigger refuses the service role", async () => {
    const id = openIds.get(staffId)!;
    const admin = await signedIn(adminEmail);
    const asAdmin = await admin.from("assignments").delete().eq("id", id).select("id");
    expect(asAdmin.data ?? []).toEqual([]);
    const asService = await service.from("assignments").delete().eq("id", id);
    expect(asService.error).not.toBeNull();
    const { data } = await service.from("assignments").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });

  it("has the store agree with RLS for the child's manager", async () => {
    const client = await signedIn(childManagerEmail);
    const session = { role: "manager", employeeId: childManagerId, userId: childManagerUserId } as const;
    const userClient = async () => client;
    const store = createAssignmentsStore({ userClient, scope: createManagerScope({ userClient }) });
    const list = await store.listFor(session);
    expect(distinctEmployees(list.map(a => ({ employee_id: a.employeeId })))).toEqual([childEmployee, staffId].sort());
    expect(await store.listFor(session, parentEmployee)).toEqual([]);
    await expect(store.create(session, parentEmployee, { client: "X", projectName: "Y", role: "Z", allocation: 10, startDate: "2026-10-01" }))
      .rejects.toBeInstanceOf(AssignmentsForbiddenError);
    await expect(store.updateNote(session, openIds.get(parentEmployee)!, "x")).rejects.toBeInstanceOf(AssignmentsForbiddenError);
    const saved = await store.updateNote(session, openIds.get(staffId)!, "Store note.");
    expect(saved).toMatchObject({ latestUpdate: "Store note.", departmentId: childId, status: "open" });
  });
});
