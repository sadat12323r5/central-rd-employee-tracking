import {
  AttendanceYearNotCoveredError, monthToDate, summariseAttendance, type AttendancePeriod, type AttendanceSummary, type SummaryLeave,
} from "@/domain/attendance-summary";
import { attendanceStore, type AttendanceStore } from "./attendance-store";
import { holidayCalendarStore, HolidayCalendarUnavailableError, type HolidayCalendarStore } from "./holiday-calendar-store";
import type { SessionIdentity } from "./session";

// Story 5.4: the attendance summaries behind the profile Attendance tab and the org-wide "Attendance & leave"
// view, for the current calendar month to date (Asia/Dhaka). Worked days come from attendance entries (read
// through the session-scoped `attendanceStore.listInPeriod`: RLS plus store scope, never the service role),
// leave days from each employee's non-cancelled leave (already scoped by leave-store, on the employee),
// scheduled days from the active holiday calendar, and missing-record days from the difference. Nothing here
// reads the fixture in src/data/employees.ts.
//
// No calendar loaded, a period year the calendar does not cover, or a calendar read failure is a value (the
// views say so instead of showing numbers). An attendance read failure throws AttendanceUnavailableError,
// which the page turns into its "Attendance is unavailable" alert.

/** The employee fields a summary needs. */
export type SummaryEmployee = { id: string; archived?: boolean; leave: readonly LeaveOf[] };
type LeaveOf = SummaryLeave & { id: string; workingDays: number };

export type AttendanceSummaries<L extends SummaryLeave = LeaveOf> =
  | { period: AttendancePeriod; byEmployee: Record<string, AttendanceSummary<L>> }
  | { unavailable: "no-calendar" }
  | { unavailable: "year"; year: number }
  | { unavailable: "calendar-error" };

export type AttendanceSummaryDeps = {
  calendar: Pick<HolidayCalendarStore, "active">;
  attendance: Pick<AttendanceStore, "listInPeriod">;
};

/**
 * Summaries for the non-archived `employees` (those the portal lists), keyed by employee id, for the month
 * of `today` (an ISO date in Asia/Dhaka) up to `today`.
 */
export async function attendanceSummariesFor<E extends SummaryEmployee>(
  session: SessionIdentity, employees: readonly E[], today: string,
  deps: AttendanceSummaryDeps = { calendar: holidayCalendarStore, attendance: attendanceStore },
): Promise<AttendanceSummaries<E["leave"][number]>> {
  const period = monthToDate(today);
  let active: Awaited<ReturnType<HolidayCalendarStore["active"]>>;
  try {
    active = await deps.calendar.active(session);
  } catch (error) {
    if (!(error instanceof HolidayCalendarUnavailableError)) throw error;
    console.error("Holiday calendar unavailable for the attendance summary.", error, { cause: error.cause });
    return { unavailable: "calendar-error" };
  }
  if (!active) return { unavailable: "no-calendar" };
  const year = Number(period.from.slice(0, 4));
  if (year < active.policy.supportedYearStart || year > active.policy.supportedYearEnd) return { unavailable: "year", year };

  const listed = employees.filter(e => !e.archived);
  const wanted = new Set(listed.map(e => e.id));
  const entries = wanted.size === 0 ? [] : await deps.attendance.listInPeriod(session, period);
  const datesOf = new Map<string, string[]>();
  for (const entry of entries) {
    if (!wanted.has(entry.employeeId)) continue;
    datesOf.set(entry.employeeId, [...(datesOf.get(entry.employeeId) ?? []), entry.date]);
  }
  const byEmployee: Record<string, AttendanceSummary<E["leave"][number]>> = {};
  try {
    for (const employee of listed) {
      byEmployee[employee.id] = summariseAttendance({
        period, policy: active.policy, entryDates: datesOf.get(employee.id) ?? [], leave: employee.leave,
      });
    }
  } catch (error) {
    if (error instanceof AttendanceYearNotCoveredError) return { unavailable: "year", year: error.year };
    throw error;
  }
  return { period, byEmployee };
}
