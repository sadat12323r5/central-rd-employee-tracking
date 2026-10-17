import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HolidayCalendarInputError, ORG_TIMEZONE, toCalendarPolicy, type HolidayCalendar, type HolidayKind,
} from "@/domain/holiday-calendar";
import type { CalendarPolicy } from "@/domain/leave";
import type { SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 5.1: the only way the app reads and writes the holiday calendar. Calendars live in the Supabase
// tables `holiday_calendar_versions` and `holiday_calendar_dates`.
//
// Every load is a new, immutable version (the highest version number is the active calendar); nothing
// here updates or deletes one. `load` is Administrator only and writes the version and its dates in one
// transaction through the `load_holiday_calendar` RPC (security invoker, so RLS applies, and it refuses
// non-Administrators itself). `versions` is Administrator only. `active` serves any signed-in role: Story
// 5.2 counts staff leave through the user's own JWT. Every query goes through a per-request client
// carrying the signed-in user's JWT; this module never uses the service role.

export type CalendarVersion = {
  id: string;
  version: number;
  jurisdiction: string;
  timezone: string;
  supportedYearStart: number;
  supportedYearEnd: number;
  source: string;
  loadedBy: string | null;
  loadedAt: string;
  holidayCount: number;
};

/** What the Administrator loads: one complete calendar (built by `buildCalendar`) and where it came from. */
export type HolidayCalendarLoad = { jurisdiction: string; source: string; calendar: HolidayCalendar };

export const JURISDICTION_MAX = 100;

export interface HolidayCalendarStore {
  /** Stores the calendar as a new version (which becomes active) and returns it. Administrators only. */
  load(session: SessionIdentity, input: HolidayCalendarLoad): Promise<CalendarVersion>;
  /**
   * The active (highest) version and its policy for `countWorkingDays`, or null when no calendar has been
   * loaded. Any signed-in role.
   */
  active(session: SessionIdentity): Promise<{ version: CalendarVersion; policy: CalendarPolicy } | null>;
  /** Every stored version, newest first, with its holiday count. Administrators only. */
  versions(session: SessionIdentity): Promise<CalendarVersion[]>;
}

/** The calendar database is unreachable or refused the query. Never treat this as "no calendar" or "saved". */
export class HolidayCalendarUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The holiday calendar is temporarily unavailable.", options);
    this.name = "HolidayCalendarUnavailableError";
  }
}

/** Only an Administrator can load the holiday calendar (or list its versions). */
export class HolidayCalendarForbiddenError extends Error {
  constructor() {
    super("Only an Administrator can load the holiday calendar.");
    this.name = "HolidayCalendarForbiddenError";
  }
}

export type CalendarVersionRow = {
  id: string; version: number; jurisdiction: string; timezone: string; supported_year_start: number; supported_year_end: number;
  source: string; loaded_by: string | null; loaded_at: string;
};
type CountedVersionRow = CalendarVersionRow & { holiday_calendar_dates?: { count: number }[] };
type DateRow = { holiday_date: string; name: string; kind: HolidayKind };

const VERSIONS = "holiday_calendar_versions";
const DATES = "holiday_calendar_dates";
const COLUMNS = "id,version,jurisdiction,timezone,supported_year_start,supported_year_end,source,loaded_by,loaded_at";
/** PostgREST's max rows per response; a calendar has at most 1000 dates (HOLIDAY_CALENDAR_MAX_ROWS). */
const PAGE = 1000;

export function toCalendarVersion(row: CalendarVersionRow, holidayCount: number): CalendarVersion {
  return {
    id: row.id, version: row.version, jurisdiction: row.jurisdiction, timezone: row.timezone,
    supportedYearStart: row.supported_year_start, supportedYearEnd: row.supported_year_end, source: row.source,
    loadedBy: row.loaded_by ?? null, loadedAt: row.loaded_at, holidayCount,
  };
}

type DbError = { code?: string; message?: string; details?: string };
type Result<T> = { data: T | null; error: DbError | null };

/** Maps a database refusal to the store's typed errors; anything unrecognised is "unavailable". */
function refusal(error: DbError): Error {
  if (error.code === "42501") return new HolidayCalendarForbiddenError();
  if (error.code === "23505") return new HolidayCalendarInputError("The calendar lists the same date twice.");
  if (error.code === "23514" || error.code === "22007" || error.code === "22008") {
    return new HolidayCalendarInputError("The calendar was refused by the database: check its dates, names and kinds.");
  }
  return new HolidayCalendarUnavailableError({ cause: error });
}

export type HolidayCalendarStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createHolidayCalendarStore({ userClient }: HolidayCalendarStoreClients): HolidayCalendarStore {
  async function call<T>(query: (client: SupabaseClient) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query(await userClient());
    } catch (cause) {
      throw new HolidayCalendarUnavailableError({ cause });
    }
    if (result.error) throw refusal(result.error);
    return result.data ?? null;
  }

  async function run<T>(query: (client: SupabaseClient) => PromiseLike<Result<T>>): Promise<T> {
    const data = await call(query);
    if (data === null) throw new HolidayCalendarUnavailableError({ cause: "no data returned" });
    return data;
  }

  function requireAdmin(session: SessionIdentity) {
    if (session?.role !== "admin") throw new HolidayCalendarForbiddenError();
  }

  function checked(input: HolidayCalendarLoad): HolidayCalendarLoad {
    const jurisdiction = input.jurisdiction.trim().replace(/\s+/g, " ");
    if (jurisdiction.length < 1 || jurisdiction.length > JURISDICTION_MAX) {
      throw new HolidayCalendarInputError(`Enter a jurisdiction of 1 to ${JURISDICTION_MAX} characters.`);
    }
    const source = input.source.trim();
    if (source.length < 1) throw new HolidayCalendarInputError("Name the calendar's source file.");
    const { supportedYearStart, supportedYearEnd, holidays } = input.calendar;
    if (holidays.length === 0) throw new HolidayCalendarInputError("The calendar has no holidays.");
    if (holidays.some(h => Number(h.date.slice(0, 4)) < supportedYearStart || Number(h.date.slice(0, 4)) > supportedYearEnd)) {
      throw new HolidayCalendarInputError("Every holiday must fall within the calendar's supported years.");
    }
    return { jurisdiction, source, calendar: input.calendar };
  }

  return {
    async load(session, input) {
      requireAdmin(session);
      const { jurisdiction, source, calendar } = checked(input);
      const saved = await run<CalendarVersionRow>(client => client.rpc("load_holiday_calendar", {
        p_jurisdiction: jurisdiction, p_timezone: ORG_TIMEZONE, p_year_start: calendar.supportedYearStart,
        p_year_end: calendar.supportedYearEnd, p_source: source, p_holidays: calendar.holidays,
      }).single<CalendarVersionRow>());
      return toCalendarVersion(saved, calendar.holidays.length);
    },
    async active(session) {
      if (!session) throw new HolidayCalendarForbiddenError();
      const row = await call<CalendarVersionRow>(client => client.from(VERSIONS).select(COLUMNS)
        .order("version", { ascending: false }).limit(1).maybeSingle<CalendarVersionRow>());
      if (row === null) return null;
      const dates = await run<DateRow[]>(client => client.from(DATES).select("holiday_date,name,kind")
        .eq("version_id", row.id).order("holiday_date").range(0, PAGE - 1).returns<DateRow[]>());
      const policy = toCalendarPolicy({
        supportedYearStart: row.supported_year_start, supportedYearEnd: row.supported_year_end,
        holidays: dates.map(d => ({ date: d.holiday_date })),
      });
      return { version: toCalendarVersion(row, dates.length), policy };
    },
    async versions(session) {
      requireAdmin(session);
      const rows = await run<CountedVersionRow[]>(client => client.from(VERSIONS).select(`${COLUMNS},${DATES}(count)`)
        .order("version", { ascending: false }).returns<CountedVersionRow[]>());
      return rows.map(r => toCalendarVersion(r, r.holiday_calendar_dates?.[0]?.count ?? 0));
    },
  };
}

export const holidayCalendarStore: HolidayCalendarStore = createHolidayCalendarStore({ userClient: getUserClient });
