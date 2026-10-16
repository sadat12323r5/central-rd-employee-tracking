// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, never the seeded demo data.
// Rules under test (Story 4.6): the Administrator, and a manager over the assignment's department (its own
// manager or an ancestor's), write an assignment's evaluation once and then amend it; every write records
// its author from the JWT (created_by kept, authored_by/updated_at the latest writer). Evaluations exist
// only for closed assignments (23514 otherwise), one per assignment (23505), with the employee and
// department copied from the assignment; identifying fields are locked (23514); nothing can be deleted,
// not even with the service role. Staff read only their own evaluations and never write one; a manager
// outside the subtree sees and changes nothing. Each write snapshots the writer's name and role.
// Transfer: when the employee moves to another department, that department's manager may read the
// evaluation (manages_employee) but never write it, while the assignment's own department manager still can.
//
// Evaluations and assignments can never be deleted, so this test cannot remove what it creates. It reuses
// a fixed slot of throwaway employees (BS-9130..BS-9153, a range no other test uses) and fixed-name
// departments ("RLS Eval slot N …"): beforeAll closes any assignment an earlier run left open and opens
// and closes fresh assignments for this run (so this run's evaluations are new); afterAll closes what it
// opened, unlinks and archives the employees, clears the managers and deletes the auth users. Assertions
// only look at this run's assignments, so earlier runs' rows in the same slot never matter.
// Fails with PGRST205 / 42P01 until the 4.1–4.6 migrations are applied.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAssignmentEvaluationsStore, EvaluationAssignmentOpenError, EvaluationExistsError, EvaluationForbiddenError,
} from "@/server/assignment-evaluations-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One of four fixed slots of six consecutive ids (BS-9130..BS-9153).
const slot = randomInt(0, 4);
const idAt = (offset: number) => `BS-91${String(30 + slot * 6 + offset).padStart(2, "0")}`;
const subjectId = idAt(0);        // owning Staff, in the child department
const otherStaffId = idAt(1);     // another Staff member, in the child department
const parentManagerId = idAt(2);  // the parent's manager (no department of their own)
const childManagerId = idAt(3);   // the child's manager
const outsideManagerId = idAt(4); // manages an unrelated department
const employeeIds = [subjectId, otherStaffId, parentManagerId, childManagerId, outsideManagerId];
const PARENT_NAME = `RLS Eval slot ${slot} Parent`;
const CHILD_NAME = `RLS Eval slot ${slot} Child`;
const OUTSIDE_NAME = `RLS Eval slot ${slot} Outside`;
const FAR_FUTURE = "2099-12-31";

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Eval ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-eval-${employee_id.toLowerCase()}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RE", avatar_color: "mint", summary: "Throwaway row reused by tests/assignment-evaluations-rls.test.ts.",
  auth_user_id, department_id, archived_at: null,
});
const assignmentRow = (employee_id: string) => ({
  employee_id, client: `RLS client ${run}`, project_name: `RLS eval project ${run}`, role: "Tester", allocation: 50,
  start_date: "2026-09-01", latest_update: "",
});
const evaluationRow = (assignment_id: string, extra: Record<string, unknown> = {}) => ({
  assignment_id, employee_id: "BS-0000", department_id: "00000000-0000-4000-8000-000000000000",
  evaluation: `RLS evaluation ${run}`, client_feedback: "", ...extra,
});

describe.skipIf(!configured)("assignment evaluations RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-eval-admin-${run}@example.com`;
  const parentManagerEmail = `rls-eval-parent-mgr-${run}@example.com`;
  const childManagerEmail = `rls-eval-child-mgr-${run}@example.com`;
  const outsideManagerEmail = `rls-eval-outside-mgr-${run}@example.com`;
  const subjectEmail = `rls-eval-subject-${run}@example.com`;
  const otherStaffEmail = `rls-eval-other-${run}@example.com`;
  let adminUserId = "";
  let parentManagerUserId = "";
  let childManagerUserId = "";
  let parentId = "";
  let childId = "";
  let outsideId = "";
  /** This run's closed (to evaluate), open, and second closed assignments of the subject; the other Staff member's closed one. */
  let closedId = "";
  let openId = "";
  let closedForStoreId = "";
  let otherClosedId = "";

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

  async function openFor(employee_id: string): Promise<string> {
    const { data, error } = await service.from("assignments").insert(assignmentRow(employee_id)).select("id").single();
    if (error) throw new Error(`Could not insert test assignment (${error.code}): ${error.message}`);
    return data.id as string;
  }

  async function closedFor(employee_id: string): Promise<string> {
    const id = await openFor(employee_id);
    const closed = await service.from("assignments").update({ status: "closed", completion_date: "2026-09-30" }).eq("id", id);
    if (closed.error) throw new Error(`Could not close test assignment (${closed.error.code}): ${closed.error.message}`);
    return id;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    adminUserId = await createUser(adminEmail, { role: "admin" });
    parentManagerUserId = await createUser(parentManagerEmail, { role: "staff", employee_id: parentManagerId });
    childManagerUserId = await createUser(childManagerEmail, { role: "staff", employee_id: childManagerId });
    const outsideManagerUserId = await createUser(outsideManagerEmail, { role: "staff", employee_id: outsideManagerId });
    const subjectUserId = await createUser(subjectEmail, { role: "staff", employee_id: subjectId });
    const otherStaffUserId = await createUser(otherStaffEmail, { role: "staff", employee_id: otherStaffId });
    parentId = await ensureDepartment(PARENT_NAME, null, parentManagerUserId);
    childId = await ensureDepartment(CHILD_NAME, parentId, childManagerUserId);
    outsideId = await ensureDepartment(OUTSIDE_NAME, null, outsideManagerUserId);
    await closeOpen(); // leftovers of an aborted run in the same slot
    const employees = await service.from("employees").upsert([
      employeeRow(subjectId, subjectUserId, childId),
      employeeRow(otherStaffId, otherStaffUserId, childId),
      employeeRow(parentManagerId, parentManagerUserId, null),
      employeeRow(childManagerId, childManagerUserId, null),
      employeeRow(outsideManagerId, outsideManagerUserId, null),
    ], { onConflict: "employee_id", defaultToNull: false });
    if (employees.error) throw new Error(`Could not upsert test employees (${employees.error.code}): ${employees.error.message}`);
    closedId = await closedFor(subjectId);
    closedForStoreId = await closedFor(subjectId);
    openId = await openFor(subjectId);
    otherClosedId = await closedFor(otherStaffId);
    // The other Staff member's evaluation, written by the service role (no JWT: the sent authors are kept).
    const other = await service.from("assignment_evaluations")
      .insert([evaluationRow(otherClosedId, { created_by: adminUserId, authored_by: adminUserId })], { defaultToNull: false });
    if (other.error) throw new Error(`Could not insert test evaluation (${other.error.code}): ${other.error.message}`);
  }, 90_000);

  afterAll(async () => {
    if (!service) return;
    try {
      // Undo the transfer case if it was interrupted.
      await service.from("employees").update({ department_id: childId }).eq("employee_id", subjectId);
      await closeOpen();
      // The rows stay (assignments and evaluations reference them); unlink and archive them so they are inert.
      await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).in("employee_id", employeeIds);
      await service.from("departments").update({ manager_user_id: null }).in("name", [PARENT_NAME, CHILD_NAME, OUTSIDE_NAME]);
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the child's manager write it: subject and department from the assignment, authors from the JWT", async () => {
    const child = await signedIn(childManagerEmail);
    const { data, error } = await child.from("assignment_evaluations")
      .insert(evaluationRow(closedId, { employee_id: otherStaffId, department_id: parentId, client_feedback: "Happy client.", created_by: adminUserId }))
      .select("employee_id,department_id,created_by,authored_by,created_at,updated_at,client_feedback").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      employee_id: subjectId, department_id: childId, created_by: childManagerUserId, authored_by: childManagerUserId, client_feedback: "Happy client.",
    });
    // The authorship snapshot: the writer's employee name and role, whatever was sent.
    const snapshot = await service.from("assignment_evaluations")
      .select("created_by_name,created_by_role,authored_by_name,authored_by_role").eq("assignment_id", closedId).single();
    expect(snapshot.data).toEqual({
      created_by_name: `RLS Eval ${childManagerId}`, created_by_role: "manager", authored_by_name: `RLS Eval ${childManagerId}`, authored_by_role: "manager",
    });
    expect(data?.created_at).toBe(data?.updated_at);
  });

  it("refuses a second evaluation of the same assignment (23505), even for the Administrator", async () => {
    const admin = await signedIn(adminEmail);
    const { error } = await admin.from("assignment_evaluations").insert(evaluationRow(closedId)).select("id");
    expect(error?.code).toBe("23505");
  });

  it("refuses an evaluation of an open assignment (23514) and leaves it open", async () => {
    const admin = await signedIn(adminEmail);
    const { error } = await admin.from("assignment_evaluations").insert(evaluationRow(openId)).select("id");
    expect(error?.code).toBe("23514");
    const { data } = await service.from("assignments").select("status").eq("id", openId).single();
    expect(data?.status).toBe("open");
  });

  it("scopes reads: managers over the department see both, the outside manager none, Staff only their own", async () => {
    const mine = [closedId, otherClosedId];
    const expectations: [string, string[]][] = [
      [adminEmail, [closedId, otherClosedId]],
      [parentManagerEmail, [closedId, otherClosedId]],
      [childManagerEmail, [closedId, otherClosedId]],
      [outsideManagerEmail, []],
      [subjectEmail, [closedId]],
      [otherStaffEmail, [otherClosedId]],
    ];
    for (const [email, expected] of expectations) {
      const client = await signedIn(email);
      const { data, error } = await client.from("assignment_evaluations").select("assignment_id").in("assignment_id", mine);
      expect(error, email).toBeNull();
      expect((data ?? []).map(r => r.assignment_id).sort(), email).toEqual([...expected].sort());
    }
  });

  it("refuses Staff writes, their own assignment included, and an outside manager's", async () => {
    const subject = await signedIn(subjectEmail);
    expect((await subject.from("assignment_evaluations").insert(evaluationRow(closedForStoreId)).select("id")).error).not.toBeNull();
    const own = await subject.from("assignment_evaluations").update({ evaluation: "Staff edits own" }).eq("assignment_id", closedId).select("id");
    expect(own.data ?? []).toEqual([]);
    const outside = await signedIn(outsideManagerEmail);
    expect((await outside.from("assignment_evaluations").insert(evaluationRow(closedForStoreId)).select("id")).error).not.toBeNull();
    const amend = await outside.from("assignment_evaluations").update({ evaluation: "Outside edits" }).eq("assignment_id", closedId).select("id");
    expect(amend.data ?? []).toEqual([]);
    const { data } = await service.from("assignment_evaluations").select("evaluation").eq("assignment_id", closedId).single();
    expect(data?.evaluation).toBe(`RLS evaluation ${run}`);
  });

  it("lets the parent's manager amend: authored_by and updated_at change, created_by is kept", async () => {
    const before = await service.from("assignment_evaluations").select("updated_at").eq("assignment_id", closedId).single();
    const parent = await signedIn(parentManagerEmail);
    const { data, error } = await parent.from("assignment_evaluations")
      .update({ evaluation: "Amended by the parent manager.", client_feedback: "", authored_by: adminUserId, authored_by_name: "Forged", authored_by_role: "admin" })
      .eq("assignment_id", closedId)
      .select("evaluation,client_feedback,created_by,authored_by,updated_at,created_by_name,created_by_role,authored_by_name,authored_by_role").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      evaluation: "Amended by the parent manager.", client_feedback: "", created_by: childManagerUserId, authored_by: parentManagerUserId,
      created_by_name: `RLS Eval ${childManagerId}`, created_by_role: "manager",
      authored_by_name: `RLS Eval ${parentManagerId}`, authored_by_role: "manager",
    });
    expect(Date.parse(data!.updated_at as string)).toBeGreaterThan(Date.parse(before.data!.updated_at as string));
  });

  it("locks the identifying fields (23514), for the Administrator and the service role too", async () => {
    const admin = await signedIn(adminEmail);
    const changes: Record<string, unknown>[] = [
      { assignment_id: otherClosedId }, { employee_id: otherStaffId }, { department_id: parentId }, { created_by: adminUserId },
      { created_at: "2026-01-01T00:00:00Z" }, { created_by_name: "Changed" }, { created_by_role: "admin" },
    ];
    for (const change of changes) {
      const { error } = await admin.from("assignment_evaluations").update(change).eq("assignment_id", closedId).select("id");
      expect(error?.code, JSON.stringify(change)).toBe("23514");
    }
    expect((await service.from("assignment_evaluations").update({ employee_id: otherStaffId }).eq("assignment_id", closedId)).error?.code).toBe("23514");
  });

  it("never deletes an evaluation: no policy for users, and the trigger refuses the service role", async () => {
    const admin = await signedIn(adminEmail);
    const asAdmin = await admin.from("assignment_evaluations").delete().eq("assignment_id", closedId).select("id");
    expect(asAdmin.data ?? []).toEqual([]);
    const asService = await service.from("assignment_evaluations").delete().eq("assignment_id", closedId);
    expect(asService.error).not.toBeNull();
    const { data } = await service.from("assignment_evaluations").select("id").eq("assignment_id", closedId);
    expect(data).toHaveLength(1);
  });

  it("has the store agree with RLS for the child's manager", async () => {
    const client = await signedIn(childManagerEmail);
    const session = { role: "manager", employeeId: childManagerId, userId: childManagerUserId } as const;
    const userClient = async () => client;
    const store = createAssignmentEvaluationsStore({ userClient, scope: createManagerScope({ userClient }) });
    const listed = (await store.listFor(session, subjectId)).map(e => e.assignmentId);
    expect(listed).toContain(closedId);
    await expect(store.create(session, openId, { evaluation: "x", clientFeedback: "" })).rejects.toBeInstanceOf(EvaluationAssignmentOpenError);
    await expect(store.create(session, closedId, { evaluation: "x", clientFeedback: "" })).rejects.toBeInstanceOf(EvaluationExistsError);
    const saved = await store.create(session, closedForStoreId, { evaluation: " Store evaluation. ", clientFeedback: "" });
    expect(saved).toMatchObject({ employeeId: subjectId, departmentId: childId, evaluation: "Store evaluation.", createdBy: childManagerUserId });
    const amended = await store.amend(session, closedForStoreId, { evaluation: "Store amendment.", clientFeedback: "Relayed." });
    expect(amended).toMatchObject({ evaluation: "Store amendment.", clientFeedback: "Relayed.", authoredBy: childManagerUserId });

    const outside = await signedIn(outsideManagerEmail);
    const outsideClient = async () => outside;
    const outsideUserId = (await outside.auth.getUser()).data.user!.id;
    const outsideStore = createAssignmentEvaluationsStore({ userClient: outsideClient, scope: createManagerScope({ userClient: outsideClient }) });
    const outsideSession = { role: "manager", employeeId: outsideManagerId, userId: outsideUserId } as const;
    expect(await outsideStore.listFor(outsideSession, subjectId)).toEqual([]);
    await expect(outsideStore.amend(outsideSession, closedId, { evaluation: "x", clientFeedback: "" })).rejects.toBeInstanceOf(EvaluationForbiddenError);
  });

  it("after a transfer, the new department's manager reads but never writes; the assignment's own manager still writes", async () => {
    const moved = await service.from("employees").update({ department_id: outsideId }).eq("employee_id", subjectId);
    if (moved.error) throw new Error(`Could not transfer the test employee (${moved.error.code}): ${moved.error.message}`);
    try {
      const outside = await signedIn(outsideManagerEmail);
      const read = await outside.from("assignment_evaluations").select("assignment_id").eq("assignment_id", closedId);
      expect(read.error).toBeNull();
      expect(read.data).toEqual([{ assignment_id: closedId }]);
      const update = await outside.from("assignment_evaluations").update({ evaluation: "Outside after transfer" }).eq("assignment_id", closedId).select("id");
      expect(update.data ?? []).toEqual([]);
      const insert = await outside.from("assignment_evaluations").insert(evaluationRow(closedForStoreId)).select("id");
      expect(insert.error).not.toBeNull();

      const child = await signedIn(childManagerEmail);
      const amended = await child.from("assignment_evaluations").update({ evaluation: "Amended after the transfer." })
        .eq("assignment_id", closedId).select("evaluation,authored_by");
      expect(amended.error).toBeNull();
      expect(amended.data).toEqual([{ evaluation: "Amended after the transfer.", authored_by: childManagerUserId }]);
      // The store finds the assignment through assignments_select_department_managed (manages_employee no longer holds).
      const userClient = async () => child;
      const store = createAssignmentEvaluationsStore({ userClient, scope: createManagerScope({ userClient }) });
      const session = { role: "manager", employeeId: childManagerId, userId: childManagerUserId } as const;
      await expect(store.amend(session, closedId, { evaluation: "Store amendment after the transfer.", clientFeedback: "" }))
        .resolves.toMatchObject({ evaluation: "Store amendment after the transfer.", departmentId: childId, employeeId: subjectId });
    } finally {
      await service.from("employees").update({ department_id: childId }).eq("employee_id", subjectId);
    }
  });
});
