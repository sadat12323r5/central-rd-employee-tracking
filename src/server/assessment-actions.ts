"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  EVALUATION_TEXT_MAX, READINESS_MAX, SKILL_EVIDENCE_MAX, SKILL_LEVELS, SKILL_NAME_MAX,
} from "@/domain/assessment-input";
import { normalizeText } from "@/domain/employee-input";
import type { ActionState } from "./attendance-actions";
import { getActor } from "./auth";
import {
  AssessmentForbiddenError, AssessmentNotFoundError, assessmentsStore, AssessmentValidationError,
} from "./assessments-store";

// Story 7.4: the Administrator (anyone) and department managers (employees in their subtree) rate an
// employee's skills and save the evaluation summary. The role is checked here first: Staff (even on their
// own record) and no session never reach assessments-store. Only the listed fields are read from the form;
// the reviewer and the review date come from the session, in the database function.

const NOT_ALLOWED = "Only an Administrator or a department manager can change skills or the evaluation.";
const FORBIDDEN = "You can only assess employees in your own department or its sub-departments.";
const NO_SUCH_EMPLOYEE = "Choose an existing employee.";
const UNAVAILABLE = "Skills and evaluations are temporarily unavailable. Nothing was changed.";
const LEVEL = `Choose a level from ${SKILL_LEVELS[0]} to ${SKILL_LEVELS[SKILL_LEVELS.length - 1]}.`;

/** A required free-text field: trimmed, inner whitespace collapsed, 1–`max` characters. */
const text = (label: string, max: number) => z.string({ error: `Enter the ${label}.` })
  .transform(normalizeText)
  .pipe(z.string().min(1, `Enter the ${label}.`).max(max, `Keep the ${label} to ${max} characters or fewer.`));

const employeeId = z.string({ error: NO_SUCH_EMPLOYEE }).trim().regex(/^BS-\d{4}$/, NO_SUCH_EMPLOYEE);

const skillRating = z.object({
  employeeId,
  name: text("skill name", SKILL_NAME_MAX),
  // The form sends a string: only a whole number 1–5 is accepted ("3.5", "0", "6" and "" are refused).
  level: z.string({ error: LEVEL }).trim().regex(/^[1-5]$/, LEVEL).transform(Number),
  evidence: text("evidence", SKILL_EVIDENCE_MAX),
});

const evaluation = z.object({
  employeeId,
  strengths: text("strengths", EVALUATION_TEXT_MAX),
  developmentPriorities: text("development priorities", EVALUATION_TEXT_MAX),
  readiness: text("readiness", READINESS_MAX),
});

/** Only the named fields, and only string values: anything else in the form (e.g. reviewer, date) is ignored. */
function fieldsOf(form: FormData, keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => {
    const value = form.get(key);
    return [key, typeof value === "string" ? value : undefined];
  }));
}

function failure(error: string): ActionState {
  return { error, message: "" };
}

type Role = "admin" | "manager";

/** The store's refusals as messages; the Administrator never sees the manager-only scope message. */
function refusal(error: unknown, role: Role, what: string): ActionState {
  if (error instanceof AssessmentForbiddenError) {
    // The Administrator has authority over everyone: a refusal (e.g. the function not applied, or a stale
    // JWT role) is not about scope, so never show the manager-only message.
    if (role === "admin") {
      console.error(`${what} failed: refused for an Administrator.`, error.name);
      return failure(UNAVAILABLE);
    }
    return failure(FORBIDDEN);
  }
  if (error instanceof AssessmentNotFoundError) return failure(NO_SUCH_EMPLOYEE);
  if (error instanceof AssessmentValidationError) return failure("Check the values entered.");
  console.error(`${what} failed.`, error instanceof Error ? error.name : "unknown error");
  return failure(UNAVAILABLE);
}

export async function rateSkillAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await getActor();
  const session = actor?.identity;
  if (session?.role !== "admin" && session?.role !== "manager") return failure(NOT_ALLOWED);

  const parsed = skillRating.safeParse(fieldsOf(form, ["employeeId", "name", "level", "evidence"]));
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Check the skill rating.");

  const { employeeId: id, ...rating } = parsed.data;
  try {
    const saved = await assessmentsStore.rateSkill(session, id, rating);
    revalidatePath("/");
    return { error: "", message: `${rating.name} was rated ${rating.level} out of 5 for ${saved.name}.` };
  } catch (error) {
    return refusal(error, session.role, "Rating a skill");
  }
}

export async function saveEvaluationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await getActor();
  const session = actor?.identity;
  if (session?.role !== "admin" && session?.role !== "manager") return failure(NOT_ALLOWED);

  const parsed = evaluation.safeParse(fieldsOf(form, ["employeeId", "strengths", "developmentPriorities", "readiness"]));
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Check the evaluation.");

  const { employeeId: id, ...input } = parsed.data;
  try {
    const saved = await assessmentsStore.saveEvaluation(session, id, input);
    revalidatePath("/");
    return { error: "", message: `${saved.name}'s evaluation was saved.` };
  } catch (error) {
    return refusal(error, session.role, "Saving an evaluation");
  }
}
