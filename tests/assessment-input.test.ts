import { describe, expect, it } from "vitest";
import {
  EVALUATION_TEXT_MAX, invalidEvaluationFields, invalidSkillRatingFields, normalizeEvaluation, normalizeSkillRating,
  READINESS_MAX, SKILL_EVIDENCE_MAX, SKILL_LEVEL_LABELS, SKILL_LEVELS, SKILL_NAME_MAX,
} from "@/domain/assessment-input";

describe("assessment-input constants (Story 7.4)", () => {
  it("matches the table checks", () => {
    expect([SKILL_NAME_MAX, SKILL_EVIDENCE_MAX, READINESS_MAX, EVALUATION_TEXT_MAX]).toEqual([80, 300, 120, 1000]);
    expect(SKILL_LEVELS).toEqual([1, 2, 3, 4, 5]);
    expect(SKILL_LEVELS.map(l => SKILL_LEVEL_LABELS[l])).toEqual(["foundational", "developing", "independent", "advanced", "expert"]);
  });
});

describe("skill ratings", () => {
  it("trims and collapses whitespace in the name and evidence, keeping the level", () => {
    expect(normalizeSkillRating({ name: "  Machine   learning ", level: 4, evidence: " Project \n review  " }))
      .toEqual({ name: "Machine learning", level: 4, evidence: "Project review" });
  });

  it("accepts every level from 1 to 5 with a name and evidence", () => {
    for (const level of SKILL_LEVELS) expect(invalidSkillRatingFields({ name: "React", level, evidence: "Shipped" })).toEqual([]);
  });

  it.each([0, 6, 3.5, -1, Number.NaN])("refuses level %s", level => {
    expect(invalidSkillRatingFields({ name: "React", level, evidence: "Shipped" })).toEqual(["level"]);
  });

  it("refuses a blank or over-length name and evidence, in form order", () => {
    expect(invalidSkillRatingFields(normalizeSkillRating({ name: "   ", level: 3, evidence: " " }))).toEqual(["name", "evidence"]);
    expect(invalidSkillRatingFields({ name: "x".repeat(SKILL_NAME_MAX + 1), level: 9, evidence: "y".repeat(SKILL_EVIDENCE_MAX + 1) }))
      .toEqual(["name", "level", "evidence"]);
    expect(invalidSkillRatingFields({ name: "x".repeat(SKILL_NAME_MAX), level: 5, evidence: "y".repeat(SKILL_EVIDENCE_MAX) })).toEqual([]);
  });

  it("treats a missing value as invalid, never throwing", () => {
    const missing = { name: undefined, level: undefined, evidence: undefined } as unknown as Parameters<typeof normalizeSkillRating>[0];
    expect(invalidSkillRatingFields(normalizeSkillRating(missing))).toEqual(["name", "level", "evidence"]);
  });
});

describe("evaluations", () => {
  const valid = { strengths: "Clear reasoning", developmentPriorities: "Practise presenting", readiness: "Ready for interviews" };

  it("trims and collapses whitespace in every field", () => {
    expect(normalizeEvaluation({ strengths: "  Clear \t reasoning ", developmentPriorities: "Practise\n\npresenting", readiness: " Ready  " }))
      .toEqual({ strengths: "Clear reasoning", developmentPriorities: "Practise presenting", readiness: "Ready" });
  });

  it("accepts valid text up to the limits", () => {
    expect(invalidEvaluationFields(valid)).toEqual([]);
    expect(invalidEvaluationFields({
      strengths: "s".repeat(EVALUATION_TEXT_MAX), developmentPriorities: "d".repeat(EVALUATION_TEXT_MAX), readiness: "r".repeat(READINESS_MAX),
    })).toEqual([]);
  });

  it("refuses blank or over-length fields, in form order", () => {
    expect(invalidEvaluationFields(normalizeEvaluation({ strengths: " ", developmentPriorities: "", readiness: "\n" })))
      .toEqual(["strengths", "developmentPriorities", "readiness"]);
    expect(invalidEvaluationFields({ ...valid, developmentPriorities: "d".repeat(EVALUATION_TEXT_MAX + 1) })).toEqual(["developmentPriorities"]);
    expect(invalidEvaluationFields({ ...valid, readiness: "r".repeat(READINESS_MAX + 1) })).toEqual(["readiness"]);
  });
});
