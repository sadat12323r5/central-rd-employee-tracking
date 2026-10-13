// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-96xx employees (a range no other test uses,
// so it never races employees-rls.test.ts, attendance-rls.test.ts or e2e), never the seeded demo
// employees, and removes everything it created in afterAll (interviews first: the employee FK is
// ON DELETE RESTRICT).
// Privacy rule under test: only the reporting employee and Administrators can read an interview.
// Story 2.2: only the author can update stage/outcome/feedback or withdraw; company, role and date are
// locked for everyone (trigger, including the service role); a withdrawn row never changes; no deletes.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInterviewsStore, InterviewNotFoundError, InterviewsUnavailableError, InterviewWithdrawnError,
} from "@/server/interviews-store";

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
  outcome: "", feedback: "", ...extra,
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
  // Story 2.2: the author withdraws this one (kept separate so test order does not matter).
  const withdrawRow = interviewRow(ownId, { stage: "To withdraw", company: `Mistake Co ${run}` });

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
    const seeded = await service.from("external_interviews").insert([ownRow, otherRow, withdrawRow], { defaultToNull: false });
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

  it("lets the author update stage, outcome and feedback of their own interview, through the store", async () => {
    const staff = await signedIn(staffEmail);
    const store = createInterviewsStore({ userClient: async () => staff });
    const saved = await store.update({ role: "staff", employeeId: ownId }, ownRow.id, { stage: "Final round", outcome: "Awaiting offer", feedback: "Went well." });
    expect(saved).toMatchObject({ id: ownRow.id, employeeId: ownId, company: ownRow.company, date: "2026-10-01", stage: "Final round", outcome: "Awaiting offer", feedback: "Went well.", withdrawn: false });
    const { data } = await service.from("external_interviews").select("stage,outcome,feedback,company").eq("id", ownRow.id).single();
    expect(data).toEqual({ stage: "Final round", outcome: "Awaiting offer", feedback: "Went well.", company: ownRow.company });
  });

  it("updates nothing for another staff member, a manager or an admin", async () => {
    for (const email of [otherStaffEmail, managerEmail, adminEmail]) {
      const client = await signedIn(email);
      const updated = await client.from("external_interviews").update({ stage: "Changed" }).eq("id", ownRow.id).select("id");
      expect(updated.data ?? []).toEqual([]);
    }
    const staff = await signedIn(staffEmail);
    const updated = await staff.from("external_interviews").update({ stage: "Changed" }).eq("id", otherRow.id).select("id");
    expect(updated.data ?? []).toEqual([]);
    await expect(createInterviewsStore({ userClient: async () => staff }).update({ role: "staff", employeeId: ownId }, otherRow.id, {
      stage: "Changed", outcome: "", feedback: "",
    })).rejects.toBeInstanceOf(InterviewNotFoundError);
    const { data } = await service.from("external_interviews").select("stage").eq("id", otherRow.id).single();
    expect(data).toEqual({ stage: otherRow.stage });
  }, 30_000);

  it("refuses changes to company, role or date for the author and the service role (trigger)", async () => {
    // Fail on the missing Story 2.2 schema before writing anything: without the trigger the service-role
    // updates below would really change the row.
    const probe = await service.from("external_interviews").select("withdrawn_at").limit(1);
    expect(probe.error).toBeNull();
    const staff = await signedIn(staffEmail);
    for (const change of [{ company: "Changed" }, { role: "Changed" }, { interview_date: "2026-12-01" }, { employee_id: otherId }]) {
      const byAuthor = await staff.from("external_interviews").update(change).eq("id", ownRow.id).select("id");
      expect(byAuthor.error).not.toBeNull();
      const byService = await service.from("external_interviews").update(change).eq("id", ownRow.id).select("id");
      expect(byService.error?.code).toBe("23514");
    }
    const { data } = await service.from("external_interviews").select("company,role,interview_date,employee_id").eq("id", ownRow.id).single();
    expect(data).toEqual({ company: ownRow.company, role: ownRow.role, interview_date: ownRow.interview_date, employee_id: ownId });
  });

  it("lets the author withdraw once; the withdrawn row can never change again; a corrected entry is saved normally", async () => {
    const staff = await signedIn(staffEmail);
    const session = { role: "staff", employeeId: ownId } as const;
    const store = createInterviewsStore({ userClient: async () => staff });
    expect((await store.withdraw(session, withdrawRow.id)).withdrawn).toBe(true);
    const before = await service.from("external_interviews").select("*").eq("id", withdrawRow.id).single();
    expect(before.data?.withdrawn_at).not.toBeNull();

    await expect(store.withdraw(session, withdrawRow.id)).rejects.toBeInstanceOf(InterviewWithdrawnError);
    await expect(store.update(session, withdrawRow.id, { stage: "Changed", outcome: "", feedback: "" })).rejects.toBeInstanceOf(InterviewWithdrawnError);
    // Bypassing the store: the trigger refuses the author and the service role alike.
    expect((await staff.from("external_interviews").update({ stage: "Changed" }).eq("id", withdrawRow.id).select("id")).error).not.toBeNull();
    expect((await service.from("external_interviews").update({ withdrawn_at: null }).eq("id", withdrawRow.id)).error?.code).toBe("23514");
    // An update that changes nothing is not a change: the trigger lets it through and the row stays as it was.
    const unchanged = await service.from("external_interviews").update({ stage: before.data!.stage }).eq("id", withdrawRow.id);
    expect(unchanged.error).toBeNull();
    expect((await service.from("external_interviews").select("*").eq("id", withdrawRow.id).single()).data).toEqual(before.data);

    const corrected = await store.add(session, { company: `Corrected Co ${run}`, role: "Engineer", date: "2026-10-01", stage: "Screening", outcome: "" });
    expect(corrected.withdrawn).toBe(false);
    const after = await service.from("external_interviews").select("*").eq("id", withdrawRow.id).single();
    expect(after.data).toEqual(before.data);
    // Still visible to the Administrator, marked withdrawn.
    const admin = await signedIn(adminEmail);
    const seen = (await createInterviewsStore({ userClient: async () => admin }).listFor({ role: "admin" }, ownId)).find(i => i.id === withdrawRow.id);
    expect(seen?.withdrawn).toBe(true);
  }, 30_000);

  it("stamps withdrawn_at with the database time, ignoring an author-supplied value", async () => {
    const row = interviewRow(ownId, { stage: "Backdated withdraw" });
    const inserted = await service.from("external_interviews").insert(row);
    if (inserted.error) throw new Error(`Could not insert test interview: ${inserted.error.message}`);
    const staff = await signedIn(staffEmail);
    const started = Date.now();
    const updated = await staff.from("external_interviews").update({ withdrawn_at: "2000-01-01T00:00:00Z" }).eq("id", row.id).select("withdrawn_at").single();
    expect(updated.error).toBeNull();
    const stamped = Date.parse(updated.data!.withdrawn_at as string);
    // Allows for clock skew between this machine and the database.
    expect(Math.abs(stamped - started)).toBeLessThan(5 * 60_000);
  });

  it("lets nobody signed in delete interviews", async () => {
    for (const email of [staffEmail, otherStaffEmail, managerEmail, adminEmail]) {
      const client = await signedIn(email);
      const deleted = await client.from("external_interviews").delete().in("employee_id", employeeIds).select("id");
      expect(deleted.data ?? []).toEqual([]);
    }
    const { data } = await service.from("external_interviews").select("id").in("id", [ownRow.id, otherRow.id, withdrawRow.id]);
    expect(data).toHaveLength(3);
  }, 30_000);

  it("surfaces a refused store write as unavailable, never as saved", async () => {
    const staff = await signedIn(staffEmail);
    // A staff session claiming another employee: the store sends the session's employee, RLS refuses it.
    const store = createInterviewsStore({ userClient: async () => staff });
    await expect(store.add({ role: "staff", employeeId: otherId }, {
      company: "Forged", role: "x", date: "2026-10-20", stage: "x", outcome: "",
    })).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });
});
