import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { employees, evaluationSeedRows, missingSkillSeedRows, skillSeedRows } from "@/data/employees";
import { EVALUATION_TEXT_MAX, READINESS_MAX, SKILL_EVIDENCE_MAX, SKILL_LEVELS, SKILL_NAME_MAX } from "@/domain/assessment-input";
import { isCalendarDate } from "@/domain/dates";

// Story 7.4: the fixture is seed-only for skills and the evaluation (scripts/seed-employees.ts moves them
// into employee_skills and employee_evaluations); nothing reads them from the fixture at runtime.
const fits = (value: string, max: number) => value.trim().length >= 1 && value.length <= max;

describe("fixture skills as seed rows", () => {
  const rows = skillSeedRows(employees);

  it("cover every fixture employee's every skill, unrated by any account", () => {
    expect(rows).toHaveLength(employees.reduce((n, e) => n + e.skills.length, 0));
    for (const e of employees) {
      expect(e.skills.length).toBeGreaterThan(0);
      expect(rows.filter(r => r.employee_id === e.id)).toEqual(e.skills.map(s => ({
        employee_id: e.id, name: s.name, level: s.level, evidence: s.evidence, updated_by: null,
      })));
    }
  });

  it("fit the table checks", () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["employee_id", "evidence", "level", "name", "updated_by"]);
      expect(row.employee_id).toMatch(/^BS-\d{4}$/);
      expect(fits(row.name, SKILL_NAME_MAX)).toBe(true);
      expect(fits(row.evidence, SKILL_EVIDENCE_MAX)).toBe(true);
      expect((SKILL_LEVELS as readonly number[]).includes(row.level)).toBe(true);
    }
  });

  it("are unique per employee by case-insensitive name (the skill identifier)", () => {
    const keys = rows.map(r => `${r.employee_id}|${r.name.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("missingSkillSeedRows (insert-only skill seeding)", () => {
  const row = (employee_id: string, name: string) => ({ employee_id, name, level: 3, evidence: "e", updated_by: null });

  it("skips a skill the employee already has under a differently-cased name", () => {
    expect(missingSkillSeedRows([{ employee_id: "BS-1001", name: "react" }], [row("BS-1001", "React")])).toEqual([]);
  });

  it("keeps a skill not yet stored", () => {
    expect(missingSkillSeedRows([{ employee_id: "BS-1001", name: "React" }], [row("BS-1001", "React"), row("BS-1001", "TypeScript")]))
      .toEqual([row("BS-1001", "TypeScript")]);
  });

  it("is not suppressed by another employee's skill of the same name", () => {
    expect(missingSkillSeedRows([{ employee_id: "BS-1002", name: "React" }], [row("BS-1001", "React")])).toEqual([row("BS-1001", "React")]);
  });
});

describe("fixture evaluations as seed rows", () => {
  const rows = evaluationSeedRows(employees);

  it("give every fixture employee one evaluation with the fixture's reviewer and date", () => {
    expect(rows.map(r => r.employee_id)).toEqual(employees.map(e => e.id));
    const nadia = employees[0];
    expect(rows[0]).toEqual({
      employee_id: nadia.id, strengths: nadia.review.strengths, development_priorities: nadia.review.next,
      readiness: nadia.review.readiness, reviewer: "Ayesha Karim · L&D Manager", reviewed_on: "2026-09-14", updated_by: null,
    });
  });

  it("fit the table checks", () => {
    for (const row of rows) {
      expect(fits(row.strengths, EVALUATION_TEXT_MAX)).toBe(true);
      expect(fits(row.development_priorities, EVALUATION_TEXT_MAX)).toBe(true);
      expect(fits(row.readiness, READINESS_MAX)).toBe(true);
      expect(fits(row.reviewer, 200)).toBe(true);
      expect(isCalendarDate(row.reviewed_on)).toBe(true);
    }
  });
});

describe("runtime reads", () => {
  it("employees-store never takes skills or the review from the fixture", () => {
    const source = readFileSync("src/server/employees-store.ts", "utf8");
    const nested = source.slice(source.indexOf("function nestedFor"), source.indexOf("export const emptyReview"));
    expect(nested).not.toMatch(/\bskills\b|\breview\b/);
  });

  it("the seed script inserts both after training, insert-only", () => {
    const seed = readFileSync("scripts/seed-employees.ts", "utf8");
    expect(seed.indexOf("employee_skills")).toBeGreaterThan(seed.indexOf("training_history"));
    expect(seed).toMatch(/from\("employee_evaluations"\)\s*\.upsert\(evaluationSeedRows\(employees\), \{ onConflict: "employee_id", ignoreDuplicates: true \}\)/);
    expect(seed).toMatch(/from\("employee_skills"\)\.insert\(newSkills, \{ defaultToNull: false \}\)/);
  });
});
