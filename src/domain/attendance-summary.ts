import { isWorkingDay, type CalendarPolicy } from "./leave";

// Story 5.4: one employee's attendance summary for a reporting period, computed only from real records:
// attendance entry dates (Story 1.5), non-cancelled leave periods (Stories 5.2/5.3) and the holiday
// calendar (Story 5.1, as the `CalendarPolicy` that leave counting uses). Pure: no framework or DB imports.
//
// Per scheduled day (Monday to Friday, not a calendar holiday, within the period): an attendance entry that
// day → worked; else a non-cancelled leave period covering it → leave; else → missing record. So a day with an
// entry is never also counted as leave. `worked` counts every entry dated within the period (weekend and
// holiday entries included); `missing` is the difference `scheduled − scheduled days with an entry − leave`.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** An inclusive range of ISO calendar dates. */
export type AttendancePeriod = { from: string; to: string };

/** The leave fields the summary needs (a `LeaveRecord` fits). */
export type SummaryLeave = { startDate: string; endDate: string; cancelledAt: string | null };

/** A scheduled day without an attendance entry: on leave (with the covering period) or a missing record. */
export type AttendanceException<L extends SummaryLeave = SummaryLeave> =
  | { date: string; kind: "leave"; leave: L }
  | { date: string; kind: "missing" };

export type AttendanceSummary<L extends SummaryLeave = SummaryLeave> = {
  scheduled: number; worked: number; leave: number; missing: number;
  /** Every scheduled day classified leave or missing, oldest first. */
  exceptions: AttendanceException<L>[];
};

/** The period's year is outside the holiday calendar's supported years: scheduled days cannot be counted. */
export class AttendanceYearNotCoveredError extends Error {
  constructor(public readonly year: number) {
    super(`The holiday calendar doesn't cover ${year} yet.`);
    this.name = "AttendanceYearNotCoveredError";
  }
}

function parts(value: string): [number, number, number] {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError(`Invalid ISO date: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const toIso = (time: number) => new Date(time).toISOString().slice(0, 10);
const utc = (value: string) => { const [y, m, d] = parts(value); return Date.UTC(y, m - 1, d); };

/** The current calendar month to date: `2026-10-17` → 1 to 17 October 2026 (future days cannot have records). */
export function monthToDate(today: string): AttendancePeriod {
  const [year, month] = parts(today);
  return { from: `${year}-${String(month).padStart(2, "0")}-01`, to: today };
}

/** `1–17 October 2026`; a one-day period is `1 October 2026`. For a period within one month. */
export function periodLabel({ from, to }: AttendancePeriod): string {
  const [, , fromDay] = parts(from);
  const [year, month, toDay] = parts(to);
  const days = fromDay === toDay ? `${toDay}` : `${fromDay}–${toDay}`;
  return `${days} ${MONTHS[month - 1]} ${year}`;
}

/**
 * The summary for one employee. `entryDates` are the dates of their attendance entries (any range; only those
 * within the period count); cancelled leave is ignored. Throws AttendanceYearNotCoveredError when a year of the
 * period is outside the policy. Never throws for a period without scheduled days (all zeros).
 */
export function summariseAttendance<L extends SummaryLeave>({ period, policy, entryDates, leave }: {
  period: AttendancePeriod; policy: CalendarPolicy; entryDates: readonly string[]; leave: readonly L[];
}): AttendanceSummary<L> {
  const start = utc(period.from);
  const end = utc(period.to);
  for (const year of new Set([parts(period.from)[0], parts(period.to)[0]])) {
    if (year < policy.supportedYearStart || year > policy.supportedYearEnd) throw new AttendanceYearNotCoveredError(year);
  }
  const inPeriod = new Set(entryDates.filter(d => d >= period.from && d <= period.to));
  const active = leave.filter(l => l.cancelledAt === null);
  let scheduled = 0;
  let withEntry = 0;
  let onLeave = 0;
  const exceptions: AttendanceException<L>[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    const date = toIso(time);
    if (!isWorkingDay(date, policy)) continue;
    scheduled += 1;
    if (inPeriod.has(date)) { withEntry += 1; continue; }
    const covering = active.find(l => l.startDate <= date && date <= l.endDate);
    if (covering) {
      onLeave += 1;
      exceptions.push({ date, kind: "leave", leave: covering });
    } else {
      exceptions.push({ date, kind: "missing" });
    }
  }
  return { scheduled, worked: inPeriod.size, leave: onLeave, missing: scheduled - withEntry - onLeave, exceptions };
}
