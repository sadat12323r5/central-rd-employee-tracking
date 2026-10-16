"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  ASSIGNMENT_NOTE_MAX, ASSIGNMENT_TEXT_MAX, AssignmentAlreadyOpenError, AssignmentClosedError, AssignmentEmployeeNotFoundError,
  AssignmentInvalidError, AssignmentNoDepartmentError, AssignmentsForbiddenError, assignmentsStore, AssignmentsUnavailableError,
} from "./assignments-store";

// Story 4.5: the Administrator, or a manager over the employee's department, creates an assignment,
// edits its latest-update note while it is open, and closes it with a completion date. Staff are refused
// before anything is read. The department is never part of a form (assignments-store copies the
// employee's own), and a note edit or close names only the assignment: its employee comes from the row.
const FORBIDDEN = "Only the Administrator or a manager over this employee's department can manage assignments.";
const ALREADY_OPEN = "This employee already has an open assignment. Close it first.";
const CLOSED = "This assignment is closed and can't be changed.";
const NO_DEPARTMENT = "Place this employee in a department first.";
const NOT_FOUND = "Choose an existing employee.";
const UNAVAILABLE = "Assignments are temporarily unavailable. Nothing was saved.";

const text = (label: string) => z.string({ error: `Enter the ${label}.` }).trim()
  .pipe(z.string().min(1, `Enter the ${label}.`).max(ASSIGNMENT_TEXT_MAX, `Keep the ${label} to ${ASSIGNMENT_TEXT_MAX} characters or fewer.`));

const calendarDate = (label: string) => z.string({ error: `Enter the ${label}.` }).trim()
  .pipe(z.string().min(1, `Enter the ${label}.`).refine(isCalendarDate, `Enter a valid ${label}.`));

const ALLOCATION = "Enter the allocation as a whole number from 0 to 100.";
const allocation = z.string({ error: ALLOCATION }).trim()
  .pipe(z.string().regex(/^\d{1,3}$/, ALLOCATION))
  .transform(Number)
  .pipe(z.number().int(ALLOCATION).min(0, ALLOCATION).max(100, ALLOCATION));

const employeeId = z.string({ error: NOT_FOUND }).trim().regex(/^BS-\d{4}$/, NOT_FOUND);
const assignmentId = z.string({ error: "Choose an existing assignment." }).trim().uuid("Choose an existing assignment.");

const newAssignment = z.object({
  employeeId, client: text("client"), projectName: text("project name"), role: text("role"), allocation, startDate: calendarDate("start date"),
});
const noteChange = z.object({
  id: assignmentId,
  note: z.string({ error: "Enter the latest update." }).transform(value => value.trim())
    .pipe(z.string().max(ASSIGNMENT_NOTE_MAX, `Keep the latest update to ${ASSIGNMENT_NOTE_MAX} characters or fewer.`)),
});
const closing = z.object({ id: assignmentId, completionDate: calendarDate("completion date") });

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
};

const fail = (error: string): ActionState => ({ error, message: "" });

/** Admin and manager sessions only; everyone else (Staff, signed out) is refused before anything else. */
async function managingSession() {
  const session = await getSession();
  return session?.role === "admin" || session?.role === "manager" ? session : null;
}

/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof AssignmentsForbiddenError) return fail(FORBIDDEN);
  if (error instanceof AssignmentAlreadyOpenError) return fail(ALREADY_OPEN);
  if (error instanceof AssignmentClosedError) return fail(CLOSED);
  if (error instanceof AssignmentNoDepartmentError) return fail(NO_DEPARTMENT);
  if (error instanceof AssignmentEmployeeNotFoundError) return fail(NOT_FOUND);
  if (error instanceof AssignmentInvalidError) return fail(error.message);
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof AssignmentsUnavailableError) {
    console.error("Assignments unavailable.", error, { cause: error.cause });
    return fail(UNAVAILABLE);
  }
  throw error;
}

const firstIssue = (error: z.ZodError, fallback: string) => error.issues[0]?.message ?? fallback;

export async function createAssignmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await managingSession();
  if (!session) return fail(FORBIDDEN);

  const parsed = newAssignment.safeParse({
    employeeId: field(form, "employeeId"), client: field(form, "client"), projectName: field(form, "projectName"),
    role: field(form, "role"), allocation: field(form, "allocation"), startDate: field(form, "startDate"),
  });
  if (!parsed.success) return fail(firstIssue(parsed.error, "Check the assignment details."));

  const { employeeId: subject, ...input } = parsed.data;
  try {
    await assignmentsStore.create(session, subject, input);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Assignment created." };
}

export async function updateAssignmentNoteAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await managingSession();
  if (!session) return fail(FORBIDDEN);

  const parsed = noteChange.safeParse({ id: field(form, "id"), note: field(form, "note") });
  if (!parsed.success) return fail(firstIssue(parsed.error, "Check the latest update."));

  try {
    await assignmentsStore.updateNote(session, parsed.data.id, parsed.data.note);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Latest update saved." };
}

export async function closeAssignmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await managingSession();
  if (!session) return fail(FORBIDDEN);

  const parsed = closing.safeParse({ id: field(form, "id"), completionDate: field(form, "completionDate") });
  if (!parsed.success) return fail(firstIssue(parsed.error, "Check the completion date."));

  try {
    await assignmentsStore.close(session, parsed.data.id, parsed.data.completionDate);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Assignment closed." };
}
