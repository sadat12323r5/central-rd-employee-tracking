"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  interviewsStore, InterviewLockedError, InterviewNotFoundError, InterviewsForbiddenError, InterviewsUnavailableError,
  InterviewWithdrawnError,
} from "./interviews-store";

const SIGN_IN = "Your session has ended. Sign in again as a staff member to add an interview.";
const SIGN_IN_CHANGE = "Your session has ended. Sign in again as a staff member to change an interview.";
const UNAVAILABLE = "External interviews could not be reached, so nothing was saved. Please try again in a moment.";
const NOT_FOUND = "That interview was not found, or it is not yours, so nothing was saved.";
const WITHDRAWN = "That interview has already been withdrawn and can no longer be changed.";
const LOCKED = "Company, role and date can't be changed after an interview is added. Withdraw it and add a corrected entry instead.";
/** Form fields that are locked after creation: their mere presence rejects an update. */
const LOCKED_FIELDS = ["company", "role", "date", "interview_date", "employeeId", "employee_id"];

const text = (label: string, max: number) =>
  z.string({ error: `Enter the ${label}.` }).trim().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} to ${max} characters or fewer.`);

// Lengths match the external_interviews check constraints. The form's employeeId (if any) is not part
// of the schema: the employee always comes from the signed-in session.
const newInterview = z.object({
  company: text("company", 200),
  role: text("role", 200),
  date: z.string({ error: "Enter the interview date." }).trim()
    .refine(isCalendarDate, "Enter the interview date as a real date (YYYY-MM-DD)."),
  stage: text("stage", 200),
  outcome: z.string().trim().max(200, "Keep the outcome to 200 characters or fewer.").default(""),
});

const interviewId = z.string({ error: "Choose an interview." }).trim().uuid("Choose a valid interview.");

// Story 2.2: only stage (required), outcome and feedback are editable. Lengths match the table checks.
const interviewChanges = z.object({
  id: interviewId,
  stage: text("stage", 200),
  outcome: z.string().trim().max(200, "Keep the outcome to 200 characters or fewer.").default(""),
  feedback: z.string().trim().max(2000, "Keep the feedback to 2000 characters or fewer.").default(""),
});

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

export async function addInterviewAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "staff") return { error: SIGN_IN, message: "" };

  const parsed = newInterview.safeParse({
    company: field(form, "company"), role: field(form, "role"), date: field(form, "date"),
    stage: field(form, "stage"), outcome: field(form, "outcome"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the interview details.", message: "" };

  try {
    await interviewsStore.add(session, parsed.data);
  } catch (error) {
    if (error instanceof InterviewsForbiddenError) return { error: SIGN_IN, message: "" };
    // Never report success when the database could not be reached or refused the write.
    if (error instanceof InterviewsUnavailableError) {
      console.error("External interviews unavailable.", error, { cause: error.cause });
      return { error: UNAVAILABLE, message: "" };
    }
    throw error;
  }
  revalidatePath("/");
  return { error: "", message: "Interview added." };
}


/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof InterviewsForbiddenError) return { error: SIGN_IN_CHANGE, message: "" };
  if (error instanceof InterviewNotFoundError) return { error: NOT_FOUND, message: "" };
  if (error instanceof InterviewWithdrawnError) return { error: WITHDRAWN, message: "" };
  if (error instanceof InterviewLockedError) return { error: LOCKED, message: "" };
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof InterviewsUnavailableError) {
    console.error("External interviews unavailable.", error, { cause: error.cause });
    return { error: UNAVAILABLE, message: "" };
  }
  throw error;
}

/** Story 2.2: the author changes the stage, outcome or feedback of their own, not-withdrawn interview. */
export async function updateInterviewAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "staff") return { error: SIGN_IN_CHANGE, message: "" };
  // Locked fields are never accepted, not even unchanged: reject before validation or any store call.
  if (LOCKED_FIELDS.some(name => form.has(name))) return { error: LOCKED, message: "" };

  const parsed = interviewChanges.safeParse({
    id: field(form, "id"), stage: field(form, "stage"), outcome: field(form, "outcome"), feedback: field(form, "feedback"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the interview details.", message: "" };

  const { id, ...changes } = parsed.data;
  try {
    await interviewsStore.update(session, id, changes);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Interview updated." };
}

/** Story 2.2: the author withdraws their own interview. It stays in history; nothing is deleted. */
export async function withdrawInterviewAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "staff") return { error: SIGN_IN_CHANGE, message: "" };

  const parsed = interviewId.safeParse(field(form, "id"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose a valid interview.", message: "" };

  try {
    await interviewsStore.withdraw(session, parsed.data);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Interview withdrawn." };
}
