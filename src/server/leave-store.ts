import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeaveRecord } from "@/data/employees";
import { categoryForWorkingDays, countWorkingDays, LeaveValidationError, type LeaveCategory } from "@/domain/leave";
import {
  holidayCalendarStore, HolidayCalendarForbiddenError, HolidayCalendarUnavailableError, type HolidayCalendarStore,
} from "./holiday-calendar-store";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import { readAllPages } from "./paging";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 5.2: the only way the app reads and records leave. Periods live in the Supabase `leave_records` table.
//
// Who may record an employee's leave: the employee themselves (a staff session, own record only; managers
// and employee-linked Administrators in "My record" under the same rule), the Administrator (anyone) and a
// department manager (employees in their subtree, from manager-scope, worked out fresh on every call). Every
// query goes through a per-request client carrying the signed-in user's JWT, so the leave_records RLS
// policies (admin, own, or manages_employee) are enforced; the checks here are the store-level layer on top.
//
// A period is counted with `countWorkingDays` against the active holiday calendar (holidayCalendarStore.active),
// its category comes from `categoryForWorkingDays`, and both are stored with the calendar version used. A period
// that intersects (inclusive) another non-cancelled period of the same employee is refused here first; the
// guard trigger (per-employee advisory lock) is the backstop and raises 23514 `leave_overlap`, mapped to the
// same error. This module never uses the service role.
//
// Story 5.3: a period can be edited (new dates, recounted against the active calendar, overlap ignoring the
// period itself) or cancelled (cancelled_at set; the row stays and no longer counts). The subject employee
// comes from the stored row, never the caller; who may change it is exactly who may record it. A cancelled
// period can no longer be changed (here, and by the guard trigger). Nothing is ever deleted.

export type LeaveInput = { startDate: string; endDate: string };

export interface LeaveStore {
  /**
   * Records a leave period for `employeeId` (staff: must be their own; manager: their own or in their
   * subtree). Throws LeaveForbiddenError, LeaveCalendarMissingError, LeaveCalendarChangedError,
   * LeaveValidationFailedError, LeaveOverlapError or LeaveUnavailableError.
   */
  record(session: SessionIdentity, employeeId: string, input: LeaveInput): Promise<LeaveRecord>;
  /**
   * Leave periods the session may see (cancelled ones included), newest start first per employee: anyone's
   * for an Administrator, the subtree's for a manager, only the session's own for staff. `employeeId`
   * narrows the list to one employee (staff asking for anyone else, or a manager outside the subtree: `[]`).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<LeaveRecord[]>;
  /**
   * Changes the dates of an active period (recounted against the active calendar; the overlap check ignores
   * the period itself). The employee comes from the stored row. Throws LeaveNotFoundError (unknown, not
   * visible, or another employee's for staff), LeaveForbiddenError (a manager outside the subtree),
   * LeaveCancelledError, and the errors `record` throws for the new dates.
   */
  update(session: SessionIdentity, id: string, input: LeaveInput): Promise<LeaveRecord>;
  /**
   * Cancels an active period (sets `cancelled_at`; the row is kept and never deleted). Throws
   * LeaveNotFoundError, LeaveForbiddenError, LeaveCancelledError or LeaveUnavailableError.
   */
  cancel(session: SessionIdentity, id: string): Promise<LeaveRecord>;
}

/** The session may not record this employee's leave (another employee for staff, outside a manager's subtree). */
export class LeaveForbiddenError extends Error {
  constructor() {
    super("Only the employee, an Administrator, or a manager for their own department subtree can record leave.");
    this.name = "LeaveForbiddenError";
  }
}

/** No leave period with this id is visible to the session (unknown, not visible, or another employee's for staff). */
export class LeaveNotFoundError extends Error {
  constructor() {
    super("This leave period no longer exists.");
    this.name = "LeaveNotFoundError";
  }
}

/** The period was cancelled and can no longer be changed (or cancelled again). */
export class LeaveCancelledError extends Error {
  constructor() {
    super("This leave was cancelled and can no longer be changed.");
    this.name = "LeaveCancelledError";
  }
}

/**
 * The period intersects another non-cancelled leave of the same employee. `existing` is that period, or null
 * when the database refused the overlap without naming it.
 */
export class LeaveOverlapError extends Error {
  readonly existing: LeaveInput | null;
  constructor(existing: LeaveInput | null) {
    super(existing ? `The period overlaps leave already recorded from ${existing.startDate} to ${existing.endDate}.` : "The period overlaps leave already recorded.");
    this.name = "LeaveOverlapError";
    this.existing = existing;
  }
}

/** A new holiday calendar version became active between counting the period and saving it. Nothing was saved. */
export class LeaveCalendarChangedError extends Error {
  constructor() {
    super("The holiday calendar changed while saving.");
    this.name = "LeaveCalendarChangedError";
  }
}

/** No holiday calendar has been loaded, so no period can be counted. */
export class LeaveCalendarMissingError extends Error {
  constructor() {
    super("No holiday calendar is loaded.");
    this.name = "LeaveCalendarMissingError";
  }
}

/**
 * The period failed validation (`code` from `LeaveValidationError`). For UNSUPPORTED_YEAR, `year` is the
 * offending year and `supportedYearStart` / `supportedYearEnd` the active calendar's years.
 */
export class LeaveValidationFailedError extends Error {
  readonly code: LeaveValidationError["code"];
  readonly year: number | null;
  readonly supportedYearStart: number | null;
  readonly supportedYearEnd: number | null;
  constructor(code: LeaveValidationError["code"], years: { year?: number | null; supportedYearStart?: number | null; supportedYearEnd?: number | null } = {}) {
    super(`Invalid leave period: ${code}.`);
    this.name = "LeaveValidationFailedError";
    this.code = code;
    this.year = years.year ?? null;
    this.supportedYearStart = years.supportedYearStart ?? null;
    this.supportedYearEnd = years.supportedYearEnd ?? null;
  }
}

/** There is no employee with this Employee ID. */
export class LeaveEmployeeNotFoundError extends Error {
  constructor() {
    super("No employee has this Employee ID.");
    this.name = "LeaveEmployeeNotFoundError";
  }
}

/** The database (the calendar, or the manager's scope) is unreachable or refused the query. Never "saved" or "no leave". */
export class LeaveUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Leave is temporarily unavailable.", options);
    this.name = "LeaveUnavailableError";
  }
}

export type LeaveRow = {
  id: string; employee_id: string; start_date: string; end_date: string; working_days: number; category: LeaveCategory;
  calendar_version_id: string; cancelled_at: string | null; created_at: string;
};

const TABLE = "leave_records";
const COLUMNS = "id,employee_id,start_date,end_date,working_days,category,calendar_version_id,cancelled_at,created_at";

export function toLeaveRecord(row: LeaveRow): LeaveRecord {
  return {
    id: row.id, employeeId: row.employee_id, startDate: row.start_date, endDate: row.end_date, workingDays: row.working_days,
    category: row.category, calendarVersionId: row.calendar_version_id, cancelledAt: row.cancelled_at ?? null, createdAt: row.created_at,
  };
}

/** Newest start first within each employee (id breaks ties); employees keep the order they first appear in. */
function newestFirstPerEmployee(records: LeaveRecord[]): LeaveRecord[] {
  const groups = new Map<string, LeaveRecord[]>();
  for (const record of records) {
    const group = groups.get(record.employeeId);
    if (group) group.push(record);
    else groups.set(record.employeeId, [record]);
  }
  const order = (a: LeaveRecord, b: LeaveRecord) =>
    b.startDate.localeCompare(a.startDate) || b.endDate.localeCompare(a.endDate) || b.id.localeCompare(a.id);
  return [...groups.values()].flatMap(group => group.sort(order));
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string; details?: string };

const OVERLAP_DETAIL = /^(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})$/;

export type LeaveStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
  /** Where the active holiday calendar comes from (default: the real holiday-calendar-store). */
  calendar?: Pick<HolidayCalendarStore, "active">;
};

export function createLeaveStore({ userClient, scope = managerScope, calendar = holidayCalendarStore }: LeaveStoreClients): LeaveStore {
  type Query<T> = (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>;

  /** Runs a query whose "no row" is a legitimate answer (maybeSingle): null means not found. */
  async function runMaybe<T>(query: Query<T>, refusal: (error: unknown) => Error = cause => new LeaveUnavailableError({ cause })): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new LeaveUnavailableError({ cause });
    }
    if (result.error) throw refusal(result.error);
    return result.data ?? null;
  }

  async function run<T>(query: Query<T>, refusal?: (error: unknown) => Error): Promise<T> {
    const data = await runMaybe(query, refusal);
    if (data === null) throw new LeaveUnavailableError({ cause: "no data returned" });
    return data;
  }

  /** The employee ids in a manager's subtree. A scope that cannot be read is "unavailable", never "allowed" or "nothing". */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new LeaveUnavailableError({ cause });
      throw cause;
    }
  }

  /** Throws LeaveForbiddenError unless the session may record `employeeId`'s leave. */
  async function authorize(session: SessionIdentity, employeeId: string): Promise<void> {
    if (!session) throw new LeaveForbiddenError();
    if (session.role === "admin") return;
    if (session.role === "staff") {
      if (employeeId !== session.employeeId) throw new LeaveForbiddenError();
      return;
    }
    // A manager records their own leave from "My record" under the Staff own-record rule.
    if (employeeId === session.employeeId) return;
    if (!(await managedEmployeeIds(session)).has(employeeId)) throw new LeaveForbiddenError();
  }

  async function activeCalendar(session: SessionIdentity) {
    try {
      const active = await calendar.active(session);
      if (!active) throw new LeaveCalendarMissingError();
      return active;
    } catch (cause) {
      if (cause instanceof HolidayCalendarUnavailableError) throw new LeaveUnavailableError({ cause });
      if (cause instanceof HolidayCalendarForbiddenError) throw new LeaveForbiddenError();
      throw cause;
    }
  }

  /**
   * Maps a refused insert or update to the store's typed errors; anything unrecognised is "unavailable".
   * `input` / `years` are the period being saved (absent for a cancel).
   */
  function writeRefusal(input?: LeaveInput, years?: { supportedYearStart: number; supportedYearEnd: number }) {
    return (error: unknown): Error => {
      const { code, message = "", details = "" } = (error as DbError | null) ?? {};
      if (code === "42501") return new LeaveForbiddenError();
      if (code === "23514" && message.includes("was cancelled")) return new LeaveCancelledError();
      if (code === "23514" && message.includes("leave_overlap")) {
        const match = OVERLAP_DETAIL.exec(details.trim());
        return new LeaveOverlapError(match ? { startDate: match[1], endDate: match[2] } : null);
      }
      if (code === "23514" && message.includes("leave_calendar_changed")) return new LeaveCalendarChangedError();
      if (code === "23514" && message.includes("leave_outside_calendar")) {
        return new LeaveValidationFailedError("UNSUPPORTED_YEAR", input && years ? { year: outsideYear(input, years), ...years } : {});
      }
      if (code === "23503" && `${message} ${details}`.includes("employee_id")) return new LeaveEmployeeNotFoundError();
      return new LeaveUnavailableError({ cause: error });
    };
  }

  /**
   * Counts `input` against the active calendar: the working days, their category, the version id and the
   * calendar's years. Throws LeaveCalendarMissingError, LeaveValidationFailedError or LeaveUnavailableError.
   */
  async function counted(session: SessionIdentity, input: LeaveInput) {
    const { version, policy } = await activeCalendar(session);
    const years = { supportedYearStart: policy.supportedYearStart, supportedYearEnd: policy.supportedYearEnd };
    let workingDays: number;
    try {
      workingDays = countWorkingDays(input.startDate, input.endDate, policy);
    } catch (cause) {
      if (!(cause instanceof LeaveValidationError)) throw cause;
      throw new LeaveValidationFailedError(cause.code, cause.code === "UNSUPPORTED_YEAR" ? { year: outsideYear(input, years), ...years } : {});
    }
    return { workingDays, category: categoryForWorkingDays(workingDays).category, versionId: version.id, years };
  }

  /**
   * Store-level overlap check (inclusive, non-cancelled only, `except` = the period being edited); the
   * guard trigger repeats it under a lock.
   */
  async function refuseOverlap(employeeId: string, input: LeaveInput, except?: string) {
    const overlapping = await run<Pick<LeaveRow, "start_date" | "end_date">[]>(t => {
      const base = t.select("start_date,end_date").eq("employee_id", employeeId).is("cancelled_at", null);
      return (except === undefined ? base : base.neq("id", except))
        .lte("start_date", input.endDate).gte("end_date", input.startDate)
        .order("start_date").limit(1).returns<Pick<LeaveRow, "start_date" | "end_date">[]>();
    });
    if (overlapping.length > 0) throw new LeaveOverlapError({ startDate: overlapping[0].start_date, endDate: overlapping[0].end_date });
  }

  /**
   * The active period `id` the session may change. The subject employee comes from the stored row: Staff
   * see another employee's period as not found; a manager outside the subtree is forbidden.
   */
  async function changeable(session: SessionIdentity, id: string): Promise<LeaveRow> {
    if (!session) throw new LeaveForbiddenError();
    const current = await runMaybe<LeaveRow>(t => t.select(COLUMNS).eq("id", id).maybeSingle<LeaveRow>());
    if (!current) throw new LeaveNotFoundError();
    if (session.role === "staff" && current.employee_id !== session.employeeId) throw new LeaveNotFoundError();
    await authorize(session, current.employee_id);
    if (current.cancelled_at !== null && current.cancelled_at !== undefined) throw new LeaveCancelledError();
    return current;
  }

  /**
   * Writes `values` to the active period `current`, filtered by id, employee and `cancelled_at is null`, so a
   * period cancelled in between changes nothing (reported as cancelled).
   */
  async function write(current: LeaveRow, values: Partial<LeaveRow>, refusal: (error: unknown) => Error): Promise<LeaveRecord> {
    const saved = await runMaybe<LeaveRow>(t => t.update(values)
      .eq("id", current.id).eq("employee_id", current.employee_id).is("cancelled_at", null)
      .select(COLUMNS).maybeSingle<LeaveRow>(), refusal);
    if (!saved) throw new LeaveCancelledError();
    // Defence in depth: the stored row must still belong to the same employee.
    if (saved.employee_id !== current.employee_id || saved.id !== current.id) throw new LeaveUnavailableError({ cause: "changed another row" });
    return toLeaveRecord(saved);
  }

  return {
    async record(session, employeeId, input) {
      await authorize(session, employeeId);
      const { workingDays, category, versionId, years } = await counted(session, input);
      await refuseOverlap(employeeId, input);

      const saved = await run<LeaveRow>(t => t.insert({
        employee_id: employeeId, start_date: input.startDate, end_date: input.endDate, working_days: workingDays,
        category, calendar_version_id: versionId,
      }).select(COLUMNS).single<LeaveRow>(), writeRefusal(input, years));
      // Defence in depth: the stored row must belong to the employee asked for.
      if (saved.employee_id !== employeeId) throw new LeaveUnavailableError({ cause: "saved for another employee" });
      return toLeaveRecord(saved);
    },
    async update(session, id, input) {
      const current = await changeable(session, id);
      const { workingDays, category, versionId, years } = await counted(session, input);
      await refuseOverlap(current.employee_id, input, current.id);
      return write(current, {
        start_date: input.startDate, end_date: input.endDate, working_days: workingDays, category, calendar_version_id: versionId,
      }, writeRefusal(input, years));
    },
    async cancel(session, id) {
      const current = await changeable(session, id);
      // The guard trigger stamps the time (now()); the value sent only marks the period cancelled.
      return write(current, { cancelled_at: new Date().toISOString() }, writeRefusal());
    },
    async listFor(session, employeeId) {
      let filter: { eq: string } | { in: string[] } | null = null;
      let allowed: Set<string> | null = null;
      if (session.role === "staff") {
        if (employeeId !== undefined && employeeId !== session.employeeId) return [];
        filter = { eq: session.employeeId };
        allowed = new Set([session.employeeId]);
      } else if (session.role === "manager") {
        allowed = await managedEmployeeIds(session);
        if (employeeId !== undefined && !allowed.has(employeeId)) return [];
        if (allowed.size === 0) return [];
        filter = employeeId !== undefined ? { eq: employeeId } : { in: [...allowed] };
      } else if (employeeId !== undefined) {
        filter = { eq: employeeId };
      }
      // Paged (Story 8.2): one request is capped at PostgREST's max_rows; the order is total (id last).
      const rows = await readAllPages((from, to) => run<LeaveRow[]>(t => {
        const base = t.select(COLUMNS);
        const scoped = filter === null ? base : "eq" in filter ? base.eq("employee_id", filter.eq) : base.in("employee_id", filter.in);
        return scoped
          .order("employee_id")
          .order("start_date", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to)
          .returns<LeaveRow[]>();
      }));
      // Defence in depth: never a period outside the session's scope.
      return newestFirstPerEmployee(rows.filter(row => allowed === null || allowed.has(row.employee_id)).map(toLeaveRecord));
    },
  };
}

/** The year of the period that falls outside the calendar (the start's when both do). */
function outsideYear(input: LeaveInput, years: { supportedYearStart: number; supportedYearEnd: number }): number | null {
  for (const date of [input.startDate, input.endDate]) {
    const year = Number(date.slice(0, 4));
    if (Number.isInteger(year) && (year < years.supportedYearStart || year > years.supportedYearEnd)) return year;
  }
  return null;
}

export const leaveStore: LeaveStore = createLeaveStore({ userClient: getUserClient });
