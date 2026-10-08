// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-99xx rows, never the seeded demo employees,
// and removes everything it created in afterAll.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One per-run slot of three consecutive ids (BS-9900..BS-9995), so concurrent runs rarely collide.
// BS-9998 and BS-9999 belong to tests/accounts-store.test.ts.
const base = randomInt(0, 32) * 3;
const idAt = (offset: number) => `BS-99${String(base + offset).padStart(2, "0")}`;
const ownId = idAt(0);
const otherId = idAt(1);
const spareId = idAt(2); // never inserted successfully; used for rejected writes

const row = (employee_id: string, email: string, auth_user_id: string | null = null) => ({
  employee_id, name: `RLS Test ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "RT",
  avatar_color: "mint", summary: "Throwaway row created by tests/employees-rls.test.ts.", auth_user_id,
});

describe.skipIf(!configured)("employees RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const employeeIds = [ownId, otherId, spareId];
  const adminEmail = `rls-admin-${run}@example.com`;
  const staffEmail = `rls-staff-${run}@example.com`;

  async function createUser(email: string, role: string) {
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role } });
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

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await service.from("employees").delete().in("employee_id", employeeIds); // leftovers from an aborted run
    await createUser(adminEmail, "admin");
    const staffUserId = await createUser(staffEmail, "staff");
    const { error } = await service.from("employees").insert([
      row(ownId, `rls-own-${run}@example.com`, staffUserId),
      row(otherId, `rls-other-${run}@example.com`),
    ]);
    if (error) throw new Error(`Could not insert test employees: ${error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    await service.from("employees").delete().in("employee_id", employeeIds);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  }, 30_000);

  it("lets an admin read every row", async () => {
    const admin = await signedIn(adminEmail);
    const { data, error } = await admin.from("employees").select("employee_id").order("employee_id");
    expect(error).toBeNull();
    const ids = data!.map(r => r.employee_id);
    // This run's rows: exactly what the service role sees for the same ids.
    const { data: runRows } = await service.from("employees").select("employee_id").in("employee_id", employeeIds).order("employee_id");
    expect(ids.filter(id => employeeIds.includes(id))).toEqual(runRows!.map(r => r.employee_id));
    expect(ids).toEqual(expect.arrayContaining([ownId, otherId]));
    // Rows this run did not create (the seeded employees) are visible too.
    expect(ids.some(id => !employeeIds.includes(id))).toBe(true);
  });

  it("lets staff read only their own row", async () => {
    const staff = await signedIn(staffEmail);
    const { data, error } = await staff.from("employees").select("employee_id");
    expect(error).toBeNull();
    expect(data).toEqual([{ employee_id: ownId }]);
  });

  it("returns nothing to an anonymous client", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("employees").select("employee_id");
    expect(data ?? []).toEqual([]);
  });

  it("does not let a signed-in user write employees", async () => {
    const admin = await signedIn(adminEmail);
    const { error } = await admin.from("employees").insert(row(spareId, `rls-write-${run}@example.com`));
    expect(error).not.toBeNull();
    const { data } = await service.from("employees").select("employee_id").eq("employee_id", spareId);
    expect(data).toEqual([]);
  });

  it("rejects a duplicate Employee ID", async () => {
    const { error } = await service.from("employees").insert(row(ownId, `rls-dup-id-${run}@example.com`));
    expect(error?.code).toBe("23505");
  });

  it("rejects a duplicate email", async () => {
    const { data: existing } = await service.from("employees").select("employee_id").eq("employee_id", spareId);
    expect(existing).toEqual([]); // so a conflict can only come from the email
    const { error } = await service.from("employees").insert(row(spareId, `rls-own-${run}@example.com`));
    expect(error?.code).toBe("23505");
    expect(error?.message).toMatch(/email/);
  });

  it("does not let a staff JWT, an admin JWT or the anon client archive or restore through set_employee_archived", async () => {
    const clients = [await signedIn(staffEmail), await signedIn(adminEmail), createClient(url!, anonKey!, noSession)];
    for (const client of clients) {
      for (const [employee, archived] of [[ownId, true], [otherId, true], [ownId, false]] as const) {
        const { error } = await client.rpc("set_employee_archived", { p_employee_id: employee, p_archived: archived, p_actor: userIds[1] });
        expect(error).not.toBeNull();
      }
    }
    const { data } = await service.from("employees").select("employee_id,archived_at").in("employee_id", [ownId, otherId]).order("employee_id");
    expect(data).toEqual([{ employee_id: ownId, archived_at: null }, { employee_id: otherId, archived_at: null }]);
  });

  it("does not let a signed-in user change archived_at directly", async () => {
    for (const client of [await signedIn(staffEmail), await signedIn(adminEmail)]) {
      await client.from("employees").update({ archived_at: new Date().toISOString() }).eq("employee_id", ownId);
    }
    const { data } = await service.from("employees").select("archived_at").eq("employee_id", ownId).single();
    expect(data?.archived_at).toBeNull();
  });

  it("does not let a signed-in user read or write audit_events", async () => {
    for (const client of [await signedIn(staffEmail), await signedIn(adminEmail), createClient(url!, anonKey!, noSession)]) {
      const { data } = await client.from("audit_events").select("id").limit(1);
      expect(data ?? []).toEqual([]);
      const { error } = await client.from("audit_events").insert({ actor: userIds[0], target: ownId, action: "archive" });
      expect(error).not.toBeNull();
    }
  });
});
