// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and
// employees (a per-run slot of BS-91xx, a range no other test uses), never the seeded demo data, and
// removes everything it created in afterAll through the service role (archived rows are restored first;
// audit_events rows are append-only and stay).
// Rules under test (Story 4.9): public.manager_set_employee_archived, called with each user's own JWT,
// lets a department manager archive and restore employees in their subtree, writing one audit row with
// the manager's auth user id; it rejects employees outside the subtree and plain Staff (not_authorized),
// the manager's own record (cannot_archive_self), and targets with equal or higher authority or
// Administrators (insufficient_authority); anon cannot execute it.
// Fails with PGRST202 / 42883 until the manager_archive migration (and the 4.1-4.3 ones) are applied.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveNotAuthorizedError, ArchiveRankError, createManagerAccessStore } from "@/server/accounts-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Archive ${run}`;
// One per-run slot of eight consecutive ids (BS-9100..BS-9195).
const base = randomInt(0, 12) * 8;
const idAt = (offset: number) => `BS-91${String(base + offset).padStart(2, "0")}`;
const mPId = idAt(0);       // manager of P, employee in P
const mCId = idAt(1);       // manager of C, employee in C
const mGId = idAt(2);       // manager of G (grandchild under C), employee in C
const cMemberId = idAt(3);  // plain Staff in C
const pMemberId = idAt(4);  // plain Staff in P
const adminEmpId = idAt(5); // an Administrator account linked to an employee row in C
const wId = idAt(6);        // manager of the unrelated department Z, employee in X
const yId = idAt(7);        // manager of X (W's own department), employee in Z
const employeeIds = [mPId, mCId, mGId, cMemberId, pMemberId, adminEmpId, wId, yId];

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string | null) => ({
  employee_id, name: `RLS Archive ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-archive-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RA", avatar_color: "mint", summary: "Throwaway row created by tests/manager-archive-rls.test.ts.",
  auth_user_id, department_id,
});

const RPC = "manager_set_employee_archived";

describe.skipIf(!configured)("manager archive and restore (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const email = (who: string) => `rls-archive-${who}-${run}@example.com`;
  const users: Record<string, string> = {};
  let pDept = "";
  let cDept = "";
  let xDept = "";
  let zDept = "";

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

  async function insertDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  async function cleanup() {
    const restored = await service.from("employees").update({ archived_at: null }).in("employee_id", employeeIds);
    if (restored.error) throw new Error(`Could not restore test employees (${restored.error.code}): ${restored.error.message}`);
    const deletedEmployees = await service.from("employees").delete().in("employee_id", employeeIds);
    if (deletedEmployees.error) throw new Error(`Could not delete test employees (${deletedEmployees.error.code}): ${deletedEmployees.error.message}`);
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (deleted.error) throw new Error(`Could not delete test departments (${deleted.error.code}): ${deleted.error.message}`);
  }

  async function archivedAt(employeeId: string) {
    const { data, error } = await service.from("employees").select("archived_at").eq("employee_id", employeeId).single();
    if (error) throw new Error(`Could not read test employee (${error.code}): ${error.message}`);
    return data.archived_at as string | null;
  }

  async function auditFor(employeeId: string) {
    // Only this run's actors: audit rows are append-only, so earlier runs in the same slot leave theirs.
    const { data, error } = await service.from("audit_events").select("actor,target,action")
      .eq("target", employeeId).in("actor", userIds).order("id");
    if (error) throw new Error(`Could not read audit rows (${error.code}): ${error.message}`);
    return data;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run in the same slot
    await createUser("mp", { role: "staff", employee_id: mPId });
    await createUser("mc", { role: "staff", employee_id: mCId });
    await createUser("mg", { role: "staff", employee_id: mGId });
    await createUser("cmember", { role: "staff", employee_id: cMemberId });
    await createUser("pmember", { role: "staff", employee_id: pMemberId });
    await createUser("admin", { role: "admin" });
    await createUser("w", { role: "staff", employee_id: wId });
    await createUser("y", { role: "staff", employee_id: yId });
    pDept = await insertDepartment(`${PREFIX} P`, null, users.mp);
    cDept = await insertDepartment(`${PREFIX} C`, pDept, users.mc);
    await insertDepartment(`${PREFIX} G`, cDept, users.mg);
    xDept = await insertDepartment(`${PREFIX} X`, null, users.y);
    zDept = await insertDepartment(`${PREFIX} Z`, null, users.w);
    const inserted = await service.from("employees").insert([
      employeeRow(mPId, users.mp, pDept),
      employeeRow(mCId, users.mc, cDept),
      employeeRow(mGId, users.mg, cDept),
      employeeRow(cMemberId, users.cmember, cDept),
      employeeRow(pMemberId, users.pmember, pDept),
      employeeRow(adminEmpId, users.admin, cDept),
      employeeRow(wId, users.w, xDept),
      employeeRow(yId, users.y, xDept),
    ], { defaultToNull: false });
    if (inserted.error) throw new Error(`Could not insert test employees (${inserted.error.code}): ${inserted.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets C's manager archive and restore a C member, one audit row each with the manager's user id", async () => {
    const mC = await signedIn("mc");
    try {
      const archived = await mC.rpc(RPC, { p_employee_id: cMemberId, p_archived: true });
      expect(archived.error).toBeNull();
      expect(archived.data).toBe(`RLS Archive ${cMemberId}`);
      expect(await archivedAt(cMemberId)).not.toBeNull();
      const again = await mC.rpc(RPC, { p_employee_id: cMemberId, p_archived: true });
      expect(again.error).toMatchObject({ message: "already_archived", details: `RLS Archive ${cMemberId}` });
      const restored = await mC.rpc(RPC, { p_employee_id: cMemberId, p_archived: false });
      expect(restored.error).toBeNull();
      expect(await archivedAt(cMemberId)).toBeNull();
      const notArchived = await mC.rpc(RPC, { p_employee_id: cMemberId, p_archived: false });
      expect(notArchived.error).toMatchObject({ message: "not_archived", details: `RLS Archive ${cMemberId}` });
      expect(await auditFor(cMemberId)).toEqual([
        { actor: users.mc, target: cMemberId, action: "archive" },
        { actor: users.mc, target: cMemberId, action: "restore" },
      ]);
    } finally {
      await service.from("employees").update({ archived_at: null }).eq("employee_id", cMemberId);
    }
  });

  it("rejects C's manager on a P member (outside the subtree) with not_authorized, changing nothing", async () => {
    const mC = await signedIn("mc");
    for (const archived of [true, false]) {
      const { error } = await mC.rpc(RPC, { p_employee_id: pMemberId, p_archived: archived });
      expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
    }
    expect(await archivedAt(pMemberId)).toBeNull();
    expect(await auditFor(pMemberId)).toEqual([]);
  });

  it("rejects C's manager archiving their own record with cannot_archive_self", async () => {
    const mC = await signedIn("mc");
    const { error } = await mC.rpc(RPC, { p_employee_id: mCId, p_archived: true });
    expect(error).toMatchObject({ code: "P0001", message: "cannot_archive_self" });
    expect(await archivedAt(mCId)).toBeNull();
  });

  it("rejects C's manager on P's manager moved into C (higher authority) with insufficient_authority", async () => {
    const mC = await signedIn("mc");
    const moved = await service.from("employees").update({ department_id: cDept }).eq("employee_id", mPId);
    expect(moved.error).toBeNull();
    try {
      for (const archived of [true, false]) {
        const { error } = await mC.rpc(RPC, { p_employee_id: mPId, p_archived: archived });
        expect(error).toMatchObject({ code: "P0001", message: "insufficient_authority" });
      }
      expect(await archivedAt(mPId)).toBeNull();
      // The store maps it to ArchiveRankError (its scope pre-check passes: mP's row is now in C).
      const store = createManagerAccessStore({ userClient: async () => mC, scope: createManagerScope({ userClient: async () => mC }) });
      await expect(store.archive({ role: "manager", employeeId: mCId, userId: users.mc }, mPId)).rejects.toBeInstanceOf(ArchiveRankError);
    } finally {
      await service.from("employees").update({ department_id: pDept, archived_at: null }).eq("employee_id", mPId);
    }
    expect(await auditFor(mPId)).toEqual([]);
  });

  it("rejects C's manager on an Administrator's linked record with insufficient_authority", async () => {
    const mC = await signedIn("mc");
    const { error } = await mC.rpc(RPC, { p_employee_id: adminEmpId, p_archived: true });
    expect(error).toMatchObject({ code: "P0001", message: "insufficient_authority" });
    expect(await archivedAt(adminEmpId)).toBeNull();
  });

  it("rejects a manager on the manager of their own employee department (outside what they manage) with insufficient_authority", async () => {
    const w = await signedIn("w");
    // Y manages X, where W's own employee row sits; W manages the unrelated department Z. Y's row moves into Z.
    const moved = await service.from("employees").update({ department_id: zDept }).eq("employee_id", yId);
    expect(moved.error).toBeNull();
    try {
      for (const archived of [true, false]) {
        const { error } = await w.rpc(RPC, { p_employee_id: yId, p_archived: archived });
        expect(error).toMatchObject({ code: "P0001", message: "insufficient_authority" });
      }
      expect(await archivedAt(yId)).toBeNull();
    } finally {
      await service.from("employees").update({ department_id: xDept, archived_at: null }).eq("employee_id", yId);
    }
    expect(await auditFor(yId)).toEqual([]);
  });

  it("rejects an archived manager whose JWT is still valid with not_authorized", async () => {
    const mC = await signedIn("mc");
    const auditBefore = await auditFor(cMemberId);
    const archived = await service.from("employees").update({ archived_at: new Date().toISOString() }).eq("employee_id", mCId);
    expect(archived.error).toBeNull();
    try {
      const { error } = await mC.rpc(RPC, { p_employee_id: cMemberId, p_archived: true });
      expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
      expect(await archivedAt(cMemberId)).toBeNull();
    } finally {
      await service.from("employees").update({ archived_at: null }).eq("employee_id", mCId);
    }
    expect(await auditFor(cMemberId)).toEqual(auditBefore);
  });

  it("lets P's manager archive and restore G's manager (lower authority)", async () => {
    const mP = await signedIn("mp");
    try {
      const archived = await mP.rpc(RPC, { p_employee_id: mGId, p_archived: true });
      expect(archived.error).toBeNull();
      expect(await archivedAt(mGId)).not.toBeNull();
      const restored = await mP.rpc(RPC, { p_employee_id: mGId, p_archived: false });
      expect(restored.error).toBeNull();
      expect(await archivedAt(mGId)).toBeNull();
      expect(await auditFor(mGId)).toEqual([
        { actor: users.mp, target: mGId, action: "archive" },
        { actor: users.mp, target: mGId, action: "restore" },
      ]);
    } finally {
      await service.from("employees").update({ archived_at: null }).eq("employee_id", mGId);
    }
  });

  it("rejects a plain Staff caller with not_authorized, even inside a managed department", async () => {
    const staff = await signedIn("cmember");
    const { error } = await staff.rpc(RPC, { p_employee_id: mGId, p_archived: true });
    expect(error).toMatchObject({ code: "P0001", message: "not_authorized" });
    expect(await archivedAt(mGId)).toBeNull();
  });

  it("denies anon execute on the function", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { error } = await anon.rpc(RPC, { p_employee_id: cMemberId, p_archived: true });
    expect(error?.code).toBe("42501");
    expect(await archivedAt(cMemberId)).toBeNull();
  });

  it("has the manager store reject an out-of-scope employee before any rpc", async () => {
    const mC = await signedIn("mc");
    const store = createManagerAccessStore({ userClient: async () => mC, scope: createManagerScope({ userClient: async () => mC }) });
    await expect(store.archive({ role: "manager", employeeId: mCId, userId: users.mc }, pMemberId)).rejects.toBeInstanceOf(ArchiveNotAuthorizedError);
    expect(await archivedAt(pMemberId)).toBeNull();
  });
});
