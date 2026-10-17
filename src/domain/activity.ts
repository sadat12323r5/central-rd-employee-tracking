// One employee's activity timeline (Story 8.1): period resolution, timeline rows and their CSV.
// Pure functions only: reading the sources, sessions and the audit write live in src/server.
// Story 8.4 adds assignments (tracked and backfilled), closed-assignment evaluations and leave. A record that
// spans days (an assignment, a leave period) is dated by its start but included when its range touches the period.
import type { Assignment, AssignmentEvaluation, BackfilledProject, LeaveRecord } from "@/data/employees";
import { CSV_BOM, guardCell, toCsv } from "./csv";
import { formatDisplayDate, isCalendarDate } from "./dates";
import { authorLabel, isAmended } from "./evaluations";
import { categoryForWorkingDays } from "./leave";
import { dhakaDate, entryStatus, type TimesheetEntry } from "./timesheet";

export const PERIODS = ["this-week", "last-week", "month", "year", "custom", "all"] as const;
export type PeriodKind = (typeof PERIODS)[number];

export type PeriodInput =
  | { period: "this-week" }
  | { period: "last-week" }
  | { period: "month"; year: number; month: number }
  | { period: "year"; year: number }
  | { period: "custom"; from: string; to: string }
  | { period: "all" };

/** An inclusive range of Asia/Dhaka calendar dates, `YYYY-MM-DD`. */
export type Period = { from: string; to: string };

export const ACTIVITY_TYPES = ["attendance", "interview", "training", "enrolment", "assignment", "evaluation", "leave"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActivityRow = {
  employeeId: string; employeeName: string; date: string;
  /** Attendance clock-in in Dhaka (`HH:mm`); empty for types without a time, which sort first. */
  time: string;
  type: ActivityType; title: string; details: string; status: string;
};

export const TIMELINE_HEADER = ["employee_id", "employee_name", "date", "type", "title", "details", "status"] as const;

/** Training as the timeline needs it (structurally the training store's entry). */
export type ActivityTraining = { name: string; provider: string; date: string; result: string; progress: number };

/** Everything recorded about one employee, as read from the stores. */
export type ActivitySources = {
  attendance: readonly TimesheetEntry[];
  interviews: readonly { company: string; role: string; date: string; stage: string; outcome: string; feedback: string; withdrawn: boolean }[];
  /** Stored completed training history (Story 3.1). */
  training: readonly ActivityTraining[];
  /** LMS enrolments: in progress and LMS-completed (Story 3.2), with the LMS freshness for this employee. */
  enrolments: { entries: readonly ActivityTraining[]; asOf?: string; stale: boolean };
  /** Tracked assignments (Story 4.5), open and closed. */
  assignments: readonly ActivityAssignment[];
  /** Self-reported past projects (Story 4.7), withdrawn ones included. */
  backfilledProjects: readonly ActivityBackfilledProject[];
  /** Evaluations of closed assignments (Story 4.6). */
  evaluations: readonly ActivityEvaluation[];
  /** Recorded leave periods (Stories 5.2-5.3), cancelled ones included. */
  leave: readonly ActivityLeave[];
};

/** The record fields the timeline needs (structurally the stores' records). */
export type ActivityAssignment = Pick<Assignment, "id" | "client" | "projectName" | "role" | "startDate" | "status" | "completionDate" | "provenance">;
export type ActivityBackfilledProject = Pick<BackfilledProject, "client" | "projectName" | "completionDate" | "outcome" | "status" | "provenance">;
export type ActivityEvaluation = Pick<AssignmentEvaluation,
  "assignmentId" | "evaluation" | "clientFeedback" | "createdBy" | "createdByName" | "createdByRole" | "createdAt"
  | "authoredBy" | "authoredByName" | "authoredByRole" | "updatedAt">;
export type ActivityLeave = Pick<LeaveRecord, "startDate" | "endDate" | "workingDays" | "cancelledAt">;

/** How the rows are built. `clientFeedback`: evaluation client feedback goes into `details` (Administrator or manager exporter only). */
export type TimelineOptions = { clientFeedback?: boolean };

/** The requested period is not a valid one (bad dates, end before start, or ending in the future). */
export class ActivityPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityPeriodError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromTime = (time: number) => new Date(time).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => fromTime(toTime(date) + days * DAY_MS);
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The last day of a month (1-12) of a year. */
function lastDayOf(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0); // day 0 of the next month; unlike Date.UTC, years 0-99 stay as given
  return date.getUTCDate();
}

const isYear = (year: number) => Number.isInteger(year) && year >= 1 && year <= 9999;

/**
 * The inclusive calendar dates of a period. `today` is the Asia/Dhaka date of the server clock.
 * Weeks run Monday to Sunday. `all` spans `span` (the employee's first to last record date), or
 * today to today when there are no records. Throws ActivityPeriodError for an invalid period.
 */
export function resolvePeriod(input: PeriodInput, today: string, span?: Period | null): Period {
  if (!isCalendarDate(today)) throw new ActivityPeriodError("Today's date could not be determined.");
  switch (input.period) {
    case "this-week":
    case "last-week": {
      const monday = addDays(today, -((new Date(toTime(today)).getUTCDay() + 6) % 7));
      const from = input.period === "this-week" ? monday : addDays(monday, -7);
      return { from, to: addDays(from, 6) };
    }
    case "month": {
      if (!isYear(input.year) || !Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
        throw new ActivityPeriodError("Choose a month and a year.");
      }
      const prefix = `${pad(input.year, 4)}-${pad(input.month)}`;
      return { from: `${prefix}-01`, to: `${prefix}-${pad(lastDayOf(input.year, input.month))}` };
    }
    case "year":
      if (!isYear(input.year)) throw new ActivityPeriodError("Choose a year.");
      return { from: `${pad(input.year, 4)}-01-01`, to: `${pad(input.year, 4)}-12-31` };
    case "custom":
      if (!isCalendarDate(input.from) || !isCalendarDate(input.to)) throw new ActivityPeriodError("Enter a valid start and end date.");
      if (input.to < input.from) throw new ActivityPeriodError("The end date cannot be before the start date.");
      if (input.to > today) throw new ActivityPeriodError("The end date cannot be in the future.");
      return { from: input.from, to: input.to };
    case "all":
      return span ?? { from: today, to: today };
  }
}

/** `HH:mm` in Asia/Dhaka (UTC+6, no daylight saving) for an ISO instant; empty when unparseable. */
function dhakaTime(instant: string): string {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return "";
  return new Date(time + DHAKA_OFFSET_MS).toISOString().slice(11, 16);
}

function attendanceRow(entry: TimesheetEntry, now: Date): Omit<ActivityRow, "employeeId" | "employeeName"> {
  const clockIn = dhakaTime(entry.clockIn) || "not recorded";
  const clockOut = (entry.clockOut && dhakaTime(entry.clockOut)) || "not recorded";
  const log = entry.log?.summary ? `; log: ${entry.log.summary}` : "";
  return {
    date: entry.date, time: dhakaTime(entry.clockIn), type: "attendance", title: "Attendance",
    details: `Clock in ${clockIn}, clock out ${clockOut}, break ${entry.breakMinutes} min, ${entry.workMode}${log}`,
    status: entryStatus(entry, now),
  };
}

/** The LMS sync time as a Dhaka `D MMM YYYY` date, or `Not recorded`. */
function lmsAsOf(asOf: string | undefined): string {
  const time = asOf === undefined ? NaN : Date.parse(asOf);
  return Number.isNaN(time) ? "Not recorded" : formatDisplayDate(dhakaDate(new Date(time)));
}

/** The Asia/Dhaka calendar date of an ISO instant; empty when unparseable. */
function dhakaDayOf(instant: string): string {
  const time = Date.parse(instant);
  return Number.isNaN(time) ? "" : dhakaDate(new Date(time));
}

/** Every date any source records for the employee (spanning records: both ends, an open assignment ending `today`). */
function recordDates(sources: ActivitySources, today: string): string[] {
  return [
    ...sources.attendance.map(e => e.date),
    ...sources.interviews.map(i => i.date),
    ...sources.training.map(t => t.date),
    ...sources.enrolments.entries.map(e => e.date),
    ...sources.assignments.flatMap(a => [a.startDate, a.completionDate ?? today]),
    ...sources.backfilledProjects.map(p => p.completionDate),
    ...sources.evaluations.map(e => dhakaDayOf(e.createdAt)),
    ...sources.leave.flatMap(l => [l.startDate, l.endDate]),
  ].filter(isCalendarDate);
}

/**
 * The employee's first to last record date (for "All time"), or null when nothing is recorded. `today` is
 * the Asia/Dhaka date of the server clock (the end of an open assignment).
 */
export function recordSpan(sources: ActivitySources, today: string): Period | null {
  const dates = recordDates(sources, today).sort();
  return dates.length === 0 ? null : { from: dates[0], to: dates[dates.length - 1] };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A row before the employee is added; `range` (inclusive) decides inclusion for records spanning days. */
type DraftRow = Omit<ActivityRow, "employeeId" | "employeeName"> & { range?: Period };

const inPeriod = (row: DraftRow, period: Period) => {
  if (!row.range) return isCalendarDate(row.date) && row.date >= period.from && row.date <= period.to;
  const { from, to } = row.range;
  return isCalendarDate(from) && isCalendarDate(to) && from <= period.to && to >= period.from;
};

function assignmentRow(a: ActivityAssignment, today: string): DraftRow {
  return {
    date: a.startDate, time: "", type: "assignment", title: `${a.projectName} — ${a.client}`,
    details: `Role: ${a.role}; start: ${a.startDate}; end: ${a.completionDate ?? "open"}; provenance: ${a.provenance}`,
    status: a.status === "closed" ? "Closed" : "Open",
    range: { from: a.startDate, to: a.completionDate ?? today },
  };
}

function backfilledRow(p: ActivityBackfilledProject): DraftRow {
  return {
    date: p.completionDate, time: "", type: "assignment", title: `${p.projectName} — ${p.client}`,
    details: `Self-reported past project; completed: ${p.completionDate}; outcome: ${p.outcome}; provenance: ${p.provenance}`,
    status: p.status === "withdrawn" ? "Withdrawn" : "Self-reported",
  };
}

function evaluationRow(e: ActivityEvaluation, assignments: readonly ActivityAssignment[], options: TimelineOptions): DraftRow {
  const assignment = assignments.find(a => a.id === e.assignmentId);
  const feedback = options.clientFeedback === true && e.clientFeedback.trim() ? `; client feedback: ${e.clientFeedback}` : "";
  return {
    date: dhakaDayOf(e.createdAt), time: "", type: "evaluation",
    title: assignment ? `Evaluation — ${assignment.projectName} (${assignment.client})` : "Evaluation",
    // The evaluator of the text as it stands: the latest author (the first one unless amended).
    details: `Evaluator: ${authorLabel(e.authoredByName, e.authoredByRole)}; outcome: ${e.evaluation}${feedback}`,
    status: isAmended(e) ? "Amended" : "Written",
  };
}

/** The length category's label (the only "type" leave has); "Leave" when the stored count is not a positive integer. */
function leaveCategoryLabel(workingDays: number): string {
  try {
    return categoryForWorkingDays(workingDays).label;
  } catch {
    return "Leave";
  }
}

function leaveRow(l: ActivityLeave): DraftRow {
  return {
    date: l.startDate, time: "", type: "leave", title: leaveCategoryLabel(l.workingDays),
    details: `From ${l.startDate} to ${l.endDate}; ${l.workingDays} working day${l.workingDays === 1 ? "" : "s"}`,
    status: l.cancelledAt ? "Cancelled" : "Recorded",
    range: { from: l.startDate, to: l.endDate },
  };
}

/**
 * The employee's timeline rows dated within the inclusive period, sorted by date, then time
 * (attendance clock-in; rows without a time first), then type, then title. Rows whose date is not
 * a calendar date (for example an enrolment without a target date) cannot be placed and are left out.
 * A tracked assignment (start to completion, or to today while open) and a leave period are included when
 * their range touches the period, and dated by their start. Evaluation client feedback is in `details` only
 * with `options.clientFeedback`.
 */
export function buildTimeline(
  employee: { id: string; name: string }, sources: ActivitySources, period: Period, now: Date, options: TimelineOptions = {},
): ActivityRow[] {
  const today = dhakaDate(now);
  const staleNote = sources.enrolments.stale ? `; LMS data as of ${lmsAsOf(sources.enrolments.asOf)} (may be out of date)` : "";
  const rows: DraftRow[] = [
    ...sources.attendance.map(entry => attendanceRow(entry, now)),
    ...sources.interviews.map(i => ({
      date: i.date, time: "", type: "interview" as const, title: `${i.company} — ${i.role}`,
      details: `Stage: ${i.stage}${i.feedback ? `; feedback: ${i.feedback}` : ""}`,
      status: i.withdrawn ? "Withdrawn" : i.outcome || "Reported",
    })),
    ...sources.training.map(t => ({
      date: t.date, time: "", type: "training" as const, title: t.name, details: `Provider: ${t.provider}`, status: t.result,
    })),
    ...sources.enrolments.entries.map(e => {
      const inProgress = e.result === "In progress";
      return {
        date: e.date, time: "", type: "enrolment" as const, title: e.name,
        details: `Provider: ${e.provider}${inProgress ? `, progress ${e.progress}%` : ""}${staleNote}`,
        status: inProgress ? "In progress" : e.result,
      };
    }),
    ...sources.assignments.map(a => assignmentRow(a, today)),
    ...sources.backfilledProjects.map(backfilledRow),
    ...sources.evaluations.map(e => evaluationRow(e, sources.assignments, options)),
    ...sources.leave.map(leaveRow),
  ];
  return rows
    .filter(row => isCalendarDate(row.date) && inPeriod(row, period))
    .map(({ range: _range, ...row }) => ({ employeeId: employee.id, employeeName: employee.name, ...row }))
    .sort((a, b) => compare(a.date, b.date) || compare(a.time, b.time) || compare(a.type, b.type) || compare(a.title, b.title));
}

/** UTF-8 BOM, the header row and one row per event; every field quoted and injection-guarded. */
export function timelineCsv(rows: readonly ActivityRow[]): string {
  const body = rows.map(r => [r.employeeId, r.employeeName, r.date, r.type, r.title, r.details, r.status].map(guardCell));
  return CSV_BOM + toCsv([[...TIMELINE_HEADER], ...body]);
}

/** `activity-<employeeId>-<from>_to_<to>.csv` (inclusive calendar dates). */
export function activityFilename(employeeId: string, period: Period): string {
  return `activity-${employeeId}-${period.from}_to_${period.to}.csv`;
}

/** `activity-all-employees-<from>_to_<to>.csv` for a bulk export (Story 8.2). */
export function activityBulkFilename(period: Period): string {
  return `activity-all-employees-${period.from}_to_${period.to}.csv`;
}
