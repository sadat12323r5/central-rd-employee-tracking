// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users (one Administrator, one Staff) and loads its own calendar
// versions (jurisdiction carrying this run's id, holidays from the provisional bangladesh-2026.csv so the
// shared project's active calendar stays the same while they exist). afterAll removes every version this
// run created through the service role (dates first: version_id is ON DELETE RESTRICT); the app itself
// never deletes a version.
// Rules under test (Story 5.1): only an Administrator loads a calendar (the RPC refuses anyone else with
// 42501, and RLS refuses a direct insert); every signed-in role reads it; nobody updates or deletes it
// through the API; the store's active() returns the highest version as a CalendarPolicy that
// countWorkingDays accepts, with UNSUPPORTED_YEAR outside its years.
// Fails with 42P01 / PGRST205 / PGRST202 until the holiday_calendars migration is applied to the shared project.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCalendar } from "@/domain/holiday-calendar";
import { countWorkingDays, LeaveValidationError } from "@/domain/leave";
import { createHolidayCalendarStore, HolidayCalendarForbiddenError } from "@/server/holiday-calendar-store";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const JURISDICTION = `RLS Calendar ${run}`;
const admin = { role: "admin" } as const;
const staffSession = { role: "staff", employeeId: "BS-9798" } as const;
const PROVISIONAL = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: PROVISIONAL }]);
const rpcArgs = (jurisdiction: string) => ({
  p_jurisdiction: jurisdiction, p_timezone: "Asia/Dhaka", p_year_start: calendar.supportedYearStart, p_year_end: calendar.supportedYearEnd,
  p_source: "bangladesh-2026.csv", p_holidays: calendar.holidays,
});

describe.skipIf(!configured)("holiday calendar RLS (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-cal-admin-${run}@example.com`;
  const staffEmail = `rls-cal-staff-${run}@example.com`;

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

  /** This run's versions (by jurisdiction prefix), through the service role. */
  async function ownVersions(): Promise<{ id: string; version: number }[]> {
    const { data, error } = await service.from("holiday_calendar_versions").select("id,version").like("jurisdiction", `${JURISDICTION}%`);
    if (error) throw new Error(`Could not read test versions (${error.code}): ${error.message}`);
    return data as { id: string; version: number }[];
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await createUser(adminEmail, { role: "admin" });
    await createUser(staffEmail, { role: "staff", employee_id: staffSession.employeeId });
  }, 30_000);

  afterAll(async () => {
    if (!service) return;
    try {
      const ids = (await ownVersions()).map(v => v.id);
      if (ids.length > 0) {
        const dates = await service.from("holiday_calendar_dates").delete().in("version_id", ids);
        if (dates.error) throw new Error(`Could not delete test dates (${dates.error.code}): ${dates.error.message}`);
        const versions = await service.from("holiday_calendar_versions").delete().in("id", ids);
        if (versions.error) throw new Error(`Could not delete test versions (${versions.error.code}): ${versions.error.message}`);
      }
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  it("lets an Administrator load a calendar through the store as a new, active version", async () => {
    const client = await signedIn(adminEmail);
    const store = createHolidayCalendarStore({ userClient: async () => client });
    const saved = await store.load(admin, { jurisdiction: `${JURISDICTION} A`, source: "bangladesh-2026.csv", calendar });
    expect(saved).toMatchObject({
      jurisdiction: `${JURISDICTION} A`, timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
      source: "bangladesh-2026.csv", loadedBy: userIds[0], holidayCount: calendar.holidays.length,
    });
    const { count } = await service.from("holiday_calendar_dates").select("holiday_date", { count: "exact", head: true }).eq("version_id", saved.id);
    expect(count).toBe(calendar.holidays.length);

    const active = await store.active(admin);
    expect(active?.version.id).toBe(saved.id);
    expect(active?.policy.holidays.size).toBe(calendar.holidays.length);
    expect(countWorkingDays("2026-02-01", "2026-02-28", active!.policy)).toBe(17);
    expect(() => countWorkingDays("2027-02-01", "2027-02-03", active!.policy)).toThrow(LeaveValidationError);
    expect(() => countWorkingDays("2027-02-01", "2027-02-03", active!.policy)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_YEAR" }));

    const versions = await store.versions(admin);
    expect(versions[0]).toMatchObject({ id: saved.id, holidayCount: calendar.holidays.length });
  });

  it("keeps the previous version unchanged when a corrected calendar is loaded", async () => {
    const client = await signedIn(adminEmail);
    const store = createHolidayCalendarStore({ userClient: async () => client });
    const first = await store.load(admin, { jurisdiction: `${JURISDICTION} B1`, source: "bangladesh-2026.csv", calendar });
    // Drops a Saturday holiday, so working-day counts stay identical while this version is active.
    expect(new Date("2026-05-30T00:00:00Z").getUTCDay()).toBe(6);
    const corrected = { ...calendar, holidays: calendar.holidays.filter(h => h.date !== "2026-05-30") };
    const second = await store.load(admin, { jurisdiction: `${JURISDICTION} B2`, source: "corrected.csv", calendar: corrected });
    expect(second.version).toBeGreaterThan(first.version);
    const { count } = await service.from("holiday_calendar_dates").select("holiday_date", { count: "exact", head: true }).eq("version_id", first.id);
    expect(count).toBe(calendar.holidays.length);
    expect((await store.active(admin))?.version.id).toBe(second.id);
  });

  it("lets Staff read the calendar and the active policy", async () => {
    const staff = await signedIn(staffEmail);
    const read = await staff.from("holiday_calendar_versions").select("id").like("jurisdiction", `${JURISDICTION}%`);
    expect(read.error).toBeNull();
    expect((read.data ?? []).length).toBeGreaterThan(0);
    const active = await createHolidayCalendarStore({ userClient: async () => staff }).active(staffSession);
    expect(active).not.toBeNull();
    expect(active!.policy.supportedYearStart).toBeLessThanOrEqual(active!.policy.supportedYearEnd);
  });

  it("refuses Staff loads at the RPC, the tables and the store, storing nothing", async () => {
    const before = (await ownVersions()).length;
    const staff = await signedIn(staffEmail);
    const rpc = await staff.rpc("load_holiday_calendar", rpcArgs(`${JURISDICTION} Staff`));
    expect(rpc.error?.code).toBe("42501");
    const direct = await staff.from("holiday_calendar_versions").insert({
      jurisdiction: `${JURISDICTION} Staff direct`, supported_year_start: 2026, supported_year_end: 2026, source: "x.csv",
    }, { defaultToNull: false });
    expect(direct.error).not.toBeNull();
    const [existing] = await ownVersions();
    const date = await staff.from("holiday_calendar_dates").insert({ version_id: existing.id, holiday_date: "2026-01-05", name: "X", kind: "general" });
    expect(date.error).not.toBeNull();
    await expect(createHolidayCalendarStore({ userClient: async () => staff }).load(staffSession, {
      jurisdiction: `${JURISDICTION} Staff store`, source: "x.csv", calendar,
    })).rejects.toBeInstanceOf(HolidayCalendarForbiddenError);
    expect((await ownVersions()).length).toBe(before);
  });

  it("refuses an anonymous client's load and read", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    const rpc = await anon.rpc("load_holiday_calendar", rpcArgs(`${JURISDICTION} Anon`));
    expect(rpc.error).not.toBeNull();
    const { data } = await anon.from("holiday_calendar_versions").select("id").like("jurisdiction", `${JURISDICTION}%`);
    expect(data ?? []).toEqual([]);
  });

  it("updates and deletes nothing for anyone through the API, and adds no dates to a stored version", async () => {
    const [existing] = await ownVersions();
    for (const email of [adminEmail, staffEmail]) {
      const client = await signedIn(email);
      const updated = await client.from("holiday_calendar_versions").update({ source: "changed.csv" }).eq("id", existing.id).select("id");
      expect(updated.data ?? []).toEqual([]);
      const renamed = await client.from("holiday_calendar_dates").update({ name: "Changed" }).eq("version_id", existing.id).select("version_id");
      expect(renamed.data ?? []).toEqual([]);
      const deleted = await client.from("holiday_calendar_dates").delete().eq("version_id", existing.id).select("version_id");
      expect(deleted.data ?? []).toEqual([]);
      const gone = await client.from("holiday_calendar_versions").delete().eq("id", existing.id).select("id");
      expect(gone.data ?? []).toEqual([]);
    }
    // The service role (which bypasses RLS) still cannot add a date to a version stored in an earlier transaction.
    const late = await service.from("holiday_calendar_dates").insert({ version_id: existing.id, holiday_date: "2026-01-05", name: "Late", kind: "general" });
    expect(late.error?.code).toBe("23514");
    // The service role cannot update a version either (trigger).
    const serviceUpdate = await service.from("holiday_calendar_versions").update({ source: "changed.csv" }).eq("id", existing.id);
    expect(serviceUpdate.error?.code).toBe("23514");
    const { data } = await service.from("holiday_calendar_versions").select("source").eq("id", existing.id).single();
    expect(data?.source).not.toBe("changed.csv");
    const { count } = await service.from("holiday_calendar_dates").select("holiday_date", { count: "exact", head: true }).eq("version_id", existing.id);
    expect(count).toBeGreaterThan(0);
  });

  it("refuses an Administrator's direct insert into either table (only load_holiday_calendar may insert)", async () => {
    const before = (await ownVersions()).length;
    const client = await signedIn(adminEmail);
    const version = await client.from("holiday_calendar_versions").insert({
      jurisdiction: `${JURISDICTION} Admin direct`, supported_year_start: 2026, supported_year_end: 2026, source: "x.csv",
    }, { defaultToNull: false });
    expect(version.error?.code).toBe("42501");
    const [existing] = await ownVersions();
    const date = await client.from("holiday_calendar_dates").insert({ version_id: existing.id, holiday_date: "2026-01-05", name: "Late", kind: "general" });
    expect(date.error?.code).toBe("42501");
    expect((await ownVersions()).length).toBe(before);
    const { count } = await service.from("holiday_calendar_dates").select("holiday_date", { count: "exact", head: true })
      .eq("version_id", existing.id).eq("holiday_date", "2026-01-05");
    expect(count).toBe(0);
  });

  it("rejects a holiday outside the supported years and a non-Asia/Dhaka timezone in the database, storing nothing", async () => {
    const before = (await ownVersions()).length;
    const client = await signedIn(adminEmail);
    const outside = await client.rpc("load_holiday_calendar", { ...rpcArgs(`${JURISDICTION} Outside`), p_year_end: 2026,
      p_holidays: [...calendar.holidays, { date: "2027-01-01", name: "New Year", kind: "general" }] });
    expect(outside.error?.code).toBe("23514");
    const timezone = await client.rpc("load_holiday_calendar", { ...rpcArgs(`${JURISDICTION} Tz`), p_timezone: "UTC" });
    expect(timezone.error?.code).toBe("23514");
    expect((await ownVersions()).length).toBe(before);
  });
});
