import { z } from "zod";
import {
  activityBulkFilename, activityFilename, ActivityPeriodError, buildTimeline, PERIODS, recordSpan, resolvePeriod, timelineCsv,
  type ActivityRow, type ActivitySources, type Period, type PeriodInput,
} from "@/domain/activity";
import type { Employee } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";
import { dhakaDate } from "@/domain/timesheet";
import { AttendanceUnavailableError, type AttendanceStore } from "./attendance-store";
import { AuditEmployeeNotFoundError, AuditUnavailableError, AuditValidationError, type AuditStore } from "./audit-store";
import { EmployeesUnavailableError, type EmployeesStore } from "./employees-store";
import { InterviewsUnavailableError, type InterviewsStore } from "./interviews-store";
import type { SessionIdentity } from "./session";
import { TrainingUnavailableError, type TrainingStore } from "./training-store";

// One employee's activity timeline export (Story 8.1). Not a "use server" module: activity-actions.ts
// checks the Administrator session and delegates here with the real stores. Every source is read only
// through its store, with the Administrator's session; the CSV is all or nothing: any unavailable source
// (or LMS) fails the whole export. The audit row is written after every read and before the CSV is
// returned, so an export that is handed out is always audited, and a failed audit hands out nothing.
//
// Story 8.2 adds the bulk export (exportAllActivity): the same pipeline for every employee, each source
// read once for the whole export (paged by the stores), one audit row for the whole file.

export type ActivityExportDeps = {
  employees: Pick<EmployeesStore, "getFor">;
  attendance: Pick<AttendanceStore, "listForEmployee">;
  interviews: Pick<InterviewsStore, "listFor">;
  training: Pick<TrainingStore, "listFor" | "currentFor">;
  audit: Pick<AuditStore, "recordActivityExport">;
};

export type BulkActivityExportDeps = {
  /** Every employee, with their stored interviews and training (one read of each for everyone). */
  employees: Pick<EmployeesStore, "listFor">;
  attendance: Pick<AttendanceStore, "listAll">;
  training: Pick<TrainingStore, "currentFor">;
  audit: Pick<AuditStore, "recordBulkActivityExport">;
};

export type ActivityExport = { csv: string; filename: string; from: string; to: string };

export const NOT_ADMIN = "Only an Administrator can export activity.";
export const UNKNOWN_EMPLOYEE = "Choose an existing employee.";
export const UNAVAILABLE = "Activity could not be exported because a record source is unavailable. Nothing was downloaded. Please try again.";

/** Only an Administrator session may export. */
export class ActivityForbiddenError extends Error {
  constructor() {
    super(NOT_ADMIN);
    this.name = "ActivityForbiddenError";
  }
}

/** The form failed validation; `message` is safe to show inline. */
export class ActivityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityValidationError";
  }
}

/** No employee with that id (or not visible to the session). */
export class ActivityEmployeeNotFoundError extends Error {
  constructor() {
    super(UNKNOWN_EMPLOYEE);
    this.name = "ActivityEmployeeNotFoundError";
  }
}

/** A record source, the LMS or the audit log could not be reached. Nothing was exported. */
export class ActivityUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(UNAVAILABLE, options);
    this.name = "ActivityUnavailableError";
  }
}

const text = z.string().trim();
const year = text.regex(/^\d{4}$/, "Choose a year.").transform(Number);
const calendarDate = (message: string) => text.refine(isCalendarDate, message);

const baseForm = z.object({
  employeeId: text.regex(/^BS-\d{4}$/, UNKNOWN_EMPLOYEE),
  period: z.enum(PERIODS, "Choose a period."),
});

const periodForms = {
  "this-week": z.object({}),
  "last-week": z.object({}),
  month: z.object({ month: text.regex(/^(0?[1-9]|1[0-2])$/, "Choose a month and a year.").transform(Number), year }),
  year: z.object({ year }),
  custom: z.object({ from: calendarDate("Enter a valid start date."), to: calendarDate("Enter a valid end date.") }),
  all: z.object({}),
} satisfies Record<(typeof PERIODS)[number], z.ZodType>;

/** The raw form values: every field is a string when present. */
export type ActivityExportInput = Partial<Record<"employeeId" | "period" | "month" | "year" | "from" | "to", unknown>>;

/** The first issue's message when it is one of ours; zod's generic ones (e.g. a missing field) become `fallback`. */
function messageOf(error: z.ZodError, fallback: string): string {
  const message = error.issues[0]?.message;
  return message && !message.startsWith("Invalid") ? message : fallback;
}

/** The period fields of the form (shared by the single and the bulk export). */
function parsePeriodInput(input: Partial<Record<"period" | "month" | "year" | "from" | "to", unknown>>): PeriodInput {
  const kind = baseForm.shape.period.safeParse(input.period);
  if (!kind.success) throw new ActivityValidationError("Choose a period.");
  const fields = periodForms[kind.data].safeParse(input);
  if (!fields.success) {
    const fallback = kind.data === "custom" ? "Enter a valid start and end date." : kind.data === "month" ? "Choose a month and a year." : "Choose a year.";
    throw new ActivityValidationError(messageOf(fields.error, fallback));
  }
  return { period: kind.data, ...fields.data } as PeriodInput;
}

function parseInput(input: ActivityExportInput): { employeeId: string; period: PeriodInput } {
  // The employee is checked first, then the period, so the message names the first thing to fix.
  const employee = baseForm.shape.employeeId.safeParse(input.employeeId);
  if (!employee.success) throw new ActivityValidationError(UNKNOWN_EMPLOYEE);
  return { employeeId: employee.data, period: parsePeriodInput(input) };
}

/** The raw bulk form values: the period fields, plus the "Include archived" checkbox (`on` when ticked). */
export type BulkActivityExportInput = Partial<Record<"period" | "month" | "year" | "from" | "to" | "includeArchived", unknown>>;

const INCLUDE_ARCHIVED = "Choose whether to include archived employees.";
const includeArchivedField = z.union([z.literal("on"), z.literal(""), z.null(), z.undefined()], INCLUDE_ARCHIVED);

function parseBulkInput(input: BulkActivityExportInput): { includeArchived: boolean; period: PeriodInput } {
  const period = parsePeriodInput(input);
  const includeArchived = includeArchivedField.safeParse(input.includeArchived);
  if (!includeArchived.success) throw new ActivityValidationError(INCLUDE_ARCHIVED);
  return { includeArchived: includeArchived.data === "on", period };
}

/** A fixed period resolved before any read (so it is validated first); `undefined` for "all". */
function fixedPeriod(input: PeriodInput, today: string): Period | undefined {
  try {
    return input.period === "all" ? undefined : resolvePeriod(input, today);
  } catch (error) {
    if (error instanceof ActivityPeriodError) throw new ActivityValidationError(error.message);
    throw error;
  }
}

const UNAVAILABLE_ERRORS = [
  AttendanceUnavailableError, InterviewsUnavailableError, TrainingUnavailableError, EmployeesUnavailableError, AuditUnavailableError,
];
const isUnavailable = (error: unknown) => UNAVAILABLE_ERRORS.some(type => error instanceof type);

/**
 * Exports one employee's activity timeline for the requested period. `actorId` is the Administrator's
 * auth user id (the audit actor); `now` is the server clock ("today" is its Asia/Dhaka date).
 * Throws ActivityForbiddenError, ActivityValidationError, ActivityEmployeeNotFoundError or
 * ActivityUnavailableError; on any of them nothing is returned and no audit row exists.
 */
export async function exportActivity(
  deps: ActivityExportDeps, session: SessionIdentity, actorId: string, input: ActivityExportInput, now: Date,
): Promise<ActivityExport> {
  if (session.role !== "admin") throw new ActivityForbiddenError();
  const { employeeId, period: periodInput } = parseInput(input);
  const today = dhakaDate(now);

  // Validate the period before any read ("all" is resolved once the records are known).
  const period = fixedPeriod(periodInput, today);

  try {
    const employee = await deps.employees.getFor(session, employeeId);
    if (!employee) throw new ActivityEmployeeNotFoundError();

    const [attendance, interviews, training, current] = await Promise.all([
      deps.attendance.listForEmployee(employeeId),
      deps.interviews.listFor(session, employeeId),
      deps.training.listFor(session, employeeId),
      deps.training.currentFor(session, [employeeId]),
    ]);
    if (current.status !== "ok") throw new ActivityUnavailableError({ cause: "LMS unavailable" });

    const freshness = current.freshness[employeeId];
    const sources: ActivitySources = {
      attendance: attendance.filter(e => e.employeeId === employeeId),
      interviews: interviews.filter(i => i.employeeId === employeeId),
      training: training.filter(t => t.employeeId === employeeId),
      enrolments: {
        entries: [...current.inProgress, ...current.lmsCompleted].filter(e => e.employeeId === employeeId),
        asOf: freshness?.asOf ?? current.asOf,
        stale: freshness?.stale ?? current.stale,
      },
    };
    const resolved = period ?? resolvePeriod(periodInput, today, recordSpan(sources));
    const csv = timelineCsv(buildTimeline({ id: employee.id, name: employee.name }, sources, resolved, now));

    await deps.audit.recordActivityExport({ actorId, employeeId, from: resolved.from, to: resolved.to });
    return { csv, filename: activityFilename(employeeId, resolved), ...resolved };
  } catch (error) {
    if (error instanceof AuditEmployeeNotFoundError) throw new ActivityEmployeeNotFoundError();
    if (isUnavailable(error) || error instanceof AuditValidationError) throw new ActivityUnavailableError({ cause: error });
    throw error;
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The earliest start and latest end of the spans (for "All time" across employees), or null when none. */
function combinedSpan(spans: (Period | null)[]): Period | null {
  const known = spans.filter((span): span is Period => span !== null);
  if (known.length === 0) return null;
  return {
    from: known.map(s => s.from).reduce((a, b) => (b < a ? b : a)),
    to: known.map(s => s.to).reduce((a, b) => (b > a ? b : a)),
  };
}

/**
 * Exports every employee's activity timeline for the requested period as one CSV (Story 8.2): rows are
 * sorted by employee id, then within an employee exactly as the single export. Archived employees (and
 * all their rows) are left out unless `includeArchived` is `on`. Each source is read once for the whole
 * export: employees with their stored interviews and training, all attendance, and the LMS enrolments of
 * the included employees. "All time" spans the first to the last record date across the included
 * employees. One audit row (target `all-employees` or `all-employees+archived`) is written after every
 * read. Throws ActivityForbiddenError, ActivityValidationError or ActivityUnavailableError; on any of
 * them nothing is returned and no audit row exists.
 */
export async function exportAllActivity(
  deps: BulkActivityExportDeps, session: SessionIdentity, actorId: string, input: BulkActivityExportInput, now: Date,
): Promise<ActivityExport> {
  if (session.role !== "admin") throw new ActivityForbiddenError();
  const { includeArchived, period: periodInput } = parseBulkInput(input);
  const today = dhakaDate(now);
  const period = fixedPeriod(periodInput, today);

  const inScope = (list: Employee[]) => list
    .filter(e => includeArchived || e.archived !== true)
    .sort((a, b) => compare(a.id, b.id));

  try {
    // All or nothing: every read must succeed. The LMS is asked only about the included employees.
    const employeesRead = deps.employees.listFor(session);
    const [list, attendance, current] = await Promise.all([
      employeesRead,
      deps.attendance.listAll(),
      employeesRead.then(all => deps.training.currentFor(session, inScope(all).map(e => e.id))),
    ]);
    if (current.status !== "ok") throw new ActivityUnavailableError({ cause: "LMS unavailable" });

    const included = inScope(list);
    const attendanceOf = new Map<string, typeof attendance>();
    for (const entry of attendance) {
      const own = attendanceOf.get(entry.employeeId);
      if (own) own.push(entry);
      else attendanceOf.set(entry.employeeId, [entry]);
    }
    const enrolments = [...current.inProgress, ...current.lmsCompleted];

    const employees = included.map(employee => {
      const freshness = current.freshness[employee.id];
      const sources: ActivitySources = {
        attendance: attendanceOf.get(employee.id) ?? [],
        interviews: employee.interviews,
        training: employee.training,
        enrolments: {
          entries: enrolments.filter(e => e.employeeId === employee.id),
          asOf: freshness?.asOf ?? current.asOf,
          stale: freshness?.stale ?? current.stale,
        },
      };
      return { employee, sources };
    });

    const resolved = period ?? resolvePeriod(periodInput, today, combinedSpan(employees.map(e => recordSpan(e.sources))));
    const rows: ActivityRow[] = employees.flatMap(({ employee, sources }) =>
      buildTimeline({ id: employee.id, name: employee.name }, sources, resolved, now));
    const csv = timelineCsv(rows);

    await deps.audit.recordBulkActivityExport({ actorId, includeArchived, from: resolved.from, to: resolved.to });
    return { csv, filename: activityBulkFilename(resolved), ...resolved };
  } catch (error) {
    if (isUnavailable(error) || error instanceof AuditValidationError || error instanceof AuditEmployeeNotFoundError) {
      throw new ActivityUnavailableError({ cause: error });
    }
    throw error;
  }
}

/** The inline message for an export failure; anything unexpected reads as "unavailable". */
export function activityErrorMessage(error: unknown): string {
  if (error instanceof ActivityForbiddenError || error instanceof ActivityValidationError || error instanceof ActivityEmployeeNotFoundError) {
    return error.message;
  }
  return UNAVAILABLE;
}
