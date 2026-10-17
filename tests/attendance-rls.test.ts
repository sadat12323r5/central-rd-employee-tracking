// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and BS-97xx employees (a range no other test uses,
// so it never races employees-rls.test.ts or e2e), never the seeded demo employees, and removes
// everything it created in afterAll (attendance rows first: the employee FK is ON DELETE RESTRICT).
// Staff may only create or change today's Dhaka entry, so staff writes use today's date and the
// past-dated rows needed for read and scope checks are inserted through the service role.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dhakaDate, TimesheetValidationError, type TimesheetEntry } from "@/domain/timesheet";
import { AttendanceUnavailableError, createAttendanceStore } from "@/server/attendance-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
// One per-run slot of two consecutive ids (BS-9700..BS-9799).
const base = randomInt(0, 50) * 2;
const ownId = `BS-97${String(base).padStart(2, "0")}`;
const otherId = `BS-97${String(base + 1).padStart(2, "0")}`;
const employeeIds = [ownId, otherId];
/** Today in Dhaka, the only day staff may write. (A run straddling Dhaka midnight can fail spuriously.) */
const today = dhakaDate(new Date());

const employee = (employee_id: string, email: string, auth_user_id: string | null = null) => ({
  employee_id, name: `Attendance RLS ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "AR",
  avatar_color: "mint", summary: "Throwaway row created by tests/attendance-rls.test.ts.", auth_user_id,
});

const attendance = (employee_id: string, work_date: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), employee_id, work_date, clock_in: work_date === today ? new Date(Date.now() - 60_000).toISOString() : `${work_date}T03:00:00Z`,
  clock_out: null, break_minutes: 0, work_mode: "Office", log: null,
  ...extra,
});

describe.skipIf(!configured)("attendance RLS and persistence (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-att-admin-${run}@example.com`;
  const staffEmail = `rls-att-staff-${run}@example.com`;
  // Past-dated rows, written by the service role (staff cannot write past days).
  const otherRow = attendance(otherId, "2026-02-02");
  const ownPastRow = attendance(ownId, "2026-02-03");

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
    const attendanceDeleted = await service.from("attendance_entries").delete().in("employee_id", employeeIds);
    if (attendanceDeleted.error) throw new Error(`Could not delete test attendance (${attendanceDeleted.error.code}): ${attendanceDeleted.error.message}`);
    const employeesDeleted = await service.from("employees").delete().in("employee_id", employeeIds);
    if (employeesDeleted.error) throw new Error(`Could not delete test employees (${employeesDeleted.error.code}): ${employeesDeleted.error.message}`);
  }

  /** Removes the staff member's entry for today, so each test that writes today starts clean. */
  async function clearOwnToday() {
    const { error } = await service.from("attendance_entries").delete().eq("employee_id", ownId).eq("work_date", today);
    if (error) throw new Error(`Could not clear today's test attendance: ${error.message}`);
  }

  const todayEntry = (extra: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
    id: randomUUID(), employeeId: ownId, date: today, clockIn: new Date(Date.now() - 60 * 60_000).toISOString(), clockOut: null,
    breakMinutes: 0, workMode: "Office", log: null, ...extra,
  });

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run
    await createUser(adminEmail, "admin");
    const staffUserId = await createUser(staffEmail, "staff", ownId);
    const { error } = await service.from("employees").insert([
      employee(ownId, `rls-att-own-${run}@example.com`, staffUserId),
      employee(otherId, `rls-att-other-${run}@example.com`),
    ]);
    if (error) throw new Error(`Could not insert test employees: ${error.message}`);
    const seeded = await service.from("attendance_entries").insert([otherRow, ownPastRow]);
    if (seeded.error) throw new Error(`Could not insert past-dated attendance (${seeded.error.code}): ${seeded.error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets staff insert, update and read their own entry for today", async () => {
    await clearOwnToday();
    const staff = await signedIn(staffEmail);
    const own = attendance(ownId, today);
    expect((await staff.from("attendance_entries").insert(own)).error).toBeNull();
    const updated = await staff.from("attendance_entries").update({ clock_out: new Date().toISOString(), break_minutes: 0 }).eq("id", own.id).select("id");
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id: own.id }]);
    const { data, error } = await staff.from("attendance_entries").select("id,work_date").in("id", [own.id, ownPastRow.id]).order("work_date");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: ownPastRow.id, work_date: ownPastRow.work_date }, { id: own.id, work_date: today }]);
  });

  it("refuses staff writes to a past day, even their own", async () => {
    const staff = await signedIn(staffEmail);
    const inserted = await staff.from("attendance_entries").insert(attendance(ownId, "2026-02-04"));
    expect(inserted.error).not.toBeNull();
    const updated = await staff.from("attendance_entries").update({ break_minutes: 99 }).eq("id", ownPastRow.id).select("id");
    expect(updated.data ?? []).toEqual([]);
    const store = createAttendanceStore({ userClient: async () => staff });
    const past: TimesheetEntry = {
      id: ownPastRow.id, employeeId: ownId, date: ownPastRow.work_date, clockIn: ownPastRow.clock_in, clockOut: null,
      breakMinutes: 99, workMode: "Office", log: null,
    };
    await expect(store.save(past)).rejects.toBeInstanceOf(AttendanceUnavailableError);
    const { data } = await service.from("attendance_entries").select("work_date,break_minutes").eq("employee_id", ownId).lt("work_date", today);
    expect(data).toEqual([{ work_date: ownPastRow.work_date, break_minutes: 0 }]);
  });

  it("rejects a clock-out earlier than the clock-in (23514)", async () => {
    await clearOwnToday();
    const staff = await signedIn(staffEmail);
    const backwards = attendance(ownId, today, { clock_in: new Date().toISOString(), clock_out: new Date(Date.now() - 60 * 60_000).toISOString() });
    const { error } = await staff.from("attendance_entries").insert(backwards);
    expect(error?.code).toBe("23514");
  });

  it("never returns another employee's entries to staff", async () => {
    const staff = await signedIn(staffEmail);
    const { data, error } = await staff.from("attendance_entries").select("employee_id");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(new Set(data!.map(r => r.employee_id))).toEqual(new Set([ownId]));
    expect((await createAttendanceStore({ userClient: async () => staff }).listForEmployee(otherId))).toEqual([]);
  });

  it("rejects staff writes for another employee", async () => {
    const staff = await signedIn(staffEmail);
    const inserted = await staff.from("attendance_entries").insert(attendance(otherId, today));
    expect(inserted.error).not.toBeNull();
    // An update outside the policy matches no rows.
    const updated = await staff.from("attendance_entries").update({ break_minutes: 99 }).eq("id", otherRow.id).select("id");
    expect(updated.data ?? []).toEqual([]);
    // Saving through the store (upsert) is refused and surfaces as unavailable, never as saved.
    const store = createAttendanceStore({ userClient: async () => staff });
    const foreign: TimesheetEntry = {
      id: otherRow.id, employeeId: otherId, date: otherRow.work_date, clockIn: otherRow.clock_in, clockOut: null,
      breakMinutes: 42, workMode: "Office", log: null,
    };
    await expect(store.save(foreign)).rejects.toBeInstanceOf(AttendanceUnavailableError);
    await expect(store.save({ ...foreign, id: randomUUID(), date: today, clockIn: new Date().toISOString() })).rejects.toBeInstanceOf(AttendanceUnavailableError);
    const { data } = await service.from("attendance_entries").select("break_minutes,work_date").eq("employee_id", otherId);
    expect(data).toEqual([{ break_minutes: 0, work_date: otherRow.work_date }]);
  });

  it("lets an admin read every employee's entries", async () => {
    const admin = await signedIn(adminEmail);
    const all = await createAttendanceStore({ userClient: async () => admin }).listAll();
    const ids = new Set(all.map(e => e.employeeId));
    expect(ids.has(ownId)).toBe(true);
    expect(ids.has(otherId)).toBe(true);
  });

  it("windows attendance by date and session scope for the summaries (Story 5.4 listInPeriod)", async () => {
    const february = { from: "2026-02-01", to: "2026-02-28" };
    const staffSession = { role: "staff", employeeId: ownId } as const;
    const staffStore = createAttendanceStore({ userClient: async () => signedIn(staffEmail) });
    expect((await staffStore.listInPeriod(staffSession, february)).map(e => e.id)).toEqual([ownPastRow.id]);
    expect(await staffStore.listInPeriod(staffSession, february, [otherId])).toEqual([]);
    const adminStore = createAttendanceStore({ userClient: async () => signedIn(adminEmail) });
    const adminRead = await adminStore.listInPeriod({ role: "admin" }, february, employeeIds);
    expect(adminRead.map(e => e.id)).toEqual([otherRow.id, ownPastRow.id]);
    expect(await adminStore.listInPeriod({ role: "admin" }, { from: "2026-02-03", to: "2026-02-03" }, employeeIds))
      .toEqual([expect.objectContaining({ id: ownPastRow.id })]);
    expect(await adminStore.listInPeriod({ role: "admin" }, { from: "2026-01-01", to: "2026-01-31" }, employeeIds)).toEqual([]);
  });

  it("returns nothing to an anonymous client", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const { data } = await anon.from("attendance_entries").select("id").in("employee_id", employeeIds);
    expect(data ?? []).toEqual([]);
  });

  it("does not let anyone signed in delete entries", async () => {
    for (const email of [staffEmail, adminEmail]) {
      const client = await signedIn(email);
      await client.from("attendance_entries").delete().in("employee_id", employeeIds);
    }
    const { data } = await service.from("attendance_entries").select("id").in("id", [otherRow.id, ownPastRow.id]).order("id");
    expect(data).toEqual([otherRow.id, ownPastRow.id].sort().map(id => ({ id })));
  });

  it("rejects a second entry for the same employee and day", async () => {
    await clearOwnToday();
    const staff = await signedIn(staffEmail);
    expect((await staff.from("attendance_entries").insert(attendance(ownId, today))).error).toBeNull();
    const { error } = await staff.from("attendance_entries").insert(attendance(ownId, today));
    expect(error?.code).toBe("23505");
    const store = createAttendanceStore({ userClient: async () => staff });
    const raced = await store.save(todayEntry({ workMode: "Remote" })).catch(e => e);
    expect(raced).toBeInstanceOf(TimesheetValidationError);
    expect(raced.code).toBe("ALREADY_RECORDED");
  });

  it("reads a saved entry and its log back through a fresh store and client (survives a restart)", async () => {
    await clearOwnToday();
    const entry = todayEntry({ workMode: "Client site" });
    const first = createAttendanceStore({ userClient: async () => signedIn(staffEmail) });
    await first.save(entry);
    const withLog: TimesheetEntry = {
      ...entry, clockOut: new Date().toISOString(), breakMinutes: 0,
      log: { summary: "Persistence check", blockers: "None", tasks: [{ description: "Store", hours: 0.5, link: "https://example.com/pr/15" }], updatedAt: new Date().toISOString() },
    };
    await first.save(withLog);

    const restarted = createAttendanceStore({ userClient: async () => signedIn(staffEmail) });
    const listed = await restarted.listForEmployee(ownId);
    expect(listed.find(e => e.id === entry.id)).toEqual(withLog);
    expect(listed.map(e => e.date)).toEqual([today, ownPastRow.work_date]);
  });
});
