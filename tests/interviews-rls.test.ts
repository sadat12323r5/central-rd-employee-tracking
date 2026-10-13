// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-96xx employees (a range no other test uses,
// so it never races employees-rls.test.ts, attendance-rls.test.ts or e2e), never the seeded demo
// employees, and removes everything it created in afterAll (interviews first: the employee FK is
// ON DELETE RESTRICT).
// Privacy rule under test: only the reporting employee and Administrators can read an interview.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInterviewsStore, InterviewsUnavailableError } from "@/server/interviews-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One per-run slot of two consecutive ids (BS-9600..BS-9699).
const base = randomInt(0, 50) * 2;
const ownId = `BS-96${String(base).padStart(2, "0")}`;
const otherId = `BS-96${String(base + 1).padStart(2, "0")}`;
const employeeIds = [ownId, otherId];

const employee = (employee_id: string, email: string, auth_user_id: string | null = null) => ({
  employee_id, name: `Interviews RLS ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "IR",
  avatar_color: "mint", summary: "Throwaway row created by tests/interviews-rls.test.ts.", auth_user_id,
});

const interviewRow = (employee_id: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), employee_id, company: `RLS Co ${run}`, role: "Test role", stage: "Screening", interview_date: "2026-10-01",
  outcome: "", ...extra,
});

describe.skipIf(!configured)("external interviews RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-int-admin-${run}@example.com`;
  const staffEmail = `rls-int-staff-${run}@example.com`;
  const otherStaffEmail = `rls-int-other-${run}@example.com`;
  // A future Department Manager: neither an Administrator nor linked to either employee.
  const managerEmail = `rls-int-manager-${run}@example.com`;
  // Written by the service role: one interview per throwaway employee.
  const ownRow = interviewRow(ownId, { stage: "Own stage" });
  const otherRow = interviewRow(otherId, { stage: "Other stage", feedback: "Private feedback" });

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
    const interviewsDeleted = await service.from("external_interviews").delete().in("employee_id", employeeIds);
    if (interviewsDeleted.error) throw new Error(`Could not delete test interviews (${interviewsDeleted.error.code}): ${interviewsDeleted.error.message}`);
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
      employee(ownId, `rls-int-own-${run}@example.com`, staffUserId),
      employee(otherId, `rls-int-other-row-${run}@example.com`, otherUserId),
    ]);
    if (error) throw new Error(`Could not insert test employees: ${error.message}`);
    const seeded = await service.from("external_interviews").insert([ownRow, otherRow], { defaultToNull: false });
    if (seeded.error) throw new Error(`Could not insert test interviews (${seeded.error.code}): ${seeded.error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets staff add an interview for themselves through the store and read it back", async () => {
    const staff = await signedIn(staffEmail);
    const store = createInterviewsStore({ userClient: async () => staff });
    const saved = await store.add({ role: "staff", employeeId: ownId }, {
      company: `Added Co ${run}`, role: "Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "",
    });
    expect(saved).toMatchObject({ employeeId: ownId, company: `Added Co ${run}`, outcome: "", feedback: "" });
    const listed = await store.listFor({ role: "staff", employeeId: ownId });
    expect(listed.map(i => i.id)).toEqual(expect.arrayContaining([saved.id, ownRow.id]));
    expect(new Set(listed.map(i => i.employeeId))).toEqual(new Set([ownId]));
  });

  it("never returns another employee's interviews to staff", async () => {
    const staff = await signedIn(staffEmail);
    const { data, error } = await staff.from("external_interviews").select("id,employee_id").eq("employee_id", otherId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const all = await staff.from("external_interviews").select("employee_id");
    expect(all.error).toBeNull();
    expect(new Set((all.data ?? []).map(r => r.employee_id))).toEqual(new Set([ownId]));
    // Through the store, even as an admin-shaped query (RLS still scopes it to the JWT).
    expect(await createInterviewsStore({ userClient: async () => staff }).listFor({ role: "admin" }, otherId)).toEqual([]);
  });

  it("returns none of an employee's interviews to another staff member", async () => {
    const other = await signedIn(otherStaffEmail);
    const { data, error } = await other.from("external_interviews").select("id").eq("employee_id", ownId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("returns no interviews to a manager-role account (no department or manager predicate)", async () => {
    const manager = await signedIn(managerEmail);
    const { data, error } = await manager.from("external_interviews").select("id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses a staff insert for another employee", async () => {
    const staff = await signedIn(staffEmail);
    const inserted = await staff.from("external_interviews").insert(interviewRow(otherId));
    expect(inserted.error).not.toBeNull();
    const { data } = await service.from("external_interviews").select("id").eq("employee_id", otherId);
    expect(data).toEqual([{ id: otherRow.id }]);
  });

  it("lets an admin read every employee's interviews", async () => {
    const admin = await signedIn(adminEmail);
    const all = await createInterviewsStore({ userClient: async () => admin }).listFor({ role: "admin" });
    const ids = new Set(all.map(i => i.id));
    expect(ids.has(ownRow.id)).toBe(true);
    expect(ids.has(otherRow.id)).toBe(true);
  });

  it("gives an admin no write path", async () => {
    const admin = await signedIn(adminEmail);
    const inserted = await admin.from("external_interviews").insert(interviewRow(otherId));
    expect(inserted.error).not.toBeNull();
  });

  it("returns nothing to an anonymous client", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("external_interviews").select("id").in("employee_id", employeeIds);
    expect(data ?? []).toEqual([]);
    expect((await anon.from("external_interviews").insert(interviewRow(ownId))).error).not.toBeNull();
  });

  it("lets nobody signed in update or delete interviews", async () => {
    for (const email of [staffEmail, otherStaffEmail, managerEmail, adminEmail]) {
      const client = await signedIn(email);
      const updated = await client.from("external_interviews").update({ stage: "Changed" }).in("employee_id", employeeIds).select("id");
      expect(updated.data ?? []).toEqual([]);
      const deleted = await client.from("external_interviews").delete().in("employee_id", employeeIds).select("id");
      expect(deleted.data ?? []).toEqual([]);
    }
    const { data } = await service.from("external_interviews").select("id,stage").in("id", [ownRow.id, otherRow.id]).order("id");
    expect(data).toEqual([ownRow, otherRow].sort((a, b) => a.id.localeCompare(b.id)).map(r => ({ id: r.id, stage: r.stage })));
  });

  it("surfaces a refused store write as unavailable, never as saved", async () => {
    const staff = await signedIn(staffEmail);
    // A staff session claiming another employee: the store sends the session's employee, RLS refuses it.
    const store = createInterviewsStore({ userClient: async () => staff });
    await expect(store.add({ role: "staff", employeeId: otherId }, {
      company: "Forged", role: "x", date: "2026-10-20", stage: "x", outcome: "",
    })).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });
});
