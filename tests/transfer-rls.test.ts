// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, never the seeded demo data.
// Rules under test (Story 4.8): public.transfer_employee, called with each user's own JWT, moves an
// employee only for the Administrator or a manager with authority over both the source and the
// destination department, writing exactly one audit_events row (actor, target, 'transfer', from, to); it
// refuses everyone else (not_authorized), an open assignment (open_assignment), the current department
// (same_department), an unknown destination (department_not_found) and a caller whose own employee row
// is archived (not_authorized); past assignments keep their
// recorded department; anon cannot execute it.
//
// Assignments can never be deleted (and their employee and department foreign keys are ON DELETE
// RESTRICT), so, like tests/assignments-rls.test.ts, this test reuses a fixed slot of throwaway employees
// (BS-8600..BS-8631, a range no other test uses) and fixed-name departments ("RLS Transfer slot N …"):
// beforeAll closes any assignment an earlier run left open and resets the slot's rows and departments to
// this run's users; afterAll closes what it opened, unlinks and archives the employees, clears the managers
// and deletes the auth users. Audit assertions only count this run's actors (audit rows are append-only).
// Fails with PGRST202 / 42883 / 42703 until the department_transfer migration (and the 4.1-4.5 ones) are applied.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmployeesStore, TransferForbiddenError } from "@/server/employees-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One of four fixed slots of eight consecutive ids (BS-8600..BS-8631).
const slot = randomInt(0, 4);
const idAt = (offset: number) => `BS-86${String(slot * 8 + offset).padStart(2, "0")}`;
const mPId = idAt(0);          // manager of P, employee in P
const mCId = idAt(1);          // manager of C (child of P), employee in C
const staffId = idAt(2);       // plain Staff in P
const moverId = idAt(3);       // in P, no account, with a closed past assignment in P
const openId = idAt(4);        // in P, with an open assignment
const noDepartmentId = idAt(5); // in no department
const cSubjectId = idAt(6);    // in C
const employeeIds = [mPId, mCId, staffId, moverId, openId, noDepartmentId, cSubjectId];
const P_NAME = `RLS Transfer slot ${slot} P`;
const C_NAME = `RLS Transfer slot ${slot} C`;
const FAR_FUTURE = "2099-12-31";
const RPC = "transfer_employee";

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Transfer ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-transfer-${employee_id.toLowerCase()}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RT", avatar_color: "mint", summary: "Throwaway row reused by tests/transfer-rls.test.ts.",
  auth_user_id, department_id, archived_at: null,
});
const assignmentRow = (employee_id: string) => ({
  employee_id, client: `RLS client ${run}`, project_name: `RLS project ${run}`, role: "Tester", allocation: 50, start_date: "2026-09-01",
  latest_update: "",
});

describe.skipIf(!configured)("department transfer (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const users: Record<string, string> = {};
  const email = (who: string) => `rls-transfer-${who}-${run}@example.com`;
  let pDept = "";
  let cDept = "";
  let pastAssignmentId = "";

  async function createUser(who: string, app_metadata: Record<string, string>) {
    const { data, error } = await service.auth.admin.createUser({ email: email(who), password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    users[who] = data.user.id;
    return data.user.id;
  }

  // One sign-in per test user per file (Supabase Auth rate-limits sign-ins per IP).
  const sessions = new Map<string, Promise<SupabaseClient>>();
  function signedIn(who: string): Promise<SupabaseClient> {
    let session = sessions.get(who);
    if (!session) {
      session = (async () => {
        const client = createClient(url!, anonKey!, noSession);
        const { error } = await client.auth.signInWithPassword({ email: email(who), password });
        if (error) throw new Error(`Could not sign in test user: ${error.message}`);
        return client;
      })();
      sessions.set(who, session);
    }
    return session;
  }

  async function closeOpen() {
    const closed = await service.from("assignments").update({ status: "closed", completion_date: FAR_FUTURE })
      .in("employee_id", employeeIds).eq("status", "open");
    if (closed.error) throw new Error(`Could not close test assignments (${closed.error.code}): ${closed.error.message}`);
  }

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

  async function departmentOf(employeeId: string) {
    const { data, error } = await service.from("employees").select("department_id").eq("employee_id", employeeId).single();
    if (error) throw new Error(`Could not read test employee (${error.code}): ${error.message}`);
    return data.department_id as string | null;
  }

  async function transfersOf(employeeId: string) {
    const { data, error } = await service.from("audit_events").select("actor,target,action,from_department_id,to_department_id")
      .eq("target", employeeId).eq("action", "transfer").in("actor", userIds).order("id");
    if (error) throw new Error(`Could not read audit rows (${error.code}): ${error.message}`);
    return data;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await createUser("admin", { role: "admin" });
    await createUser("mp", { role: "staff", employee_id: mPId });
    await createUser("mc", { role: "staff", employee_id: mCId });
    await createUser("staff", { role: "staff", employee_id: staffId });
    pDept = await ensureDepartment(P_NAME, null, users.mp);
    cDept = await ensureDepartment(C_NAME, pDept, users.mc);
    await closeOpen(); // leftovers of an aborted run in the same slot
    const employees = await service.from("employees").upsert([
      employeeRow(mPId, users.mp, pDept),
      employeeRow(mCId, users.mc, cDept),
      employeeRow(staffId, users.staff, pDept),
      employeeRow(moverId, null, pDept),
      employeeRow(openId, null, pDept),
      employeeRow(noDepartmentId, null, null),
      employeeRow(cSubjectId, null, cDept),
    ], { onConflict: "employee_id", defaultToNull: false });
    if (employees.error) throw new Error(`Could not upsert test employees (${employees.error.code}): ${employees.error.message}`);
    // The mover's past assignment (recorded under P), and the open one that blocks openId's transfer.
    const past = await service.from("assignments").insert(assignmentRow(moverId)).select("id").single();
    if (past.error) throw new Error(`Could not insert test assignment (${past.error.code}): ${past.error.message}`);
    pastAssignmentId = past.data.id as string;
    const closed = await service.from("assignments").update({ status: "closed", completion_date: "2026-10-01" }).eq("id", pastAssignmentId);
    if (closed.error) throw new Error(`Could not close test assignment (${closed.error.code}): ${closed.error.message}`);
    const open = await service.from("assignments").insert(assignmentRow(openId));
    if (open.error) throw new Error(`Could not insert test assignment (${open.error.code}): ${open.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await closeOpen();
      // The rows stay (assignments reference them); unlink and archive them so they are inert.
      await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).in("employee_id", employeeIds);
      await service.from("departments").update({ manager_user_id: null }).in("name", [P_NAME, C_NAME]);
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets P's manager move an employee from P to its child C, with exactly one audit row, and keeps the past assignment's department", async () => {
    const mP = await signedIn("mp");
    const moved = await mP.rpc(RPC, { p_employee_id: moverId, p_to_department_id: cDept });
    expect(moved.error).toBeNull();
    expect(moved.data).toBe(`RLS Transfer ${moverId}`);
    expect(await departmentOf(moverId)).toBe(cDept);
    expect(await transfersOf(moverId)).toEqual([
      { actor: users.mp, target: moverId, action: "transfer", from_department_id: pDept, to_department_id: cDept },
    ]);
    const past = await service.from("assignments").select("department_id").eq("id", pastAssignmentId).single();
    expect(past.error).toBeNull();
    expect(past.data?.department_id).toBe(pDept);
  });

  it("refuses C's manager moving a C employee to P (no authority over P) with not_authorized, writing nothing", async () => {
    const mC = await signedIn("mc");
    const { error } = await mC.rpc(RPC, { p_employee_id: cSubjectId, p_to_department_id: pDept });
    expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
    expect(await departmentOf(cSubjectId)).toBe(cDept);
    expect(await transfersOf(cSubjectId)).toEqual([]);
    // The store refuses it too, before any rpc (the destination is outside C's manager's scope).
    const store = createEmployeesStore({
      userClient: async () => mC, interviews: { listFor: async () => [] }, training: { listFor: async () => [] },
      assignments: { listFor: async () => [] }, evaluations: { listFor: async () => [] }, backfilled: { listFor: async () => [] },
      scope: createManagerScope({ userClient: async () => mC }),
    });
    await expect(store.transfer({ role: "manager", employeeId: mCId, userId: users.mc }, cSubjectId, pDept)).rejects.toBeInstanceOf(TransferForbiddenError);
  });

  it("refuses plain Staff, for themselves or anyone else, with not_authorized", async () => {
    const staff = await signedIn("staff");
    for (const target of [staffId, cSubjectId]) {
      const { error } = await staff.rpc(RPC, { p_employee_id: target, p_to_department_id: cDept });
      expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
    }
    expect(await departmentOf(staffId)).toBe(pDept);
    expect(await transfersOf(staffId)).toEqual([]);
  });

  it("refuses an employee with an open assignment with open_assignment", async () => {
    const mP = await signedIn("mp");
    const { error } = await mP.rpc(RPC, { p_employee_id: openId, p_to_department_id: cDept });
    expect(error).toMatchObject({ code: "P0001", message: "open_assignment" });
    expect(await departmentOf(openId)).toBe(pDept);
    expect(await transfersOf(openId)).toEqual([]);
  });

  it("refuses the employee's current department with same_department, changing nothing", async () => {
    const mP = await signedIn("mp");
    const auditBefore = await transfersOf(staffId);
    const { error } = await mP.rpc(RPC, { p_employee_id: staffId, p_to_department_id: pDept });
    expect(error).toMatchObject({ code: "P0001", message: "same_department" });
    expect(await departmentOf(staffId)).toBe(pDept);
    expect(await transfersOf(staffId)).toEqual(auditBefore);
  });

  it("refuses an unknown destination with department_not_found, changing nothing", async () => {
    const mP = await signedIn("mp");
    const auditBefore = await transfersOf(staffId);
    const { error } = await mP.rpc(RPC, { p_employee_id: staffId, p_to_department_id: randomUUID() });
    expect(error).toMatchObject({ code: "P0001", message: "department_not_found" });
    expect(await departmentOf(staffId)).toBe(pDept);
    expect(await transfersOf(staffId)).toEqual(auditBefore);
  });

  it("refuses C's manager moving a P employee into C (authority over the destination only) with not_authorized", async () => {
    const mC = await signedIn("mc");
    const auditBefore = await transfersOf(staffId);
    const { error } = await mC.rpc(RPC, { p_employee_id: staffId, p_to_department_id: cDept });
    expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
    expect(await departmentOf(staffId)).toBe(pDept);
    expect(await transfersOf(staffId)).toEqual(auditBefore);
  });

  it("refuses a manager whose own employee row is archived (JWT still valid) with not_authorized, changing nothing", async () => {
    const mP = await signedIn("mp");
    const auditBefore = await transfersOf(staffId);
    const archived = await service.from("employees").update({ archived_at: new Date().toISOString() }).eq("employee_id", mPId);
    expect(archived.error).toBeNull();
    try {
      const { error } = await mP.rpc(RPC, { p_employee_id: staffId, p_to_department_id: cDept });
      expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
      expect(await departmentOf(staffId)).toBe(pDept);
      expect(await transfersOf(staffId)).toEqual(auditBefore);
    } finally {
      const restored = await service.from("employees").update({ archived_at: null }).eq("employee_id", mPId);
      expect(restored.error).toBeNull();
    }
  });

  it("lets the Administrator move an employee with no department, recording from as null", async () => {
    const admin = await signedIn("admin");
    const { error } = await admin.rpc(RPC, { p_employee_id: noDepartmentId, p_to_department_id: cDept });
    expect(error).toBeNull();
    expect(await departmentOf(noDepartmentId)).toBe(cDept);
    expect(await transfersOf(noDepartmentId)).toEqual([
      { actor: users.admin, target: noDepartmentId, action: "transfer", from_department_id: null, to_department_id: cDept },
    ]);
  });

  it("denies anon execute on the function", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc(RPC, { p_employee_id: staffId, p_to_department_id: cDept });
    expect(error?.code).toBe("42501");
    expect(await departmentOf(staffId)).toBe(pDept);
  });
});
