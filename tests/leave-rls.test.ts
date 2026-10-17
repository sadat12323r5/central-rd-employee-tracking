// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users and departments (names carrying this run's id) and three
// fixed test employees BS-8300..BS-8302 (the free block BS-8300..BS-8399; the Story 5.2 e2e uses BS-8390),
// never the seeded demo data.
// Rules under test (Story 5.2): leave_records rows are readable and insertable by the Administrator
// (anyone), the employee themselves (own record) and a department manager (employees in their subtree);
// nobody else, and never anon. There is no delete policy. The guard trigger owns created_by and
// created_at, refuses dates outside the calendar version's years (23514 leave_outside_calendar) and, under a
// per-employee advisory lock, a period intersecting another non-cancelled period of the same employee
// (23514 leave_overlap). Nothing is ever deleted: a BEFORE DELETE trigger refuses every delete, the service
// role's included. leave-store agrees (counting against holidayCalendarStore.active()).
// Story 5.3 (update policy, same predicate): the same people may edit or cancel a period. The 5.2 guard
// trigger's UPDATE branch decides what may change: an edit is recounted against the active calendar and
// checked for overlap ignoring the row itself; cancelling sets cancelled_at (stamped now()) and nothing
// else; a cancelled row is frozen; id, employee_id, created_by and created_at are locked.
// The 5.3 cases fail (no rows updated, or 42501) until the leave_records_update migration is applied.
//
// Calendar: the tests need an active calendar covering 2026. When none is active, the provisional
// docs/holiday-calendars/bangladesh-2026.csv is loaded through the service-role RPC (what db:seed does);
// an existing active calendar is never touched. A calendar this run loaded is deleted afterwards only when
// no leave row references it (leave_records.calendar_version_id is ON DELETE RESTRICT and leave rows are
// never deleted, so once this run has recorded leave against it, it stays: it is the provisional calendar
// the seed loads anyway).
//
// Cleanup: leave rows can never be deleted (and employees.employee_id is ON DELETE RESTRICT), so the test
// employees cannot be deleted either. afterAll therefore cancels (soft, through the service role) every
// active leave row of the test employees, so the next run's periods do not overlap them, archives the
// employees and unlinks them from their accounts and departments, then deletes the departments and the
// auth users. The next run re-uses the same three ids (upserted), so the leftovers stay bounded.
// Fails with 42P01 / PGRST205 / PGRST202 until the holiday_calendars and leave_records migrations are applied.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCalendar } from "@/domain/holiday-calendar";
import { categoryForWorkingDays, countWorkingDays, type CalendarPolicy } from "@/domain/leave";
import { createHolidayCalendarStore } from "@/server/holiday-calendar-store";
import { createLeaveStore, LeaveCancelledError, LeaveForbiddenError, LeaveNotFoundError, LeaveOverlapError } from "@/server/leave-store";
import { createManagerScope } from "@/server/manager-scope";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Leave ${run}`;
const managerId = "BS-8300";         // the P manager's own record (no department)
const childEmployee = "BS-8301";     // in C (inside the P manager's subtree), linked to the "own" Staff account
const unrelatedEmployee = "BS-8302"; // in U (outside it), linked to the "other" Staff account
const employeeIds = [managerId, childEmployee, unrelatedEmployee];
const startedAt = Date.now();
const PROVISIONAL = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");

const employeeRow = (employee_id: string, department_id: string | null, auth_user_id: string | null) => ({
  employee_id, name: `RLS Leave ${employee_id}`, title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-leave-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
  status: "Available", initials: "RL", avatar_color: "mint", summary: "", department_id, auth_user_id, archived_at: null,
});

const COLUMNS = "id,employee_id,start_date,end_date,working_days,category,calendar_version_id,cancelled_at,created_by,created_at";
type Row = {
  id: string; employee_id: string; start_date: string; end_date: string; working_days: number; category: string;
  calendar_version_id: string; cancelled_at: string | null; created_by: string | null; created_at: string;
};

describe.skipIf(!configured)("leave records RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-leave-admin-${run}@example.com`;
  const managerEmail = `rls-leave-mgr-${run}@example.com`;
  const ownEmail = `rls-leave-own-${run}@example.com`;
  const otherEmail = `rls-leave-other-${run}@example.com`;
  let managerUserId = "";
  let ownUserId = "";
  let calendarVersionId = "";
  let createdCalendarId: string | null = null;
  /** The active calendar's policy (read through the service role), so direct rows carry the database's own count. */
  let policy: CalendarPolicy = { holidays: new Set(), supportedYearStart: 2026, supportedYearEnd: 2026 };

  /** The working days and category of a period under the active calendar (1 / 1–3 when it cannot be counted, e.g. outside its years). */
  function counted(start: string, end: string) {
    try {
      const days = countWorkingDays(start, end, policy);
      return { working_days: days, category: categoryForWorkingDays(days).category };
    } catch {
      return { working_days: 1, category: "ONE_TO_THREE" };
    }
  }

  /** A direct row for `employee_id`, with the working days and category the guard trigger expects for the active calendar. */
  const period = (employee_id: string, start_date: string, end_date = start_date, extra: Record<string, unknown> = {}) => ({
    employee_id, start_date, end_date, ...counted(start_date, end_date), calendar_version_id: calendarVersionId, ...extra,
  });

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

  /** Soft cleanup (rows can never be deleted): cancel active leave, archive and unlink the test employees, delete the departments. */
  async function retire() {
    const cancelled = await service.from("leave_records").update({ cancelled_at: new Date().toISOString() })
      .in("employee_id", employeeIds).is("cancelled_at", null);
    if (cancelled.error) throw new Error(`Could not cancel test leave (${cancelled.error.code}): ${cancelled.error.message}`);
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

  /** The active calendar's id, loading the provisional 2026 calendar through the service role only when none is active. */
  async function ensureCalendar(): Promise<string> {
    const active = await service.from("holiday_calendar_versions").select("id,supported_year_start,supported_year_end")
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (active.error) throw new Error(`Could not read the active calendar (${active.error.code}): ${active.error.message}`);
    if (active.data) {
      if (active.data.supported_year_start > 2026 || active.data.supported_year_end < 2026) {
        throw new Error("The shared project's active holiday calendar does not cover 2026; these tests count 2026 leave.");
      }
      return active.data.id as string;
    }
    const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: PROVISIONAL }]);
    const loaded = await service.rpc("load_holiday_calendar", {
      p_jurisdiction: "Bangladesh", p_timezone: "Asia/Dhaka", p_year_start: calendar.supportedYearStart, p_year_end: calendar.supportedYearEnd,
      p_source: "bangladesh-2026.csv", p_holidays: calendar.holidays,
    }).single<{ id: string }>();
    if (loaded.error) throw new Error(`Could not load the provisional calendar (${loaded.error.code}): ${loaded.error.message}`);
    createdCalendarId = loaded.data.id;
    return loaded.data.id;
  }

  async function read(id: string): Promise<Row> {
    const { data, error } = await service.from("leave_records").select(COLUMNS).eq("id", id).single();
    if (error) throw new Error(`Could not read test leave (${error.code}): ${error.message}`);
    return data as Row;
  }

  /** A row inserted through the service role (created_by null). */
  async function seed(employeeId: string, start: string, end = start): Promise<Row> {
    const { data, error } = await service.from("leave_records").insert(period(employeeId, start, end), { defaultToNull: false }).select(COLUMNS).single();
    if (error) throw new Error(`Could not insert test leave (${error.code}): ${error.message}`);
    return data as Row;
  }

  const storeFor = async (address: string) => {
    const client = await signedIn(address);
    const userClient = async () => client;
    return createLeaveStore({ userClient, scope: createManagerScope({ userClient }), calendar: createHolidayCalendarStore({ userClient }) });
  };

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await retire(); // leftovers from an aborted run (the employees are re-used below)
    calendarVersionId = await ensureCalendar();
    const years = await service.from("holiday_calendar_versions").select("supported_year_start,supported_year_end").eq("id", calendarVersionId).single();
    if (years.error) throw new Error(`Could not read the active calendar's years (${years.error.code}): ${years.error.message}`);
    const dates = await service.from("holiday_calendar_dates").select("holiday_date").eq("version_id", calendarVersionId).range(0, 999);
    if (dates.error) throw new Error(`Could not read the active calendar's dates (${dates.error.code}): ${dates.error.message}`);
    policy = {
      holidays: new Set((dates.data ?? []).map(d => d.holiday_date as string)),
      supportedYearStart: years.data.supported_year_start as number, supportedYearEnd: years.data.supported_year_end as number,
    };
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
      if (createdCalendarId) {
        const used = await service.from("leave_records").select("id", { count: "exact", head: true }).eq("calendar_version_id", createdCalendarId);
        if (!used.error && used.count === 0) {
          await service.from("holiday_calendar_dates").delete().eq("version_id", createdCalendarId);
          await service.from("holiday_calendar_versions").delete().eq("id", createdCalendarId);
        }
      }
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the employee record their own leave; the database stamps author and time and keeps the calendar version", async () => {
    const own = await signedIn(ownEmail);
    const added = await own.from("leave_records")
      .insert(period(childEmployee, "2026-01-05", "2026-01-05", { created_by: managerUserId, created_at: "2000-01-01T00:00:00Z", cancelled_at: "2000-01-01T00:00:00Z" }))
      .select(COLUMNS).single();
    expect(added.error).toBeNull();
    const row = added.data as Row;
    expect(row.created_by).toBe(ownUserId);
    expect(row.cancelled_at).toBeNull();
    expect(row.calendar_version_id).toBe(calendarVersionId);
    expect(Date.parse(row.created_at)).toBeGreaterThan(startedAt - 60_000);
  });

  it("hides the C employee's leave from another Staff member and refuses their insert", async () => {
    const target = await seed(childEmployee, "2026-01-12");
    const other = await signedIn(otherEmail);
    const { data, error } = await other.from("leave_records").select("id").eq("employee_id", childEmployee);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect((await other.from("leave_records").insert(period(childEmployee, "2026-01-13"))).error?.code).toBe("42501");
    expect((await read(target.id)).employee_id).toBe(childEmployee);
  });

  it("lets the P manager record the C employee's leave but not the U employee's", async () => {
    const manager = await signedIn(managerEmail);
    const inC = await manager.from("leave_records").insert(period(childEmployee, "2026-01-19")).select(COLUMNS).single();
    expect(inC.error).toBeNull();
    expect((inC.data as Row).created_by).toBe(managerUserId);
    expect((await manager.from("leave_records").insert(period(unrelatedEmployee, "2026-01-19"))).error?.code).toBe("42501");
    const inU = await seed(unrelatedEmployee, "2026-01-20");
    expect((await manager.from("leave_records").select("id").eq("id", inU.id)).data ?? []).toHaveLength(0);
  });

  it("lets the Administrator record anyone's leave", async () => {
    const admin = await signedIn(adminEmail);
    for (const employeeId of [childEmployee, unrelatedEmployee, managerId]) {
      expect((await admin.from("leave_records").insert(period(employeeId, "2026-01-26")).select("id").single()).error).toBeNull();
    }
  });

  it("refuses an overlapping period (inclusive) at the database, allows an adjacent one, and ignores cancelled periods", async () => {
    const admin = await signedIn(adminEmail);
    await seed(childEmployee, "2026-02-02", "2026-02-05");
    const overlap = await admin.from("leave_records").insert(period(childEmployee, "2026-02-05", "2026-02-10"));
    expect(overlap.error?.code).toBe("23514");
    expect(overlap.error?.message).toContain("leave_overlap");
    expect(overlap.error?.details).toBe("2026-02-02,2026-02-05");
    expect((await admin.from("leave_records").insert(period(childEmployee, "2026-02-06"))).error).toBeNull();

    const cancelled = await seed(childEmployee, "2026-02-16");
    expect((await service.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", cancelled.id)).error).toBeNull();
    expect((await admin.from("leave_records").insert(period(childEmployee, "2026-02-16"))).error).toBeNull();
  });

  it("refuses dates outside the calendar version's years and the value checks", async () => {
    const admin = await signedIn(adminEmail);
    expect((await admin.from("leave_records").insert(period(childEmployee, "2099-03-02"))).error?.message).toContain("leave_outside_calendar");
    for (const extra of [{ working_days: 0 }, { category: "LONG" }, { end_date: "2026-02-28", start_date: "2026-03-02" }]) {
      expect((await admin.from("leave_records").insert(period(childEmployee, "2026-03-02", "2026-03-02", extra))).error?.code).toBe("23514");
    }
  });

  it("recounts every insert: a wrong working-day count or category is refused (23514)", async () => {
    const own = await signedIn(ownEmail);
    // 2–6 Mar 2026: Mon–Fri with no holiday → 5 working days, 4–14.
    expect(counted("2026-03-02", "2026-03-06")).toEqual({ working_days: 5, category: "FOUR_TO_FOURTEEN" });
    const wrongCount = await own.from("leave_records").insert(period(childEmployee, "2026-03-02", "2026-03-06", { working_days: 4 }));
    expect(wrongCount.error?.code).toBe("23514");
    expect(wrongCount.error?.message).toContain("leave_working_days_mismatch");
    const wrongCategory = await own.from("leave_records").insert(period(childEmployee, "2026-03-02", "2026-03-06", { category: "ONE_TO_THREE" }));
    expect(wrongCategory.error?.code).toBe("23514");
    expect(wrongCategory.error?.message).toContain("leave_category_mismatch");
    // A holiday counted as a working day: 25–27 Mar 2026 (26 Mar is Independence Day) is 2, not 3.
    expect((await own.from("leave_records").insert(period(childEmployee, "2026-03-25", "2026-03-27", { working_days: 3 }))).error?.message)
      .toContain("leave_working_days_mismatch");
  });

  it("refuses a period counted with a calendar version that is no longer active (23514 leave_calendar_changed)", async () => {
    const stale = calendarVersionId;
    // A newer version with the same holidays (so counts stay the same while it is active); deleted at once (no leave uses it).
    const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: PROVISIONAL }]);
    const newer = await service.rpc("load_holiday_calendar", {
      p_jurisdiction: `${PREFIX} Newer`, p_timezone: "Asia/Dhaka", p_year_start: calendar.supportedYearStart, p_year_end: calendar.supportedYearEnd,
      p_source: "bangladesh-2026.csv", p_holidays: calendar.holidays,
    }).single<{ id: string }>();
    if (newer.error) throw new Error(`Could not load a newer calendar (${newer.error.code}): ${newer.error.message}`);
    try {
      const admin = await signedIn(adminEmail);
      const refused = await admin.from("leave_records").insert(period(childEmployee, "2026-04-20", "2026-04-20", { calendar_version_id: stale }));
      expect(refused.error?.code).toBe("23514");
      expect(refused.error?.message).toContain("leave_calendar_changed");
    } finally {
      await service.from("holiday_calendar_dates").delete().eq("version_id", newer.data.id);
      await service.from("holiday_calendar_versions").delete().eq("id", newer.data.id);
    }
  });

  it("has no delete for users; the service role cannot delete either", async () => {
    const row = await seed(childEmployee, "2026-02-23");
    for (const address of [adminEmail, ownEmail, managerEmail]) {
      const client = await signedIn(address);
      expect((await client.from("leave_records").delete().eq("id", row.id).select("id")).data ?? []).toHaveLength(0);
    }
    expect((await service.from("leave_records").delete().eq("id", row.id)).error?.code).toBe("23514");
    expect(await read(row.id)).toEqual(row);
  });

  /** The recounted fields of an edit to `start`..`end` under the active calendar. */
  const edit = (start_date: string, end_date: string) => ({ start_date, end_date, ...counted(start_date, end_date), calendar_version_id: calendarVersionId });

  it("Story 5.3: lets the employee edit their own period, recounted; an edit overlapping its own old dates is fine", async () => {
    const own = await signedIn(ownEmail);
    const row = await seed(childEmployee, "2026-07-06", "2026-07-07");
    const edited = await own.from("leave_records").update(edit("2026-07-06", "2026-07-10")).eq("id", row.id).select(COLUMNS).single();
    expect(edited.error).toBeNull();
    expect(edited.data as Row).toMatchObject({ start_date: "2026-07-06", end_date: "2026-07-10", working_days: 5, category: "FOUR_TO_FOURTEEN", created_by: null });
    const self = await own.from("leave_records").update(edit("2026-07-07", "2026-07-09")).eq("id", row.id).select(COLUMNS).single();
    expect(self.error).toBeNull();
    expect((self.data as Row).working_days).toBe(3);
  });

  it("Story 5.3: recounts every edit: a wrong working-day count is refused", async () => {
    const own = await signedIn(ownEmail);
    const row = await seed(childEmployee, "2026-07-14");
    const wrong = await own.from("leave_records").update({ ...edit("2026-07-14", "2026-07-16"), working_days: 1 }).eq("id", row.id);
    expect(wrong.error?.code).toBe("23514");
    expect(wrong.error?.message).toContain("leave_working_days_mismatch");
    expect(await read(row.id)).toEqual(row);
  });

  it("Story 5.3: lets the employee cancel their own period; the database stamps the time; a cancelled row is frozen and kept", async () => {
    const own = await signedIn(ownEmail);
    const row = await seed(childEmployee, "2026-07-13");
    const cancelled = await own.from("leave_records").update({ cancelled_at: "2000-01-01T00:00:00Z" }).eq("id", row.id).select(COLUMNS).single();
    expect(cancelled.error).toBeNull();
    const after = cancelled.data as Row;
    expect(Date.parse(after.cancelled_at!)).toBeGreaterThan(startedAt - 60_000);
    expect({ ...after, cancelled_at: null }).toEqual(row);

    for (const address of [ownEmail, adminEmail]) {
      const client = await signedIn(address);
      const changed = await client.from("leave_records").update(edit("2026-07-13", "2026-07-14")).eq("id", row.id);
      expect(changed.error?.code).toBe("23514");
      expect(changed.error?.message).toContain("was cancelled");
      const again = await client.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", row.id);
      expect(again.error?.message).toContain("was cancelled");
    }
    expect(await read(row.id)).toEqual(after);
    // A cancelled period no longer blocks the same dates.
    expect((await own.from("leave_records").insert(period(childEmployee, "2026-07-13"))).error).toBeNull();
  });

  it("Story 5.3: refuses cancelling and changing in the same update, and changing the employee", async () => {
    const own = await signedIn(ownEmail);
    const admin = await signedIn(adminEmail);
    const row = await seed(childEmployee, "2026-07-15");
    const both = await own.from("leave_records").update({ ...edit("2026-07-15", "2026-07-16"), cancelled_at: new Date().toISOString() }).eq("id", row.id);
    expect(both.error?.code).toBe("23514");
    expect(both.error?.message).toContain("cannot also change");
    const moved = await admin.from("leave_records").update({ employee_id: unrelatedEmployee }).eq("id", row.id);
    expect(moved.error?.code).toBe("23514");
    expect(await read(row.id)).toEqual(row);
  });

  it("Story 5.3: hides another employee's period from a Staff member's update and cancel", async () => {
    const other = await signedIn(otherEmail);
    const row = await seed(childEmployee, "2026-07-20");
    expect((await other.from("leave_records").update(edit("2026-07-20", "2026-07-21")).eq("id", row.id).select("id")).data ?? []).toHaveLength(0);
    expect((await other.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", row.id).select("id")).data ?? []).toHaveLength(0);
    expect(await read(row.id)).toEqual(row);
  });

  it("Story 5.3: lets the P manager change the C employee's period but not the U employee's; the Administrator anyone's", async () => {
    const manager = await signedIn(managerEmail);
    const admin = await signedIn(adminEmail);
    const inC = await seed(childEmployee, "2026-07-27");
    const inU = await seed(unrelatedEmployee, "2026-07-27");
    const editedC = await manager.from("leave_records").update(edit("2026-07-27", "2026-07-28")).eq("id", inC.id).select(COLUMNS).single();
    expect(editedC.error).toBeNull();
    expect((editedC.data as Row).working_days).toBe(2);
    expect((await manager.from("leave_records").update(edit("2026-07-27", "2026-07-28")).eq("id", inU.id).select("id")).data ?? []).toHaveLength(0);
    expect((await manager.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", inU.id).select("id")).data ?? []).toHaveLength(0);
    expect(await read(inU.id)).toEqual(inU);

    const editedU = await admin.from("leave_records").update(edit("2026-07-27", "2026-07-29")).eq("id", inU.id).select(COLUMNS).single();
    expect(editedU.error).toBeNull();
    expect((editedU.data as Row).working_days).toBe(3);
    expect((await admin.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", inC.id).select(COLUMNS).single()).error).toBeNull();
  });

  it("Story 5.3: refuses an edit overlapping another active period at the database (the edited row itself is ignored)", async () => {
    const admin = await signedIn(adminEmail);
    const first = await seed(childEmployee, "2026-09-07", "2026-09-08");
    await seed(childEmployee, "2026-09-14", "2026-09-15");
    const overlap = await admin.from("leave_records").update(edit("2026-09-08", "2026-09-14")).eq("id", first.id);
    expect(overlap.error?.code).toBe("23514");
    expect(overlap.error?.message).toContain("leave_overlap");
    expect(overlap.error?.details).toBe("2026-09-14,2026-09-15");
    expect((await admin.from("leave_records").update(edit("2026-09-08", "2026-09-11")).eq("id", first.id)).error).toBeNull();
  });

  it("Story 5.3: agrees at the store: own edit and cancel, another Staff member, the P manager in and out of scope", async () => {
    const own = { role: "staff", employeeId: childEmployee } as const;
    const other = { role: "staff", employeeId: unrelatedEmployee } as const;
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    const ownStore = await storeFor(ownEmail);
    const saved = await ownStore.record(own, childEmployee, { startDate: "2026-08-10", endDate: "2026-08-11" });
    const edited = await ownStore.update(own, saved.id, { startDate: "2026-08-10", endDate: "2026-08-14" });
    expect(edited).toMatchObject({ id: saved.id, workingDays: 5, category: "FOUR_TO_FOURTEEN", calendarVersionId: calendarVersionId, cancelledAt: null });

    await expect((await storeFor(otherEmail)).update(other, saved.id, { startDate: "2026-08-10", endDate: "2026-08-12" })).rejects.toBeInstanceOf(LeaveNotFoundError);
    const inU = await seed(unrelatedEmployee, "2026-08-17");
    const managerStore = await storeFor(managerEmail);
    // RLS hides a period outside the subtree from the manager's read, so the store finds nothing to change.
    await expect(managerStore.cancel(manager, inU.id)).rejects.toBeInstanceOf(LeaveNotFoundError);
    expect(await read(inU.id)).toEqual(inU);
    expect((await managerStore.update(manager, saved.id, { startDate: "2026-08-10", endDate: "2026-08-12" })).workingDays).toBe(3);

    const cancelled = await ownStore.cancel(own, saved.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    await expect(ownStore.cancel(own, saved.id)).rejects.toBeInstanceOf(LeaveCancelledError);
    await expect(ownStore.update(own, saved.id, { startDate: "2026-08-10", endDate: "2026-08-11" })).rejects.toBeInstanceOf(LeaveCancelledError);
    expect((await ownStore.listFor(own)).find(r => r.id === saved.id)?.cancelledAt).toBe(cancelled.cancelledAt);
  });

  it("denies anon", async () => {
    const row = await seed(childEmployee, "2026-03-09");
    const anon = createClient(url!, anonKey!, noSession);
    expect((await anon.from("leave_records").select("id").eq("id", row.id)).data ?? []).toHaveLength(0);
    expect((await anon.from("leave_records").insert(period(childEmployee, "2026-03-10"))).error).not.toBeNull();
    // Story 5.3: the update policy is for authenticated users only; anon edits and cancels change nothing.
    const edited = await anon.from("leave_records").update({ end_date: "2026-03-10", working_days: 2 }).eq("id", row.id).select("id");
    expect(edited.data ?? []).toHaveLength(0);
    const cancelled = await anon.from("leave_records").update({ cancelled_at: new Date().toISOString() }).eq("id", row.id).select("id");
    expect(cancelled.data ?? []).toHaveLength(0);
    expect(await read(row.id)).toEqual(row);
  });

  it("agrees at the store: own Staff counts against the calendar, the P manager in and out of scope, overlap", async () => {
    const own = { role: "staff", employeeId: childEmployee } as const;
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;

    const ownStore = await storeFor(ownEmail);
    // 23–27 Mar 2026 (Mon–Fri) in the provisional calendar: 23 Mar (Eid-ul-Fitr holiday) and 26 Mar
    // (Independence Day) are holidays → 3 working days, 1–3.
    const saved = await ownStore.record(own, childEmployee, { startDate: "2026-03-23", endDate: "2026-03-27" });
    expect(saved).toMatchObject({ employeeId: childEmployee, calendarVersionId: calendarVersionId, cancelledAt: null });
    expect(saved.workingDays).toBe(3);
    expect(saved.category).toBe("ONE_TO_THREE");
    expect((await ownStore.listFor(own)).map(r => r.id)).toContain(saved.id);
    await expect(ownStore.record(own, unrelatedEmployee, { startDate: "2026-04-06", endDate: "2026-04-06" })).rejects.toBeInstanceOf(LeaveForbiddenError);
    await expect(ownStore.record(own, childEmployee, { startDate: "2026-03-27", endDate: "2026-03-31" })).rejects.toBeInstanceOf(LeaveOverlapError);

    const managerStore = await storeFor(managerEmail);
    expect((await managerStore.record(manager, childEmployee, { startDate: "2026-04-06", endDate: "2026-04-07" })).workingDays).toBe(2);
    expect((await managerStore.record(manager, managerId, { startDate: "2026-04-06", endDate: "2026-04-06" })).employeeId).toBe(managerId);
    await expect(managerStore.record(manager, unrelatedEmployee, { startDate: "2026-04-06", endDate: "2026-04-06" })).rejects.toBeInstanceOf(LeaveForbiddenError);
    expect((await managerStore.listFor(manager)).every(r => r.employeeId === childEmployee)).toBe(true);
  });
});
