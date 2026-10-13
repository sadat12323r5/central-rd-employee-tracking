import { z } from "zod";
import {
  activityFilename, ActivityPeriodError, buildTimeline, PERIODS, recordSpan, resolvePeriod, timelineCsv,
  type ActivitySources, type PeriodInput,
} from "@/domain/activity";
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

export type ActivityExportDeps = {
  employees: Pick<EmployeesStore, "getFor">;
  attendance: Pick<AttendanceStore, "listForEmployee">;
  interviews: Pick<InterviewsStore, "listFor">;
  training: Pick<TrainingStore, "listFor" | "currentFor">;
  audit: Pick<AuditStore, "recordActivityExport">;
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

function parseInput(input: ActivityExportInput): { employeeId: string; period: PeriodInput } {
  // The employee is checked first, then the period, so the message names the first thing to fix.
  const employee = baseForm.shape.employeeId.safeParse(input.employeeId);
  if (!employee.success) throw new ActivityValidationError(UNKNOWN_EMPLOYEE);
  const kind = baseForm.shape.period.safeParse(input.period);
  if (!kind.success) throw new ActivityValidationError("Choose a period.");
  const fields = periodForms[kind.data].safeParse(input);
  if (!fields.success) {
    const fallback = kind.data === "custom" ? "Enter a valid start and end date." : kind.data === "month" ? "Choose a month and a year." : "Choose a year.";
    throw new ActivityValidationError(messageOf(fields.error, fallback));
  }
  return { employeeId: employee.data, period: { period: kind.data, ...fields.data } as PeriodInput };
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
  let period;
  try {
    period = periodInput.period === "all" ? undefined : resolvePeriod(periodInput, today);
  } catch (error) {
    if (error instanceof ActivityPeriodError) throw new ActivityValidationError(error.message);
    throw error;
  }

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

/** The inline message for an export failure; anything unexpected reads as "unavailable". */
export function activityErrorMessage(error: unknown): string {
  if (error instanceof ActivityForbiddenError || error instanceof ActivityValidationError || error instanceof ActivityEmployeeNotFoundError) {
    return error.message;
  }
  return UNAVAILABLE;
}
