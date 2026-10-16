"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  BACKFILL_OUTCOME_MAX, BACKFILL_TEXT_MAX, BackfillDepartmentError, BackfillForbiddenError, BackfillInvalidError,
  BackfillNoEmployeeError, BackfillUnavailableError, BackfillWithdrawnError, backfilledProjectStore, type BackfillInput,
} from "./backfilled-project-store";
import type { SessionIdentity } from "./session";

// Story 4.7: an employee adds, edits and withdraws their own past projects. The owner is always the
// session's employee (never a form value); a session without one is refused before anything is read.
// Only the owner can change an entry: the store refuses anyone else's, the Administrator's and managers'
// included, and a withdrawn one.
const NO_EMPLOYEE = "Only an employee can add their own past projects.";
const FORBIDDEN = "Only the employee who added this past project can change it.";
const WITHDRAWN = "This past project was withdrawn and can't be changed.";
const DEPARTMENT = "Choose a department from the list.";
const UNAVAILABLE = "Past projects are temporarily unavailable. Nothing was saved.";

/** Browsers submit textarea line breaks as CRLF; count them as one character, as the textarea's maxLength does. */
const lines = (value: string) => value.replace(/\r\n/g, "\n");

const id = z.string({ error: "Choose an existing past project." }).trim().uuid("Choose an existing past project.");
const departmentId = z.string({ error: DEPARTMENT }).trim().uuid(DEPARTMENT);
const text = (label: string, max: number) => z.string({ error: `Enter the ${label}.` }).transform(lines).transform(value => value.trim())
  .pipe(z.string().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} to ${max} characters or fewer.`));
const completionDate = z.string({ error: "Enter a valid completion date." }).trim()
  .refine(isCalendarDate, "Enter a valid completion date.");

const backfillForm = z.object({
  departmentId, client: text("client", BACKFILL_TEXT_MAX), projectName: text("project name", BACKFILL_TEXT_MAX), completionDate,
  outcome: text("outcome", BACKFILL_OUTCOME_MAX),
});

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
};

const fail = (error: string): ActionState => ({ error, message: "" });

/** A signed-in session with its own employee record; everyone else (signed out, an unlinked Administrator) is refused first. */
async function employeeSession(): Promise<SessionIdentity | null> {
  const session = await getSession();
  if (!session) return null;
  const employeeId = "employeeId" in session ? (session as { employeeId?: unknown }).employeeId : undefined;
  return typeof employeeId === "string" && employeeId !== "" ? session : null;
}

/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof BackfillNoEmployeeError) return fail(NO_EMPLOYEE);
  if (error instanceof BackfillForbiddenError) return fail(FORBIDDEN);
  if (error instanceof BackfillWithdrawnError) return fail(WITHDRAWN);
  if (error instanceof BackfillDepartmentError) return fail(DEPARTMENT);
  if (error instanceof BackfillInvalidError) return fail(error.message);
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof BackfillUnavailableError) {
    console.error("Backfilled projects unavailable.", error, { cause: error.cause });
    return fail(UNAVAILABLE);
  }
  throw error;
}

const firstIssue = (error: z.ZodError, fallback: string) => error.issues[0]?.message ?? fallback;

function parseInput(form: FormData): { input: BackfillInput } | { error: string } {
  const parsed = backfillForm.safeParse({
    departmentId: field(form, "departmentId"), client: field(form, "client"), projectName: field(form, "projectName"),
    completionDate: field(form, "completionDate"), outcome: field(form, "outcome"),
  });
  return parsed.success ? { input: parsed.data } : { error: firstIssue(parsed.error, "Check the past project's details.") };
}

/** The shared flow: session gate, zod, store, revalidate. */
async function run(form: FormData, message: string, work: (session: SessionIdentity) => Promise<unknown>): Promise<ActionState> {
  const session = await employeeSession();
  if (!session) return fail(NO_EMPLOYEE);
  try {
    await work(session);
  } catch (error) {
    if (error instanceof ParseError) return fail(error.message);
    // The page is stale (the entry was withdrawn elsewhere): refresh it so the controls disappear.
    if (error instanceof BackfillWithdrawnError) revalidatePath("/");
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message };
}

class ParseError extends Error {}

function inputOf(form: FormData): BackfillInput {
  const parsed = parseInput(form);
  if ("error" in parsed) throw new ParseError(parsed.error);
  return parsed.input;
}

function idOf(form: FormData): string {
  const parsed = id.safeParse(field(form, "id"));
  if (!parsed.success) throw new ParseError(firstIssue(parsed.error, "Choose an existing past project."));
  return parsed.data;
}

export async function addBackfillAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(form, "Past project added.", session => backfilledProjectStore.add(session, inputOf(form)));
}

export async function editBackfillAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(form, "Past project updated.", session => {
    const target = idOf(form);
    return backfilledProjectStore.edit(session, target, inputOf(form));
  });
}

export async function withdrawBackfillAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(form, "Past project withdrawn.", session => backfilledProjectStore.withdraw(session, idOf(form)));
}
