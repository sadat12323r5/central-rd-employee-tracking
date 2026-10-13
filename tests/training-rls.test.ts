// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-95xx employees (a range no other test uses,
// so it never races employees-rls, attendance-rls, interviews-rls or e2e), never the seeded demo
// employees, and removes everything it created in afterAll (training first: the employee FK is
// ON DELETE RESTRICT).
// Privacy rule under test (Story 3.1): only the employee and Administrators can read a training
// entry; no department or manager predicate; nobody signed in can insert, update or delete.
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
// One per-run slot of two consecutive ids (BS-9500..BS-9599).
const base = randomInt(0, 50) * 2;
const ownId = `BS-95${String(base).padStart(2, "0")}`;
const otherId = `BS-95${String(base + 1).padStart(2, "0")}`;
const employeeIds = [ownId, otherId];

const employee = (employee_id: string, email: string, auth_user_id: string | null = null) => ({
  employee_id, name: `Training RLS ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "TR",
  avatar_color: "mint", summary: "Throwaway row created by tests/training-rls.test.ts.", auth_user_id,
});

/** The store over one signed-in client (the LMS stub reads through the same JWT). */
const storeAs = (client: SupabaseClient) => createTrainingStore({
  userClient: async () => client, lms: createStubLmsClient({ userClient: async () => client }),
});

const trainingRow = (employee_id: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), employee_id, programme: `RLS Programme ${run}`, provider: "Test provider", result: "Completed",
  completed_on: "2026-08-20", ...extra,
});

describe.skipIf(!configured)("training history RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-trn-admin-${run}@example.com`;
  const staffEmail = `rls-trn-staff-${run}@example.com`;
  const otherStaffEmail = `rls-trn-other-${run}@example.com`;
  // A future Department Manager: neither an Administrator nor linked to either employee.
  const managerEmail = `rls-trn-manager-${run}@example.com`;
  // Written by the service role (the only writer, as db:seed does).
  const ownNewer = trainingRow(ownId, { programme: `Own newer ${run}`, completed_on: "2026-09-01" });
  const ownOlder = trainingRow(ownId, { programme: `Own older ${run}`, completed_on: "2025-03-15" });
  const otherRow = trainingRow(otherId, { programme: `Other ${run}` });
  const allSignedIn = () => [staffEmail, otherStaffEmail, managerEmail, adminEmail];

  async function createUser(email: string, role: string, employee_id?: string) {
    const app_metadata = employee_id ? { role, employee_id } : { role };
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  // One sign-in per test user per file: Supabase Auth rate-limits sign-ins per IP, and none of
  // these tests sign out, so a shared session per user is equivalent.
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
      employee(ownId, `rls-trn-own-${run}@example.com`, staffUserId),
      employee(otherId, `rls-trn-other-row-${run}@example.com`, otherUserId),
    ]);
    if (error) throw new Error(`Could not insert test employees: ${error.message}`);
    const seeded = await service.from("training_history").insert([ownOlder, ownNewer, otherRow]);
    if (seeded.error) throw new Error(`Could not insert test training (${seeded.error.code}): ${seeded.error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets staff read their own completed training through the store, newest completion first", async () => {
    const staff = await signedIn(staffEmail);
    const list = await storeAs(staff).listFor({ role: "staff", employeeId: ownId });
    // Completed history only (in-progress enrolments come from the LMS through currentFor).
    expect(list).toEqual([
      { id: ownNewer.id, employeeId: ownId, name: ownNewer.programme, provider: "Test provider", progress: 100, date: "2026-09-01", result: "Completed" },
      { id: ownOlder.id, employeeId: ownId, name: ownOlder.programme, provider: "Test provider", progress: 100, date: "2025-03-15", result: "Completed" },
    ]);
  });

  it("never returns another employee's training to staff", async () => {
    const staff = await signedIn(staffEmail);
    const { data, error } = await staff.from("training_history").select("id").eq("employee_id", otherId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const all = await staff.from("training_history").select("employee_id");
    expect(all.error).toBeNull();
    expect(new Set((all.data ?? []).map(r => r.employee_id))).toEqual(new Set([ownId]));
    // Through the store, even as an admin-shaped query (RLS still scopes it to the JWT).
    expect(await storeAs(staff).listFor({ role: "admin" }, otherId)).toEqual([]);
  });

  it("returns none of an employee's training to another staff member", async () => {
    const other = await signedIn(otherStaffEmail);
    const { data, error } = await other.from("training_history").select("id").eq("employee_id", ownId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("returns no training to a manager-role account (no department or manager predicate)", async () => {
    const manager = await signedIn(managerEmail);
    const { data, error } = await manager.from("training_history").select("id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("lets an admin read every employee's training", async () => {
    const admin = await signedIn(adminEmail);
    const all = await storeAs(admin).listFor({ role: "admin" });
    const ids = new Set(all.map(t => t.id));
    for (const row of [ownNewer, ownOlder, otherRow]) expect(ids.has(row.id)).toBe(true);
    const one = await storeAs(admin).listFor({ role: "admin" }, otherId);
    expect(one.map(t => t.id)).toEqual([otherRow.id]);
  });

  it("returns nothing to an anonymous client, and refuses its writes", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("training_history").select("id").in("employee_id", employeeIds);
    expect(data ?? []).toEqual([]);
    expect((await anon.from("training_history").insert(trainingRow(ownId))).error).not.toBeNull();
  });

  it("has no department column", async () => {
    const probe = await service.from("training_history").select("department").limit(1);
    expect(probe.error).not.toBeNull();
  });

  it("refuses inserts from every signed-in role, including for the employee's own record", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      for (const target of employeeIds) {
        const inserted = await client.from("training_history").insert(trainingRow(target));
        expect(inserted.error).not.toBeNull();
      }
    }
    const { data } = await service.from("training_history").select("id").in("employee_id", employeeIds);
    expect(data).toHaveLength(3);
  }, 30_000);

  it("updates nothing for any signed-in role", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      const updated = await client.from("training_history").update({ result: "Changed" }).in("employee_id", employeeIds).select("id");
      expect(updated.data ?? []).toEqual([]);
    }
    const { data } = await service.from("training_history").select("result").in("employee_id", employeeIds);
    expect((data ?? []).map(r => r.result)).toEqual(["Completed", "Completed", "Completed"]);
  }, 30_000);

  it("deletes nothing for any signed-in role", async () => {
    for (const email of allSignedIn()) {
      const client = await signedIn(email);
      const deleted = await client.from("training_history").delete().in("employee_id", employeeIds).select("id");
      expect(deleted.data ?? []).toEqual([]);
    }
    const { data } = await service.from("training_history").select("id").in("id", [ownNewer.id, ownOlder.id, otherRow.id]);
    expect(data).toHaveLength(3);
  }, 30_000);
});
