"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  assignmentEvaluationsStore, CLIENT_FEEDBACK_MAX, EVALUATION_MAX, EvaluationAssignmentOpenError, EvaluationExistsError,
  EvaluationForbiddenError, EvaluationInvalidError, EvaluationNotFoundError, EvaluationsUnavailableError,
} from "./assignment-evaluations-store";

// Story 4.6: the Administrator, or a manager over the assignment's department, writes the evaluation of a
// closed assignment (with optional client feedback) once, then amends it. Staff are refused before anything
// is read. A form names only the assignment: its employee and department come from the assignment row, and
// the author from the session (the database trigger records it).
const FORBIDDEN = "Only the Administrator or a manager over this assignment's department can evaluate it.";
const OPEN = "Close the assignment before evaluating it.";
const EXISTS = "This assignment already has an evaluation. Amend it instead.";
const NOT_FOUND = "Write the evaluation first.";
const UNAVAILABLE = "Evaluations are temporarily unavailable. Nothing was saved.";

const assignmentId = z.string({ error: "Choose an existing assignment." }).trim().uuid("Choose an existing assignment.");
/** Browsers submit textarea line breaks as CRLF; count them as one character, as the textarea's maxLength does. */
const lines = (value: string) => value.replace(/\r\n/g, "\n");

const evaluationText = z.string({ error: "Enter the evaluation." }).transform(lines).transform(value => value.trim())
  .pipe(z.string().min(1, "Enter the evaluation.").max(EVALUATION_MAX, `Keep the evaluation to ${EVALUATION_MAX} characters or fewer.`));
const clientFeedback = z.string({ error: "Enter the client feedback as text." }).transform(lines).transform(value => value.trim())
  .pipe(z.string().max(CLIENT_FEEDBACK_MAX, `Keep the client feedback to ${CLIENT_FEEDBACK_MAX} characters or fewer.`));

const evaluationForm = z.object({ assignmentId, evaluation: evaluationText, clientFeedback });

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
  if (error instanceof EvaluationForbiddenError) return fail(FORBIDDEN);
  if (error instanceof EvaluationAssignmentOpenError) return fail(OPEN);
  if (error instanceof EvaluationExistsError) return fail(EXISTS);
  if (error instanceof EvaluationNotFoundError) return fail(NOT_FOUND);
  if (error instanceof EvaluationInvalidError) return fail(error.message);
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof EvaluationsUnavailableError) {
    console.error("Assignment evaluations unavailable.", error, { cause: error.cause });
    return fail(UNAVAILABLE);
  }
  throw error;
}

const firstIssue = (error: z.ZodError, fallback: string) => error.issues[0]?.message ?? fallback;

/** The shared flow: session gate, zod, store, revalidate. A missing feedback field is an empty note. */
async function save(form: FormData, write: "create" | "amend", message: string): Promise<ActionState> {
  const session = await managingSession();
  if (!session) return fail(FORBIDDEN);

  const parsed = evaluationForm.safeParse({
    assignmentId: field(form, "assignmentId"), evaluation: field(form, "evaluation"), clientFeedback: field(form, "clientFeedback") ?? "",
  });
  if (!parsed.success) return fail(firstIssue(parsed.error, "Check the evaluation."));

  const { assignmentId: id, ...input } = parsed.data;
  try {
    await assignmentEvaluationsStore[write](session, id, input);
  } catch (error) {
    // The page is stale (an evaluation appeared, or is missing): refresh it so the form shows the right mode.
    if (error instanceof EvaluationExistsError || error instanceof EvaluationNotFoundError) revalidatePath("/");
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message };
}

export async function createEvaluationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return save(form, "create", "Evaluation saved.");
}

export async function amendEvaluationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return save(form, "amend", "Evaluation updated.");
}
