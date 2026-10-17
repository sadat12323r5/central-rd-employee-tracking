"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatDisplayDate, isCalendarDate } from "@/domain/dates";
import { EMPLOYEE_ID_PATTERN } from "@/domain/employee-input";
import { categoryForWorkingDays } from "@/domain/leave";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  LeaveCalendarMissingError, LeaveEmployeeNotFoundError, LeaveForbiddenError, LeaveOverlapError, leaveStore, LeaveUnavailableError,
  LeaveValidationFailedError,
} from "./leave-store";

// Story 5.2: record a leave period. The session is read first; the form is validated with zod before
// leave-store, which re-checks who may record whose leave (and RLS checks it again), counts the working days
// against the active holiday calendar and refuses overlaps. For a Staff session the employee is always the
// session's own: a form naming anyone else is refused before any store call. Administrators and managers
// name the employee in the form (their own in "My record", where a manager's own record follows the Staff rule).

const SIGN_IN = "Your session has ended. Sign in again to record leave.";
const OWN_ONLY = "You can only record your own leave.";
const FORBIDDEN = "You can only record leave for employees in your department.";
const INVALID_DATE = "Enter real dates for the start and end of the leave.";
const REVERSED = "The end date must be on or after the start date.";
const ZERO_DAYS = "This period has no working days (only weekends and holidays).";
const NO_CALENDAR = "No holiday calendar is loaded yet. Ask the Administrator to load it.";
const NOT_FOUND = "No employee has this Employee ID.";
const UNAVAILABLE = "Leave is temporarily unavailable. Nothing was saved.";

const employeeId = z.string({ error: "Choose an employee." }).trim()
  .regex(EMPLOYEE_ID_PATTERN, "Choose an employee by Employee ID, like BS-1234.");
const date = z.string({ error: INVALID_DATE }).trim().refine(isCalendarDate, INVALID_DATE);
const period = z.object({ startDate: date, endDate: date })
  .refine(p => p.startDate <= p.endDate, REVERSED);

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

const failure = (error: string): ActionState => ({ error, message: "" });

/** A Staff form that names any employee other than the session's own is refused outright. */
function namesSomeoneElse(form: FormData, own: string): boolean {
  return ["employeeId", "employee_id"].some(name => form.has(name) && (field(form, name) ?? "").trim() !== own);
}

const yearsText = (start: number, end: number) => (start === end ? `${start}` : `${start}–${end}`);
const daysText = (days: number) => `${days} working ${days === 1 ? "day" : "days"}`;

/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof LeaveForbiddenError) return failure(FORBIDDEN);
  if (error instanceof LeaveOverlapError) {
    return failure(`This overlaps leave already recorded from ${formatDisplayDate(error.existing.startDate)} to ${formatDisplayDate(error.existing.endDate)}.`);
  }
  if (error instanceof LeaveCalendarMissingError) return failure(NO_CALENDAR);
  if (error instanceof LeaveEmployeeNotFoundError) return failure(NOT_FOUND);
  if (error instanceof LeaveValidationFailedError) {
    switch (error.code) {
      case "INVALID_DATE": return failure(INVALID_DATE);
      case "REVERSED_RANGE": return failure(REVERSED);
      case "ZERO_WORKING_DAYS": return failure(ZERO_DAYS);
      case "UNSUPPORTED_YEAR": {
        if (error.supportedYearStart === null || error.supportedYearEnd === null) return failure("The holiday calendar does not cover these dates yet.");
        const covers = yearsText(error.supportedYearStart, error.supportedYearEnd);
        const only = error.supportedYearStart === error.supportedYearEnd ? " only" : "";
        const year = error.year === null ? "these dates" : `leave in ${error.year}`;
        return failure(`The holiday calendar covers ${covers}${only}, so ${year} can't be counted yet.`);
      }
    }
  }
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof LeaveUnavailableError) {
    console.error("Leave unavailable.", error, { cause: error.cause });
    return failure(UNAVAILABLE);
  }
  throw error;
}

/** Records a leave period: Staff for their own record; the Administrator or a manager for the form's employee. */
export async function recordLeaveAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session) return failure(SIGN_IN);

  let subject: string;
  if (session.role === "staff") {
    if (namesSomeoneElse(form, session.employeeId)) return failure(OWN_ONLY);
    subject = session.employeeId;
  } else {
    const parsedId = employeeId.safeParse(field(form, "employeeId"));
    if (!parsedId.success) return failure(parsedId.error.issues[0]?.message ?? "Choose an employee.");
    subject = parsedId.data;
  }

  const parsed = period.safeParse({ startDate: field(form, "startDate"), endDate: field(form, "endDate") });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? INVALID_DATE);

  let saved;
  try {
    saved = await leaveStore.record(session, subject, parsed.data);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: `Leave recorded: ${daysText(saved.workingDays)} (${categoryForWorkingDays(saved.workingDays).label}).` };
}
