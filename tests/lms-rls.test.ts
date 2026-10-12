// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-94xx employees (a range no other test uses,
// so it never races training-rls, interviews-rls, attendance-rls, employees-rls or e2e), never the
// seeded demo employees, and removes everything it created in afterAll (stub enrolments first: the
// employee FK is ON DELETE RESTRICT).
// Privacy rule under test (Story 3.2): only the employee and Administrators can read an LMS stub
// enrolment; no department or manager predicate; nobody signed in can insert, update or delete. The
// LMS adapter stub, reading through a staff JWT, returns only that employee's rows.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStubLmsClient } from "@/server/lms-client";
import { createTrainingStore } from "@/server/training-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One per-run slot of two consecutive ids (BS-9400..BS-9499).
const base = randomInt(0, 50) * 2;
const ownId = `BS-94${String(base).padStart(2, "0")}`;
const otherId = `BS-94${String(base + 1).padStart(2, "0")}`;
const employeeIds = [ownId, otherId];
const TABLE = "lms_stub_enrolments";

const employee = (employee_id: string, email: string, auth_user_id: string | null = null) => ({
  employee_id, name: `LMS RLS ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "LR",
  avatar_color: "mint", summary: "Throwaway row created by tests/lms-rls.test.ts.", auth_user_id,
});

const enrolmentRow = (employee_id: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), employee_id, programme: `LMS RLS Programme ${run}`, provider: "Test provider", status: "in_progress",
  progress: 40, target_date: "2026-12-01", ...extra,
});

describe.skipIf(!configured)("LMS stub enrolments RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-lms-admin-${run}@example.com`;
  const staffEmail = `rls-lms-staff-${run}@example.com`;
  const otherStaffEmail = `rls-lms-other-${run}@example.com`;
  // A future Department Manager: neither an Administrator nor linked to either employee.
  const managerEmail = `rls-lms-manager-${run}@example.com`;
  // Written by the service role (the only writer, as db:seed does).
  const ownInProgress = enrolmentRow(ownId, { programme: `Own in progress ${run}` });
  const ownCompleted = enrolmentRow(ownId, {
    programme: `Own completed ${run}`, status: "completed", progress: 100, target_date: null, completed_on: "2026-09-15", result: "Passed",
  });
  const otherRow = enrolmentRow(otherId, { programme: `Other ${run}` });
  const allSignedIn = () => [staffEmail, otherStaffEmail, managerEmail, adminEmail];

  async function createUser(email: string, role: string, employee_id?: string) {
    const app_metadata = employee_id ? { role, employee_id } : { role };
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  async function signedIn(email: string) {
    const client = createClient(url!, anonKey!, noSession);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Could not sign in test user: ${error.message}`);
    return client;
  }

  async function cleanup() {
    const enrolmentsDeleted = await service.from(TABLE).delete().in("employee_id", employeeIds);
    if (enrolmentsDeleted.error) throw new Error(`Could not delete test enrolments (${enrolmentsDeleted.error.code}): ${enrolmentsDeleted.error.message}`);
    const trainingDeleted = await service.from("training_history").delete().in("employee_id", employeeIds);
    if (trainingDeleted.error) throw new Error(`Could not delete test training (${trainingDeleted.error.code}): ${trainingDeleted.error.message}`);
    const employeesDeleted = await service.from("employees").delete().in("employee_id", employeeIds);
    if (employeesDeleted.error) throw new Error(`Could not delete test employees (${employeesDeleted.error.code}): ${employeesDeleted.error.message}`);
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run
    await createUser(adminEmail, "admin");
    const staffUserId = await createUser(staffEmail, "staff", ownId);
    const otherUserId = await createUser(otherStaffEmail, "staff", otherId);
    await createUser(managerEmail, "manager");
    const { error } = await service.from("employees").insert([
      employee(ownId, `rls-lms-own-${run}@example.com`, staffUserId),
      employee(otherId, `rls-lms-other-row-${run}@example.com`, otherUserId),
    ]);
    if (error) throw new Error(`Could not insert test employees: ${error.message}`);
    const seeded = await service.from(TABLE).insert([ownInProgress, ownCompleted, otherRow]);
    if (seeded.error) throw new Error(`Could not insert test enrolments (${seeded.error.code}): ${seeded.error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets staff read their own enrolments through the LMS stub, fresh (just synced)", async () => {
    const staff = await signedIn(staffEmail);
    const result = await createStubLmsClient({ userClient: async () => staff }).listCurrentEnrolments(ownId);
    expect(new Set(result.data.map(e => e.id))).toEqual(new Set([ownInProgress.id, ownCompleted.id]));
    expect(result.stale).toBe(false);
    // Asking the stub for another employee through a staff JWT returns nothing (RLS).
    expect((await createStubLmsClient({ userClient: async () => staff }).listCurrentEnrolments(otherId)).data).toEqual([]);
  });

  it("splits them through training-store: in progress in Current, completed in history", async () => {
    const staff = await signedIn(staffEmail);
    const store = createTrainingStore({ userClient: async () => staff, lms: createStubLmsClient({ userClient: async () => staff }) });
    const current = await store.currentFor({ role: "staff", employeeId: ownId }, [ownId, otherId]);
    expect(current).toMatchObject({ status: "ok", stale: false });
    if (current.status !== "ok") return;
    expect(current.inProgress.map(t => t.id)).toEqual([ownInProgress.id]);
    expect(current.lmsCompleted.map(t => t.id)).toEqual([ownCompleted.id]);
  });

  it("returns none of an employee's enrolments to another staff member", async () => {
    const other = await signedIn(otherStaffEmail);
    const { data, error } = await other.from(TABLE).select("id").eq("employee_id", ownId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("returns no enrolments to a manager-role account (no department or manager predicate)", async () => {
    const manager = await signedIn(managerEmail);
    const { data, error } = await manager.from(TABLE).select("id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("lets an admin read every employee's enrolments", async () => {
    const admin = await signedIn(adminEmail);
    const { data, error } = await admin.from(TABLE).select("id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(new Set((data ?? []).map(r => r.id))).toEqual(new Set([ownInProgress.id, ownCompleted.id, otherRow.id]));
    const store = createTrainingStore({ userClient: async () => admin, lms: createStubLmsClient({ userClient: async () => admin }) });
    const current = await store.currentFor({ role: "admin" }, employeeIds);
    expect(current.status === "ok" && current.inProgress.map(t => t.id).sort()).toEqual([ownInProgress.id, otherRow.id].sort());
  });

  it("returns nothing to an anonymous client, and refuses its writes", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from(TABLE).select("id").in("employee_id", employeeIds);
    expect(data ?? []).toEqual([]);
    expect((await anon.from(TABLE).insert(enrolmentRow(ownId))).error).not.toBeNull();
  });

  it("has no department column", async () => {
    const probe = await service.from(TABLE).select("department").limit(1);
    expect(probe.error).not.toBeNull();
  });

  it("refuses rows that break the status rules, even from the service role", async () => {
    for (const bad of [
      enrolmentRow(ownId, { progress: 100 }), // in progress at 100%
      enrolmentRow(ownId, { target_date: null }), // in progress without a target date
      enrolmentRow(ownId, { status: "completed", progress: 100, completed_on: null }), // completed without a date
      enrolmentRow(ownId, { status: "paused" }),
      enrolmentRow(ownId, { progress: 101 }),
    ]) {
      expect((await service.from(TABLE).insert(bad)).error).not.toBeNull();
    }
  });

  it("refuses inserts from every signed-in role, including for the employee's own record", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      for (const target of employeeIds) {
        const inserted = await client.from(TABLE).insert(enrolmentRow(target));
        expect(inserted.error).not.toBeNull();
      }
    }
    const { data } = await service.from(TABLE).select("id").in("employee_id", employeeIds);
    expect(data).toHaveLength(3);
  }, 30_000);

  it("updates nothing for any signed-in role", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      const updated = await client.from(TABLE).update({ progress: 99 }).in("employee_id", employeeIds).select("id");
      expect(updated.data ?? []).toEqual([]);
    }
    const { data } = await service.from(TABLE).select("progress").in("employee_id", employeeIds);
    expect((data ?? []).map(r => r.progress).sort()).toEqual([100, 40, 40].sort());
  }, 30_000);

  it("deletes nothing for any signed-in role", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      const deleted = await client.from(TABLE).delete().in("employee_id", employeeIds).select("id");
      expect(deleted.data ?? []).toEqual([]);
    }
    const { data } = await service.from(TABLE).select("id").in("id", [ownInProgress.id, ownCompleted.id, otherRow.id]);
    expect(data).toHaveLength(3);
  }, 30_000);
});
