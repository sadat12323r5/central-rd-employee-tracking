import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationInput, SkillRatingInput } from "@/domain/assessment-input";
import type { Actor } from "@/server/auth";
import type { SessionIdentity } from "@/server/session";

const { getActor, rateSkill, saveEvaluation, revalidatePath } = vi.hoisted(() => ({
  getActor: vi.fn<() => Promise<Actor | null>>(),
  rateSkill: vi.fn<(session: SessionIdentity, employeeId: string, input: SkillRatingInput) => Promise<{ employeeId: string; name: string }>>(),
  saveEvaluation: vi.fn<(session: SessionIdentity, employeeId: string, input: EvaluationInput) => Promise<{ employeeId: string; name: string }>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getActor }));
// The Supabase store is covered by assessments-store.test.ts and, against the shared project, assessments-rls.test.ts.
vi.mock("../src/server/assessments-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/assessments-store")>()),
  assessmentsStore: { rateSkill, saveEvaluation, listFor: vi.fn() },
}));

const { rateSkillAction, saveEvaluationAction } = await import("../src/server/assessment-actions");
const {
  AssessmentForbiddenError, AssessmentNotFoundError, AssessmentsUnavailableError, AssessmentValidationError,
} = await import("../src/server/assessments-store");

const blank = { error: "", message: "" };
const ADMIN: SessionIdentity = { role: "admin" };
const MANAGER: SessionIdentity = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" };
const STAFF: SessionIdentity = { role: "staff", employeeId: "BS-1001" };

const NOT_ALLOWED = "Only an Administrator or a department manager can change skills or the evaluation.";
const FORBIDDEN = "You can only assess employees in your own department or its sub-departments.";
const NO_SUCH_EMPLOYEE = "Choose an existing employee.";
const UNAVAILABLE = "Skills and evaluations are temporarily unavailable. Nothing was changed.";

const skillFields = { employeeId: "BS-1001", name: "  React   Native ", level: "4", evidence: "Shipped the app" };
const evaluationFields = { employeeId: "BS-1001", strengths: "Clear reasoning", developmentPriorities: "Present more", readiness: "Ready" };

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  getActor.mockResolvedValue({ identity: ADMIN, userId: "admin-user" });
  rateSkill.mockResolvedValue({ employeeId: "BS-1001", name: "Nadia Rahman" });
  saveEvaluation.mockResolvedValue({ employeeId: "BS-1001", name: "Nadia Rahman" });
});
afterEach(() => vi.clearAllMocks());

describe("assessment actions role gate (Story 7.4)", () => {
  it.each([["a staff session", STAFF], ["no session", null]] as const)("refuses %s before the store, even on its own record", async (_label, identity) => {
    getActor.mockResolvedValue(identity ? { identity, userId: "u" } : null);
    expect(await rateSkillAction(blank, form(skillFields))).toEqual({ error: NOT_ALLOWED, message: "" });
    expect(await saveEvaluationAction(blank, form(evaluationFields))).toEqual({ error: NOT_ALLOWED, message: "" });
    expect(rateSkill).not.toHaveBeenCalled();
    expect(saveEvaluation).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("rateSkillAction", () => {
  it("rates the skill for an admin, with the normalised name and an integer level, and confirms it", async () => {
    const result = await rateSkillAction(blank, form(skillFields));
    expect(result).toEqual({ error: "", message: "React Native was rated 4 out of 5 for Nadia Rahman." });
    expect(rateSkill).toHaveBeenCalledWith(ADMIN, "BS-1001", { name: "React Native", level: 4, evidence: "Shipped the app" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("rates for a manager", async () => {
    getActor.mockResolvedValue({ identity: MANAGER, userId: "u" });
    expect((await rateSkillAction(blank, form(skillFields))).message).toBe("React Native was rated 4 out of 5 for Nadia Rahman.");
    expect(rateSkill).toHaveBeenCalledWith(MANAGER, "BS-1001", expect.anything());
  });

  it.each([
    [{ level: "0" }, "Choose a level from 1 to 5."],
    [{ level: "6" }, "Choose a level from 1 to 5."],
    [{ level: "3.5" }, "Choose a level from 1 to 5."],
    [{ level: "" }, "Choose a level from 1 to 5."],
    [{ name: "   " }, "Enter the skill name."],
    [{ name: "x".repeat(81) }, "Keep the skill name to 80 characters or fewer."],
    [{ evidence: "" }, "Enter the evidence."],
    [{ evidence: "y".repeat(301) }, "Keep the evidence to 300 characters or fewer."],
    [{ employeeId: "1001" }, NO_SUCH_EMPLOYEE],
  ])("refuses %o before the store, naming the field", async (change, message) => {
    expect(await rateSkillAction(blank, form({ ...skillFields, ...change }))).toEqual({ error: message, message: "" });
    expect(rateSkill).not.toHaveBeenCalled();
  });

  it("refuses a missing level", async () => {
    const { level: _, ...rest } = skillFields;
    expect((await rateSkillAction(blank, form(rest))).error).toBe("Choose a level from 1 to 5.");
  });

  it("ignores forged extra fields (reviewer, updated_by, another employee in another key)", async () => {
    await rateSkillAction(blank, form({ ...skillFields, updated_by: "x", reviewer: "Someone", employee_id: "BS-1999" }));
    expect(rateSkill).toHaveBeenCalledWith(ADMIN, "BS-1001", { name: "React Native", level: 4, evidence: "Shipped the app" });
  });
});

describe("saveEvaluationAction", () => {
  it("saves the evaluation and confirms it", async () => {
    expect(await saveEvaluationAction(blank, form({ ...evaluationFields, strengths: "  Clear   reasoning " })))
      .toEqual({ error: "", message: "Nadia Rahman's evaluation was saved." });
    expect(saveEvaluation).toHaveBeenCalledWith(ADMIN, "BS-1001", { strengths: "Clear reasoning", developmentPriorities: "Present more", readiness: "Ready" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it.each([
    [{ strengths: "" }, "Enter the strengths."],
    [{ developmentPriorities: " " }, "Enter the development priorities."],
    [{ readiness: "" }, "Enter the readiness."],
    [{ readiness: "r".repeat(121) }, "Keep the readiness to 120 characters or fewer."],
    [{ strengths: "s".repeat(1001) }, "Keep the strengths to 1000 characters or fewer."],
  ])("refuses %o before the store, naming the field", async (change, message) => {
    expect(await saveEvaluationAction(blank, form({ ...evaluationFields, ...change }))).toEqual({ error: message, message: "" });
    expect(saveEvaluation).not.toHaveBeenCalled();
  });

  it("never passes a reviewer or date from the form", async () => {
    await saveEvaluationAction(blank, form({ ...evaluationFields, reviewer: "Forged", reviewedOn: "2020-01-01" }));
    expect(Object.keys(saveEvaluation.mock.calls[0][2]).sort()).toEqual(["developmentPriorities", "readiness", "strengths"]);
  });
});

describe("assessment actions store refusals", () => {
  const both = [
    ["rateSkillAction", () => rateSkillAction(blank, form(skillFields)), rateSkill],
    ["saveEvaluationAction", () => saveEvaluationAction(blank, form(evaluationFields)), saveEvaluation],
  ] as const;

  for (const [label, call, store] of both) {
    it(`${label}: names the scope rule for a manager refused by the store`, async () => {
      getActor.mockResolvedValue({ identity: MANAGER, userId: "u" });
      store.mockRejectedValue(new AssessmentForbiddenError());
      expect(await call()).toEqual({ error: FORBIDDEN, message: "" });
    });

    it(`${label}: shows an Administrator refused by the database the unavailable message, never the scope one`, async () => {
      store.mockRejectedValue(new AssessmentForbiddenError());
      expect(await call()).toEqual({ error: UNAVAILABLE, message: "" });
    });

    it(`${label}: reports an unknown employee`, async () => {
      store.mockRejectedValue(new AssessmentNotFoundError());
      expect(await call()).toEqual({ error: NO_SUCH_EMPLOYEE, message: "" });
    });

    it(`${label}: reports unavailable and changes nothing when the store is unavailable or fails unexpectedly`, async () => {
      store.mockRejectedValue(new AssessmentsUnavailableError());
      expect(await call()).toEqual({ error: UNAVAILABLE, message: "" });
      store.mockRejectedValue(new TypeError("bug"));
      expect(await call()).toEqual({ error: UNAVAILABLE, message: "" });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it(`${label}: reports a database validation refusal generically`, async () => {
      store.mockRejectedValue(new AssessmentValidationError(["input"]));
      expect((await call()).error).toBe("Check the values entered.");
    });
  }
});
