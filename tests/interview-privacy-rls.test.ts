// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and BS-84xx
// employees (a range no other test uses), never the seeded demo data, and removes everything it created in
// afterAll through the service role: interviews (employee FK is ON DELETE RESTRICT), then the employees'
// department_id, then the departments (children first), then the employees, then the users.
// Rule under test (Story 4.4, FR-3): interviews are never visible to any manager, including through direct
// queries: zero rows from both the database and the store. The two interview select policies name only the
// Administrator role or the row's own employee, so a manager of a department, or of its parent, gets nothing
// for the employees under them, and a manager's own interviews stay hidden from the manager above them while
// remaining readable by that manager's own account (own-row policy).
// Tree: Parent (managed by A) > Child (managed by B). E (no account) and B's own employee row sit in Child;
// A's own employee row sits in Parent. Interviews exist for E and for B.
// Fails with 42P01 / PGRST205 until the departments migration is applied to the shared project, and with
// 42703 / PGRST204 until the department_managers migration is.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInterviewsStore } from "@/server/interviews-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS IntPriv ${run}`;
// One per-run slot of three consecutive ids (BS-8400..BS-8498): manager A, manager B, employee E.
const base = randomInt(0, 33) * 3;
const idAt = (offset: number) => `BS-84${String(base + offset).padStart(2, "0")}`;
const aEmployeeId = idAt(0);
const bEmployeeId = idAt(1);
const eEmployeeId = idAt(2);
const employeeIds = [aEmployeeId, bEmployeeId, eEmployeeId];

const employeeRow = (employee_id: string, auth_user_id: string | null, department_id: string) => ({
  employee_id, name: `RLS IntPriv ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-intpriv-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "IP", avatar_color: "mint", summary: "Throwaway row created by tests/interview-privacy-rls.test.ts.",
  auth_user_id, department_id,
});

const interviewRow = (employee_id: string, stage: string) => ({
  id: randomUUID(), employee_id, company: `RLS IntPriv Co ${run}`, role: "Test role", stage, interview_date: "2026-10-01",
  outcome: "", feedback: "Private feedback",
});

describe.skipIf(!configured)("interview privacy for department managers (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-intpriv-admin-${run}@example.com`;
  const managerAEmail = `rls-intpriv-a-${run}@example.com`;
  const managerBEmail = `rls-intpriv-b-${run}@example.com`;
  let parentId = "";
  let childId = "";
  // Written by the service role.
  const eRows = [interviewRow(eEmployeeId, "E first"), interviewRow(eEmployeeId, "E second")];
  const bRows = [interviewRow(bEmployeeId, "B own")];
  const allRowIds = [...eRows, ...bRows].map(r => r.id);
  // Manager sessions carry the auth user id (Story 4.5); filled in once the users exist.
  const managerA = { role: "manager" as const, employeeId: aEmployeeId, userId: "" };
  const managerB = { role: "manager" as const, employeeId: bEmployeeId, userId: "" };

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

  /** Throws with the step, the code and the message when a service-role step fails. */
  function check(step: string, result: { error: { code?: string; message: string } | null }) {
    if (result.error) throw new Error(`Could not ${step} (${result.error.code}): ${result.error.message}`);
  }

  /**
   * Removes this run's rows in FK order. Every step runs even if an earlier one fails (e.g. departments
   * missing before the 4.1 migration), so employees are never left behind; the first failure is rethrown.
   */
  async function cleanup() {
    const failures: unknown[] = [];
    const step = async (name: string, action: () => PromiseLike<{ error: { code?: string; message: string } | null }>) => {
      try { check(name, await action()); } catch (error) { failures.push(error); }
    };
    await step("delete test interviews", () => service.from("external_interviews").delete().in("employee_id", employeeIds));
    await step("detach test employees", () => service.from("employees").update({ department_id: null }).in("employee_id", employeeIds));
    await step("detach test departments", () => service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`));
    await step("delete test departments", () => service.from("departments").delete().like("name", `${PREFIX}%`));
    await step("delete test employees", () => service.from("employees").delete().in("employee_id", employeeIds));
    if (failures.length > 0) throw failures[0];
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    // Leftovers from an aborted run (same slot): interviews first, then the employees.
    check("remove leftover interviews", await service.from("external_interviews").delete().in("employee_id", employeeIds));
    check("remove leftover employees", await service.from("employees").delete().in("employee_id", employeeIds));
    await createUser(adminEmail, { role: "admin" });
    // Managers are Staff accounts that manage a department (the session role is derived, Story 4.2).
    const aUserId = await createUser(managerAEmail, { role: "staff", employee_id: aEmployeeId });
    const bUserId = await createUser(managerBEmail, { role: "staff", employee_id: bEmployeeId });
    managerA.userId = aUserId;
    managerB.userId = bUserId;
    const parent = await service.from("departments").insert({ name: `${PREFIX} Parent`, manager_user_id: aUserId }).select("id").single();
    check("insert test parent department", parent);
    parentId = parent.data!.id as string;
    const child = await service.from("departments")
      .insert({ name: `${PREFIX} Child`, parent_department_id: parentId, manager_user_id: bUserId }).select("id").single();
    check("insert test child department", child);
    childId = child.data!.id as string;
    check("insert test employees", await service.from("employees").insert([
      employeeRow(aEmployeeId, aUserId, parentId),
      employeeRow(bEmployeeId, bUserId, childId),
      employeeRow(eEmployeeId, null, childId),
    ], { defaultToNull: false }));
    check("insert test interviews", await service.from("external_interviews").insert([...eRows, ...bRows], { defaultToNull: false }));
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("sets up real department managers over a parent/child tree", async () => {
    const a = await signedIn(managerAEmail);
    const b = await signedIn(managerBEmail);
    // Each manager reads the department it manages (departments_select_managed, Story 4.2); with Story 4.3's
    // departments_select_managed_subtree, A (parent) also reads the child, B only the child.
    const aDepartments = (await a.from("departments").select("id").like("name", `${PREFIX}%`)).data ?? [];
    expect(aDepartments.map(d => d.id).sort()).toEqual([parentId, childId].sort());
    expect((await b.from("departments").select("id").like("name", `${PREFIX}%`)).data).toEqual([{ id: childId }]);
    const { data } = await service.from("employees").select("employee_id,department_id").in("employee_id", employeeIds);
    expect(data).toEqual(expect.arrayContaining([
      { employee_id: aEmployeeId, department_id: parentId },
      { employee_id: bEmployeeId, department_id: childId },
      { employee_id: eEmployeeId, department_id: childId },
    ]));
  });

  it("returns no interviews of a sub-department employee to the parent department's manager", async () => {
    const a = await signedIn(managerAEmail);
    const { data, error } = await a.from("external_interviews").select("id").eq("employee_id", eEmployeeId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("returns no interviews of an employee in the manager's own department", async () => {
    const b = await signedIn(managerBEmail);
    const { data, error } = await b.from("external_interviews").select("id").eq("employee_id", eEmployeeId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hides a manager's own interviews from the manager above them", async () => {
    const a = await signedIn(managerAEmail);
    const { data, error } = await a.from("external_interviews").select("id").eq("employee_id", bEmployeeId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const any = await a.from("external_interviews").select("id").in("employee_id", employeeIds);
    expect(any.error).toBeNull();
    expect(any.data).toEqual([]);
  });

  it("lets a manager's own account read only its own interviews (own-row policy)", async () => {
    const b = await signedIn(managerBEmail);
    const { data, error } = await b.from("external_interviews").select("id,employee_id");
    expect(error).toBeNull();
    expect(new Set((data ?? []).map(r => r.employee_id))).toEqual(new Set([bEmployeeId]));
    expect((data ?? []).map(r => r.id).sort()).toEqual(bRows.map(r => r.id).sort());
  });

  // The manager-role calls prove the store's own guard (it returns [] before any query); the admin-shaped calls
  // over a manager's JWT are the ones that reach the database and prove RLS through the store.
  it("returns [] from the store for a manager session (store guard) and for admin-shaped reads over a manager JWT (RLS)", async () => {
    for (const [email, session] of [[managerAEmail, managerA], [managerBEmail, managerB]] as const) {
      const client = await signedIn(email);
      const store = createInterviewsStore({ userClient: async () => client });
      expect(await store.listFor(session)).toEqual([]);
      for (const id of employeeIds) expect(await store.listFor(session, id)).toEqual([]);
      // Even an admin-shaped query over a manager's JWT: RLS still returns none of the team's interviews.
      expect(await store.listFor({ role: "admin" }, eEmployeeId)).toEqual([]);
    }
    const a = await signedIn(managerAEmail);
    expect(await createInterviewsStore({ userClient: async () => a }).listFor({ role: "admin" })).toEqual([]);
  });

  it("returns every test interview to an Administrator (control)", async () => {
    const admin = await signedIn(adminEmail);
    const { data, error } = await admin.from("external_interviews").select("id").in("employee_id", employeeIds);
    expect(error).toBeNull();
    expect((data ?? []).map(r => r.id).sort()).toEqual([...allRowIds].sort());
    const listed = await createInterviewsStore({ userClient: async () => admin }).listFor({ role: "admin" }, eEmployeeId);
    expect(listed.map(i => i.id).sort()).toEqual(eRows.map(r => r.id).sort());
  });
});
