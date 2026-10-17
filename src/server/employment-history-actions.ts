"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DETAIL_MAX, EMPLOYER_MAX, hasPeriodYear, normalizeLineBreaks, PERIOD_MAX, ROLE_MAX, type EmploymentHistoryField } from "@/domain/employment-history";
import { EMPLOYEE_ID_PATTERN, normalizeText } from "@/domain/employee-input";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  EmploymentHistoryForbiddenError, EmploymentHistoryInvalidError, EmploymentHistoryNotFoundError, EmploymentHistoryRemovedError,
  employmentHistoryStore, EmploymentHistoryUnavailableError,
} from "./employment-history-store";

// Story 7.3: add, edit and remove employment history entries. The session is read first; the form is
// validated with zod (messages name the field) before employment-history-store, which re-checks who may
// change whose history (and RLS checks it again). For a Staff session the employee is always the
// session's own: a form naming anyone else is refused before any store call. For edit and remove the
// subject employee comes from the target entry, never from the form. Nothing is ever deleted.

const SIGN_IN = "Your session has ended. Sign in again to change employment history.";
const OWN_ONLY = "You can only change your own employment history.";
const FORBIDDEN = "You can only change employment history for yourself or for employees in your department.";
const NOT_FOUND = "That employment entry was not found.";
const REMOVED = "That entry was removed and can no longer be changed.";
const UNAVAILABLE = "Employment history could not be reached, so nothing was saved. Please try again in a moment.";

const FIELD_MESSAGES: Record<EmploymentHistoryField | "entry", string> = {
  role: `Enter the role (up to ${ROLE_MAX} characters).`,
  employer: `Enter the employer (up to ${EMPLOYER_MAX} characters).`,
  period: `Enter the period (up to ${PERIOD_MAX} characters) with a four-digit year, like 2021 – 2023.`,
  detail: `Keep the detail to ${DETAIL_MAX} characters or fewer.`,
  entry: "Check the employment entry: the role, employer and period are required, and the period needs a year.",
};

/** A required free-text field: trimmed, inner whitespace collapsed, 1–max characters. */
const text = (label: string, max: number) => z.string({ error: `Enter the ${label}.` })
  .transform(normalizeText)
  .pipe(z.string().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} to ${max} characters or fewer.`));

// Lengths and the year rule match the employment_history check constraints.
const entryFields = {
  role: text("role", ROLE_MAX),
  employer: text("employer", EMPLOYER_MAX),
  period: text("period", PERIOD_MAX)
    .refine(hasPeriodYear, "Include a four-digit year in the period, like 2021 – 2023 or Mar 2023 – Present."),
  detail: z.string().transform(normalizeLineBreaks).pipe(z.string().trim().max(DETAIL_MAX, `Keep the detail to ${DETAIL_MAX} characters or fewer.`)).default(""),
};

const employeeId = z.string({ error: "Choose an employee." }).trim()
  .regex(EMPLOYEE_ID_PATTERN, "Choose an employee by Employee ID, like BS-1234.");
const entryId = z.string({ error: "Choose an employment entry." }).trim().uuid("Choose a valid employment entry.");

const newEntry = z.object(entryFields);
const changedEntry = z.object({ id: entryId, ...entryFields });

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

const failure = (error: string): ActionState => ({ error, message: "" });

/** A Staff form that names any employee other than the session's own is refused outright. */
function namesSomeoneElse(form: FormData, own: string): boolean {
  return ["employeeId", "employee_id"].some(name => form.has(name) && (field(form, name) ?? "").trim() !== own);
}

const entryOf = (form: FormData) => ({
  role: field(form, "role"), employer: field(form, "employer"), period: field(form, "period"), detail: field(form, "detail"),
});

/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof EmploymentHistoryForbiddenError) return failure(FORBIDDEN);
  if (error instanceof EmploymentHistoryNotFoundError) return failure(NOT_FOUND);
  if (error instanceof EmploymentHistoryRemovedError) return failure(REMOVED);
  if (error instanceof EmploymentHistoryInvalidError) return failure(FIELD_MESSAGES[error.fields[0] ?? "entry"]);
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof EmploymentHistoryUnavailableError) {
    console.error("Employment history unavailable.", error, { cause: error.cause });
    return failure(UNAVAILABLE);
  }
  throw error;
}

/** Adds an entry: Staff for their own record; the Administrator or a manager for the form's employee. */
export async function addEmploymentHistoryAction(_previous: ActionState, form: FormData): Promise<ActionState> {
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

  const parsed = newEntry.safeParse(entryOf(form));
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? FIELD_MESSAGES.entry);

  try {
    await employmentHistoryStore.add(session, subject, parsed.data);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Employment entry added." };
}

/** Saves the role, employer, period and detail of an active entry. The employee comes from the entry. */
export async function updateEmploymentHistoryAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session) return failure(SIGN_IN);
  if (session.role === "staff" && namesSomeoneElse(form, session.employeeId)) return failure(OWN_ONLY);

  const parsed = changedEntry.safeParse({ id: field(form, "id"), ...entryOf(form) });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? FIELD_MESSAGES.entry);

  const { id, ...entry } = parsed.data;
  try {
    await employmentHistoryStore.update(session, id, entry);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Employment entry saved." };
}

/** Removes an active entry (sets removed_at). The row is kept in the record's history. */
export async function removeEmploymentHistoryAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session) return failure(SIGN_IN);
  if (session.role === "staff" && namesSomeoneElse(form, session.employeeId)) return failure(OWN_ONLY);

  const parsed = entryId.safeParse(field(form, "id"));
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Choose a valid employment entry.");

  try {
    await employmentHistoryStore.remove(session, parsed.data);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Employment entry removed. It is kept in the record's history." };
}
