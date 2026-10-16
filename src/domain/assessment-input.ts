// Pure rules for skills assessments and the manager evaluation (Story 7.4): normalising what a person
// types and checking it. No framework or database imports. assessments-store is the load-bearing check
// (and the database functions check again); the server actions validate with zod first.

import { normalizeText } from "./employee-input";

export const SKILL_NAME_MAX = 80;
export const SKILL_EVIDENCE_MAX = 300;
export const READINESS_MAX = 120;
export const EVALUATION_TEXT_MAX = 1000;
/** The rating scale: 1 foundational · 2 developing · 3 independent · 4 advanced · 5 expert. */
export const SKILL_LEVELS = [1, 2, 3, 4, 5] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];
/** The label of each level, as the Skills & evaluation tab explains the scale. */
export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = {
  1: "foundational", 2: "developing", 3: "independent", 4: "advanced", 5: "expert",
};

/** One skill rating as entered: the skill's name, its level (1–5) and the supporting evidence. */
export type SkillRatingInput = { name: string; level: number; evidence: string };
export type SkillRatingField = keyof SkillRatingInput;

/** The evaluation summary as entered. */
export type EvaluationInput = { strengths: string; developmentPriorities: string; readiness: string };
export type EvaluationField = keyof EvaluationInput;

/** Trims and collapses inner whitespace in the name and evidence; the level is kept as given. */
export function normalizeSkillRating(input: SkillRatingInput): SkillRatingInput {
  return {
    name: normalizeText(String(input.name ?? "")),
    level: input.level,
    evidence: normalizeText(String(input.evidence ?? "")),
  };
}

const withinLength = (value: unknown, max: number) => typeof value === "string" && value.length >= 1 && value.length <= max;

/** The fields of a normalised rating that break the rules, in form order; empty when valid. */
export function invalidSkillRatingFields(rating: SkillRatingInput): SkillRatingField[] {
  const invalid: SkillRatingField[] = [];
  if (!withinLength(rating.name, SKILL_NAME_MAX)) invalid.push("name");
  if (!(SKILL_LEVELS as readonly number[]).includes(rating.level)) invalid.push("level");
  if (!withinLength(rating.evidence, SKILL_EVIDENCE_MAX)) invalid.push("evidence");
  return invalid;
}

/** Trims and collapses inner whitespace in every field. */
export function normalizeEvaluation(input: EvaluationInput): EvaluationInput {
  return {
    strengths: normalizeText(String(input.strengths ?? "")),
    developmentPriorities: normalizeText(String(input.developmentPriorities ?? "")),
    readiness: normalizeText(String(input.readiness ?? "")),
  };
}

/** The fields of a normalised evaluation that break the rules, in form order; empty when valid. */
export function invalidEvaluationFields(evaluation: EvaluationInput): EvaluationField[] {
  const invalid: EvaluationField[] = [];
  if (!withinLength(evaluation.strengths, EVALUATION_TEXT_MAX)) invalid.push("strengths");
  if (!withinLength(evaluation.developmentPriorities, EVALUATION_TEXT_MAX)) invalid.push("developmentPriorities");
  if (!withinLength(evaluation.readiness, READINESS_MAX)) invalid.push("readiness");
  return invalid;
}
