// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and departments (names carrying this run's id) and three
// fixed test employees BS-8800..BS-8802 (a range no other test uses; the Story 7.3 e2e uses BS-8850),
// never the seeded demo data.
// Rules under test (Story 7.3): employment_history rows are readable and writable by the Administrator
// (anyone), the employee themselves (own record) and a department manager (employees in their subtree);
// nobody else, and never anon. The guard trigger owns created_by and the timestamps, stamps removed_at,
// locks id / employee_id / created_by / created_at, and refuses any change to a removed row (23514).
// Nothing is ever deleted: a BEFORE DELETE trigger refuses every delete, the service role's included.
// employment-history-store agrees.
//
// Cleanup: because history rows can never be deleted (and employees.employee_id is ON DELETE RESTRICT),
// the test employees cannot be deleted either. afterAll therefore removes (soft) every active history row
// of the test employees, archives them and unlinks them from their accounts and departments, then deletes
// the departments and the auth users through the service role. The next run re-uses the same three ids
// (upserted), so the leftovers stay bounded.
// Fails with 42P01 / PGRST205 until the departments and employment_history migrations are applied, 42703
// until department_managers is, and 42883 until manager_scope is.
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEmploymentHistoryStore, EmploymentHistoryForbiddenError, EmploymentHistoryNotFoundError, EmploymentHistoryRemovedError,
} from "@/server/employment-history-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS History ${run}`;
const managerId = "BS-8800";       // the P manager's own record (no department)
const childEmployee = "BS-8801";   // in C (inside the P manager's subtree), linked to the "own" Staff account
const unrelatedEmployee = "BS-8802"; // in U (outside it), linked to the "other" Staff account
const employeeIds = [managerId, childEmployee, unrelatedEmployee];
const startedAt = Date.now();

const employeeRow = (employee_id: string, department_id: string | null, auth_user_id: string | null) => ({
  employee_id, name: `RLS History ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-history-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-10-01", manager: "Test", office: "Test",
  status: "Available", initials: "RH", avatar_color: "mint", summary: "", department_id, auth_user_id, archived_at: null,
});

const entry = (employee_id: string, extra: Record<string, unknown> = {}) => ({
  employee_id, role: "Engineer", employer: `RLS History ${run}`, period: "2021 – 2022", detail: "", ...extra,
});

const COLUMNS = "id,employee_id,role,employer,period,detail,created_by,created_at,updated_at,removed_at";
type Row = { id: string; employee_id: string; role: string; employer: string; period: string; detail: string; created_by: string | null; created_at: string; updated_at: string; removed_at: string | null };

describe.skipIf(!configured)("employment history RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-history-admin-${run}@example.com`;
  const managerEmail = `rls-history-mgr-${run}@example.com`;
  const ownEmail = `rls-history-own-${run}@example.com`;
  const otherEmail = `rls-history-other-${run}@example.com`;
  let managerUserId = "";
  let ownUserId = "";

  async function createUser(address: string, app_metadata: Record<string, string>) {
    const { data, error } = await service.auth.admin.createUser({ email: address, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  // One sign-in per test user per file (Supabase Auth rate-limits sign-ins per IP).
  const sessions = new Map<string, Promise<SupabaseClient>>();
  function signedIn(address: string): Promise<SupabaseClient> {
    let session = sessions.get(address);
    if (!session) {
      session = (async () => {
        const client = createClient(url!, anonKey!, noSession);
        const { error } = await client.auth.signInWithPassword({ email: address, password });
        if (error) throw new Error(`Could not sign in test user: ${error.message}`);
        return client;
      })();
      sessions.set(address, session);
    }
    return session;
  }

  /** Soft cleanup (rows can never be deleted): remove active entries, archive and unlink the test employees, delete the departments. */
  async function retire() {
    const removed = await service.from("employment_history").update({ removed_at: new Date().toISOString() })
      .in("employee_id", employeeIds).is("removed_at", null);
    if (removed.error) throw new Error(`Could not remove test history (${removed.error.code}): ${removed.error.message}`);
    const archived = await service.from("employees")
      .update({ archived_at: new Date().toISOString(), auth_user_id: null, department_id: null }).in("employee_id", employeeIds);
    if (archived.error) throw new Error(`Could not archive test employees (${archived.error.code}): ${archived.error.message}`);
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (deleted.error) throw new Error(`Could not delete test departments (${deleted.error.code}): ${deleted.error.message}`);
  }

  async function insertDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  /** A row inserted through the service role (created_by null). */
  async function seed(employeeId: string, extra: Record<string, unknown> = {}): Promise<Row> {
    const { data, error } = await service.from("employment_history").insert(entry(employeeId, extra), { defaultToNull: false }).select(COLUMNS).single();
    if (error) throw new Error(`Could not insert test history (${error.code}): ${error.message}`);
    return data as Row;
  }

  async function read(id: string): Promise<Row> {
    const { data, error } = await service.from("employment_history").select(COLUMNS).eq("id", id).single();
    if (error) throw new Error(`Could not read test history (${error.code}): ${error.message}`);
    return data as Row;
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await retire(); // leftovers from an aborted run (the employees are re-used below)
    await createUser(adminEmail, { role: "admin" });
    managerUserId = await createUser(managerEmail, { role: "staff", employee_id: managerId });
    ownUserId = await createUser(ownEmail, { role: "staff", employee_id: childEmployee });
    const otherUserId = await createUser(otherEmail, { role: "staff", employee_id: unrelatedEmployee });
    const parentId = await insertDepartment(`${PREFIX} Parent`, null, managerUserId);
    const childId = await insertDepartment(`${PREFIX} Child`, parentId, null);
    const unrelatedId = await insertDepartment(`${PREFIX} Unrelated`, null, null);
    const employees = await service.from("employees").upsert([
      employeeRow(managerId, null, managerUserId),
      employeeRow(childEmployee, childId, ownUserId),
      employeeRow(unrelatedEmployee, unrelatedId, otherUserId),
    ], { onConflict: "employee_id", defaultToNull: false });
    if (employees.error) throw new Error(`Could not upsert test employees (${employees.error.code}): ${employees.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await retire();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the employee add, edit and remove their own entries; the database stamps author and times", async () => {
    const own = await signedIn(ownEmail);
    const added = await own.from("employment_history")
      .insert(entry(childEmployee, { created_by: managerUserId, created_at: "2000-01-01T00:00:00Z", removed_at: "2000-01-01T00:00:00Z" }))
      .select(COLUMNS).single();
    expect(added.error).toBeNull();
    const row = added.data as Row;
    expect(row.created_by).toBe(ownUserId);
    expect(row.removed_at).toBeNull();
    expect(Date.parse(row.created_at)).toBeGreaterThan(startedAt - 60_000);

    const edited = await own.from("employment_history").update({ role: "Senior Engineer" }).eq("id", row.id).select(COLUMNS).single();
    expect(edited.error).toBeNull();
    expect((edited.data as Row).role).toBe("Senior Engineer");

    const removed = await own.from("employment_history").update({ removed_at: "2000-01-01T00:00:00Z" }).eq("id", row.id).select(COLUMNS).single();
    expect(removed.error).toBeNull();
    // The removal time is the database's, never the client's.
    expect(Date.parse((removed.data as Row).removed_at!)).toBeGreaterThan(startedAt - 60_000);
    expect((await read(row.id)).removed_at).not.toBeNull();
  });

  it("hides the C employee's rows from another Staff member and refuses their writes", async () => {
    const target = await seed(childEmployee);
    const other = await signedIn(otherEmail);
    const { data, error } = await other.from("employment_history").select("id").eq("employee_id", childEmployee);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect((await other.from("employment_history").insert(entry(childEmployee))).error?.code).toBe("42501");
    const updated = await other.from("employment_history").update({ role: "Hijacked" }).eq("id", target.id).select("id");
    expect(updated.data ?? []).toHaveLength(0);
    expect((await read(target.id)).role).toBe("Engineer");
  });

  it("lets the P manager write the C employee's history but not the U employee's", async () => {
    const manager = await signedIn(managerEmail);
    const inC = await manager.from("employment_history").insert(entry(childEmployee)).select(COLUMNS).single();
    expect(inC.error).toBeNull();
    expect((inC.data as Row).created_by).toBe(managerUserId);
    const editedC = await manager.from("employment_history").update({ detail: "By the manager." }).eq("id", (inC.data as Row).id).select("id");
    expect(editedC.data).toHaveLength(1);

    expect((await manager.from("employment_history").insert(entry(unrelatedEmployee))).error?.code).toBe("42501");
    const inU = await seed(unrelatedEmployee);
    const hidden = await manager.from("employment_history").select("id").eq("id", inU.id);
    expect(hidden.data ?? []).toHaveLength(0);
    const editedU = await manager.from("employment_history").update({ role: "Changed" }).eq("id", inU.id).select("id");
    expect(editedU.data ?? []).toHaveLength(0);
    expect((await read(inU.id)).role).toBe("Engineer");
  });

  it("lets the Administrator write anyone's history", async () => {
    const admin = await signedIn(adminEmail);
    for (const employeeId of [childEmployee, unrelatedEmployee]) {
      const added = await admin.from("employment_history").insert(entry(employeeId)).select("id").single();
      expect(added.error).toBeNull();
      const edited = await admin.from("employment_history").update({ period: "Mar 2023 – Present" }).eq("id", added.data!.id).select("id");
      expect(edited.data).toHaveLength(1);
    }
  });

  it("refuses any change to a removed row, for everyone, the service role included", async () => {
    const row = await seed(childEmployee);
    const admin = await signedIn(adminEmail);
    expect((await admin.from("employment_history").update({ removed_at: new Date().toISOString() }).eq("id", row.id)).error).toBeNull();
    const removed = await read(row.id);
    expect((await admin.from("employment_history").update({ role: "Again" }).eq("id", row.id)).error?.code).toBe("23514");
    expect((await service.from("employment_history").update({ removed_at: null }).eq("id", row.id)).error?.code).toBe("23514");
    expect(await read(row.id)).toEqual(removed);
  });

  it("locks the employee, author and creation time (trigger 23514)", async () => {
    const row = await seed(childEmployee);
    const admin = await signedIn(adminEmail);
    for (const change of [{ employee_id: unrelatedEmployee }, { created_at: "2000-01-01T00:00:00Z" }, { created_by: managerUserId }]) {
      expect((await admin.from("employment_history").update(change).eq("id", row.id)).error?.code).toBe("23514");
    }
    expect(await read(row.id)).toEqual(row);
  });

  it("enforces the value checks: blank role, a period without a year, too long", async () => {
    const admin = await signedIn(adminEmail);
    for (const extra of [{ role: "   " }, { employer: "" }, { period: "Present" }, { period: `2020 ${"x".repeat(60)}` }, { detail: "x".repeat(2001) }]) {
      expect((await admin.from("employment_history").insert(entry(childEmployee, extra))).error?.code).toBe("23514");
    }
  });

  it("never deletes a row: the service role is refused and a user delete removes nothing", async () => {
    const row = await seed(childEmployee);
    expect((await service.from("employment_history").delete().eq("id", row.id)).error?.code).toBe("23514");
    for (const address of [adminEmail, ownEmail, managerEmail]) {
      const client = await signedIn(address);
      const { data } = await client.from("employment_history").delete().eq("id", row.id).select("id");
      expect(data ?? []).toHaveLength(0);
    }
    expect(await read(row.id)).toEqual(row);
  });

  it("denies anon", async () => {
    const row = await seed(childEmployee);
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("employment_history").select("id").eq("id", row.id);
    expect(data ?? []).toHaveLength(0);
    expect((await anon.from("employment_history").insert(entry(childEmployee))).error).not.toBeNull();
    const updated = await anon.from("employment_history").update({ role: "Anon" }).eq("id", row.id).select("id");
    expect(updated.data ?? []).toHaveLength(0);
  });

  it("agrees at the store: own Staff, the P manager and refusals", async () => {
    const own = { role: "staff", employeeId: childEmployee } as const;
    const other = { role: "staff", employeeId: unrelatedEmployee } as const;
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    const storeFor = async (address: string) => {
      const client = await signedIn(address);
      const userClient = async () => client;
      return createEmploymentHistoryStore({ userClient, scope: createManagerScope({ userClient }) });
    };
    const input = { role: "Store  Engineer", employer: "Store Co", period: "Mar 2023 – Present", detail: "" };

    const ownStore = await storeFor(ownEmail);
    const added = await ownStore.add(own, childEmployee, input);
    expect(added).toMatchObject({ employeeId: childEmployee, role: "Store Engineer", period: "Mar 2023 – Present" });
    expect((await ownStore.listFor(own)).map(e => e.id)).toContain(added.id);
    await expect(ownStore.add(own, unrelatedEmployee, input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);

    const otherStore = await storeFor(otherEmail);
    await expect(otherStore.update(other, added.id, input)).rejects.toBeInstanceOf(EmploymentHistoryNotFoundError);

    const managerStore = await storeFor(managerEmail);
    expect((await managerStore.update(manager, added.id, { ...input, detail: "Checked." })).detail).toBe("Checked.");
    await expect(managerStore.add(manager, unrelatedEmployee, input)).rejects.toBeInstanceOf(EmploymentHistoryForbiddenError);
    expect((await managerStore.listFor(manager)).every(e => e.employeeId === childEmployee)).toBe(true);

    await ownStore.remove(own, added.id);
    expect((await ownStore.listFor(own)).map(e => e.id)).not.toContain(added.id);
    await expect(ownStore.remove(own, added.id)).rejects.toBeInstanceOf(EmploymentHistoryRemovedError);
    expect((await read(added.id)).removed_at).not.toBeNull();
  });
});
