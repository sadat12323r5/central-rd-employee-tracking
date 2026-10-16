// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, never the seeded demo data.
// Rules under test (Story 4.7): only the owner (the employee linked to auth.uid()) adds, edits and
// withdraws their backfilled projects; an insert is always active with the database's timestamps; a
// withdrawn entry never changes again (23514), and id / employee_id / created_at are locked (23514); an
// unknown department is refused by the foreign key (23503); a completion date after today (Asia/Dhaka) and a
// withdrawal that also rewrites a value are refused (23514); nothing can be deleted, not even with the
// service role. The Administrator and a manager over the owner read the entries but never write them
// (42501 on insert, 0 rows on update); another Staff member reads nothing and writes nothing.
// public.department_options() gives a signed-in Staff member every department's id and name only.
//
// Backfilled projects can never be deleted, so this test cannot remove what it creates. It reuses a fixed
// slot of throwaway employees (BS-9160..BS-9183, a range no other test uses) and fixed-name departments
// ("RLS Backfill slot N …"); assertions only look at this run's rows, so earlier runs' rows in the same
// slot never matter. afterAll unlinks and archives the employees, clears the manager and deletes the
// auth users. Fails with PGRST205 / PGRST202 / 42P01 until the 4.1–4.7 migrations are applied.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BackfillForbiddenError, BackfillNoEmployeeError, BackfillWithdrawnError, createBackfilledProjectStore,
} from "@/server/backfilled-project-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One of four fixed slots of six consecutive ids (BS-9160..BS-9183).
const slot = randomInt(0, 4);
const idAt = (offset: number) => `BS-91${String(60 + slot * 6 + offset).padStart(2, "0")}`;
const ownerId = idAt(0);      // the owning Staff member, in the managed department
const otherStaffId = idAt(1); // another Staff member, in an unrelated department
const managerId = idAt(2);    // manages the owner's department (no department of their own)
const employeeIds = [ownerId, otherStaffId, managerId];
const MANAGED_NAME = `RLS Backfill slot ${slot} Managed`;
const OTHER_NAME = `RLS Backfill slot ${slot} Other`;
const UNKNOWN_DEPARTMENT = "00000000-0000-4000-8000-0000000000ff";

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Backfill ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-backfill-${employee_id.toLowerCase()}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RB", avatar_color: "mint", summary: "Throwaway row reused by tests/backfill-rls.test.ts.",
  auth_user_id, department_id, archived_at: null,
});

describe.skipIf(!configured)("backfilled projects RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-backfill-admin-${run}@example.com`;
  const ownerEmail = `rls-backfill-owner-${run}@example.com`;
  const otherStaffEmail = `rls-backfill-other-${run}@example.com`;
  const managerEmail = `rls-backfill-mgr-${run}@example.com`;
  let ownerUserId = "";
  let managerUserId = "";
  let managedId = "";
  let otherId = "";
  /** This run's entries: one the owner edits, one the owner withdraws, one the other Staff member owns. */
  let entryId = "";
  let withdrawnId = "";
  let othersEntryId = "";

  const entry = (employee_id: string, department_id: string, extra: Record<string, unknown> = {}) => ({
    employee_id, department_id, client: `RLS client ${run}`, project_name: `RLS backfill ${run}`, completion_date: "2025-06-30",
    outcome: "Delivered.", ...extra,
  });

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

  async function ensureDepartment(name: string, manager_user_id: string | null): Promise<string> {
    const found = await service.from("departments").select("id").eq("name", name).maybeSingle();
    if (found.error) throw new Error(`Could not read test department (${found.error.code}): ${found.error.message}`);
    if (found.data) {
      const updated = await service.from("departments").update({ parent_department_id: null, manager_user_id }).eq("id", found.data.id);
      if (updated.error) throw new Error(`Could not update test department (${updated.error.code}): ${updated.error.message}`);
      return found.data.id as string;
    }
    const { data, error } = await service.from("departments").insert({ name, parent_department_id: null, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await createUser(adminEmail, { role: "admin" });
    ownerUserId = await createUser(ownerEmail, { role: "staff", employee_id: ownerId });
    const otherStaffUserId = await createUser(otherStaffEmail, { role: "staff", employee_id: otherStaffId });
    managerUserId = await createUser(managerEmail, { role: "staff", employee_id: managerId });
    managedId = await ensureDepartment(MANAGED_NAME, managerUserId);
    otherId = await ensureDepartment(OTHER_NAME, null);
    const employees = await service.from("employees").upsert([
      employeeRow(ownerId, ownerUserId, managedId),
      employeeRow(otherStaffId, otherStaffUserId, otherId),
      employeeRow(managerId, managerUserId, null),
    ], { onConflict: "employee_id", defaultToNull: false });
    if (employees.error) throw new Error(`Could not upsert test employees (${employees.error.code}): ${employees.error.message}`);
    // The other Staff member's entry, written by the service role.
    const other = await service.from("backfilled_projects").insert([entry(otherStaffId, otherId)], { defaultToNull: false }).select("id").single();
    if (other.error) throw new Error(`Could not insert test entry (${other.error.code}): ${other.error.message}`);
    othersEntryId = other.data.id as string;
  }, 90_000);

  afterAll(async () => {
    if (!service) return;
    try {
      // The rows stay (backfilled projects reference them); unlink and archive them so they are inert.
      await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).in("employee_id", employeeIds);
      await service.from("departments").update({ manager_user_id: null }).in("name", [MANAGED_NAME, OTHER_NAME]);
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the owner add entries: always active, with the database's timestamps", async () => {
    const owner = await signedIn(ownerEmail);
    const { data, error } = await owner.from("backfilled_projects")
      .insert(entry(ownerId, managedId, { status: "withdrawn", withdrawn_at: "2026-01-01T00:00:00Z", created_at: "2000-01-01T00:00:00Z" }))
      .select("id,employee_id,status,withdrawn_at,created_at,updated_at").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ employee_id: ownerId, status: "active", withdrawn_at: null });
    expect(data?.created_at).toBe(data?.updated_at);
    expect(Date.parse(data!.created_at as string)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    entryId = data!.id as string;
    const second = await owner.from("backfilled_projects").insert(entry(ownerId, otherId)).select("id").single();
    expect(second.error).toBeNull();
    withdrawnId = second.data!.id as string;
  });

  it("refuses a completion date after today in Dhaka (23514), on insert and on an edit that sets one", async () => {
    const owner = await signedIn(ownerEmail);
    const insert = await owner.from("backfilled_projects").insert(entry(ownerId, managedId, { completion_date: "2099-01-01" })).select("id");
    expect(insert.error?.code).toBe("23514");
    const update = await owner.from("backfilled_projects").update({ completion_date: "2099-01-01" }).eq("id", entryId).select("id");
    expect(update.error?.code).toBe("23514");
  });

  it("refuses an unknown department (23503)", async () => {
    const owner = await signedIn(ownerEmail);
    const { error } = await owner.from("backfilled_projects").insert(entry(ownerId, UNKNOWN_DEPARTMENT)).select("id");
    expect(error?.code).toBe("23503");
  });

  it("lets the owner edit: the values change and updated_at moves on", async () => {
    const before = await service.from("backfilled_projects").select("updated_at").eq("id", entryId).single();
    const owner = await signedIn(ownerEmail);
    const { data, error } = await owner.from("backfilled_projects").update({ outcome: "Edited by the owner.", department_id: otherId })
      .eq("id", entryId).select("outcome,department_id,updated_at").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ outcome: "Edited by the owner.", department_id: otherId });
    expect(Date.parse(data!.updated_at as string)).toBeGreaterThan(Date.parse(before.data!.updated_at as string));
  });

  it("locks id, employee_id and created_at (23514)", async () => {
    const owner = await signedIn(ownerEmail);
    for (const change of [{ employee_id: otherStaffId }, { created_at: "2026-01-01T00:00:00Z" }, { id: "00000000-0000-4000-8000-000000000abc" }]) {
      const { error } = await owner.from("backfilled_projects").update(change).eq("id", entryId).select("id");
      expect(error?.code, JSON.stringify(change)).toBe("23514");
    }
  });

  it("lets the owner withdraw: it stays, marked, and can never change again (23514)", async () => {
    const owner = await signedIn(ownerEmail);
    // A withdrawal changes only the status: rewriting a value in the same request is refused.
    for (const change of [{ outcome: "Rewritten while withdrawing." }, { department_id: managedId }, { client: "Other client" }]) {
      const rewrite = await owner.from("backfilled_projects").update({ status: "withdrawn", ...change }).eq("id", withdrawnId).select("id");
      expect(rewrite.error?.code, JSON.stringify(change)).toBe("23514");
    }
    const { data, error } = await owner.from("backfilled_projects").update({ status: "withdrawn" }).eq("id", withdrawnId)
      .select("status,withdrawn_at").single();
    expect(error).toBeNull();
    expect(data?.status).toBe("withdrawn");
    expect(data?.withdrawn_at).not.toBeNull();
    for (const change of [{ outcome: "Changed after withdrawal." }, { status: "active", withdrawn_at: null }]) {
      const again = await owner.from("backfilled_projects").update(change).eq("id", withdrawnId).select("id");
      expect(again.error?.code, JSON.stringify(change)).toBe("23514");
    }
    const kept = await service.from("backfilled_projects").select("status,outcome").eq("id", withdrawnId).single();
    expect(kept.data).toEqual({ status: "withdrawn", outcome: "Delivered." });
  });

  it("scopes reads: the admin and the manager see the owner's entries; other Staff see only their own", async () => {
    const mine = [entryId, withdrawnId, othersEntryId];
    const expectations: [string, string[]][] = [
      [adminEmail, mine],
      [managerEmail, [entryId, withdrawnId]],
      [ownerEmail, [entryId, withdrawnId]],
      [otherStaffEmail, [othersEntryId]],
    ];
    for (const [email, expected] of expectations) {
      const client = await signedIn(email);
      const { data, error } = await client.from("backfilled_projects").select("id").in("id", mine);
      expect(error, email).toBeNull();
      expect((data ?? []).map(r => r.id).sort(), email).toEqual([...expected].sort());
    }
  });

  it("refuses writes by another Staff member, the Administrator and the manager (42501 on insert, 0 rows on update)", async () => {
    for (const email of [otherStaffEmail, adminEmail, managerEmail]) {
      const client = await signedIn(email);
      const insert = await client.from("backfilled_projects").insert(entry(ownerId, managedId)).select("id");
      expect(insert.error?.code, email).toBe("42501");
      const update = await client.from("backfilled_projects").update({ outcome: `Changed by ${email}` }).eq("id", entryId).select("id");
      expect(update.error, email).toBeNull();
      expect(update.data ?? [], email).toEqual([]);
      const withdraw = await client.from("backfilled_projects").update({ status: "withdrawn" }).eq("id", entryId).select("id");
      expect(withdraw.data ?? [], email).toEqual([]);
    }
    const { data } = await service.from("backfilled_projects").select("outcome,status").eq("id", entryId).single();
    expect(data).toEqual({ outcome: "Edited by the owner.", status: "active" });
  });

  it("never deletes an entry: no policy for users, and the trigger refuses the service role", async () => {
    const owner = await signedIn(ownerEmail);
    const asOwner = await owner.from("backfilled_projects").delete().eq("id", entryId).select("id");
    expect(asOwner.data ?? []).toEqual([]);
    const admin = await signedIn(adminEmail);
    const asAdmin = await admin.from("backfilled_projects").delete().eq("id", entryId).select("id");
    expect(asAdmin.data ?? []).toEqual([]);
    const asService = await service.from("backfilled_projects").delete().eq("id", entryId);
    expect(asService.error).not.toBeNull();
    const { data } = await service.from("backfilled_projects").select("id").eq("id", entryId);
    expect(data).toHaveLength(1);
  });

  it("gives a Staff member every department's id and name only through department_options()", async () => {
    const other = await signedIn(otherStaffEmail);
    const { data, error } = await other.rpc("department_options");
    expect(error).toBeNull();
    const rows = data as Record<string, unknown>[];
    expect(rows.map(r => r.id)).toEqual(expect.arrayContaining([managedId, otherId]));
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "name"]);
    expect(rows.find(r => r.id === managedId)?.name).toBe(MANAGED_NAME);
    // The departments table itself stays closed to Staff.
    const direct = await other.from("departments").select("id,manager_user_id").eq("id", managedId);
    expect(direct.data ?? []).toEqual([]);
    // Without a sign-in the function is not callable.
    const anon = createClient(url!, anonKey!, noSession);
    expect((await anon.rpc("department_options")).error).not.toBeNull();
  });

  it("has the store agree with RLS for the owner, the manager and the Administrator", async () => {
    const owner = await signedIn(ownerEmail);
    const ownerClient = async () => owner;
    const ownerSession = { role: "staff", employeeId: ownerId } as const;
    const store = createBackfilledProjectStore({ userClient: ownerClient });
    const options = await store.departmentOptions();
    expect(options.map(o => o.id)).toEqual(expect.arrayContaining([managedId, otherId]));
    const added = await store.add(ownerSession, {
      departmentId: managedId, client: ` Store client ${run} `, projectName: "Store project", completionDate: "2025-01-15", outcome: " Store outcome. ",
    });
    expect(added).toMatchObject({ employeeId: ownerId, departmentName: MANAGED_NAME, client: `Store client ${run}`, outcome: "Store outcome.", status: "active", provenance: "backfilled" });
    const edited = await store.edit(ownerSession, added.id, {
      departmentId: otherId, client: `Store client ${run}`, projectName: "Store project", completionDate: "2025-01-15", outcome: "Store edit.",
    });
    expect(edited).toMatchObject({ departmentId: otherId, outcome: "Store edit." });
    expect((await store.listFor(ownerSession)).map(p => p.id)).toEqual(expect.arrayContaining([added.id, entryId, withdrawnId]));

    const manager = await signedIn(managerEmail);
    const managerClient = async () => manager;
    const managerSession = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    const managerStore = createBackfilledProjectStore({ userClient: managerClient, scope: createManagerScope({ userClient: managerClient }) });
    const managed = await managerStore.listFor(managerSession, ownerId);
    expect(managed.map(p => p.id)).toEqual(expect.arrayContaining([added.id, entryId]));
    // entryId now names OTHER_NAME, a department outside the manager's subtree: its name is still shown.
    expect(managed.find(p => p.id === entryId)?.departmentName).toBe(OTHER_NAME);
    await expect(managerStore.withdraw(managerSession, added.id)).rejects.toBeInstanceOf(BackfillForbiddenError);
    const admin = await signedIn(adminEmail);
    const adminStore = createBackfilledProjectStore({ userClient: async () => admin });
    await expect(adminStore.withdraw({ role: "admin" }, added.id)).rejects.toBeInstanceOf(BackfillNoEmployeeError);

    const withdrawn = await store.withdraw(ownerSession, added.id);
    expect(withdrawn).toMatchObject({ status: "withdrawn" });
    await expect(store.withdraw(ownerSession, added.id)).rejects.toBeInstanceOf(BackfillWithdrawnError);
  });
});
