import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssignmentEvaluation, EvaluationInput } from "@/server/assignment-evaluations-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, create, amend, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  create: vi.fn<(session: SessionIdentity, assignmentId: string, input: EvaluationInput) => Promise<AssignmentEvaluation>>(),
  amend: vi.fn<(session: SessionIdentity, assignmentId: string, input: EvaluationInput) => Promise<AssignmentEvaluation>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by assignment-evaluations-store.test.ts and, live, assignment-evaluations-rls.test.ts.
vi.mock("../src/server/assignment-evaluations-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/assignment-evaluations-store")>()),
  assignmentEvaluationsStore: { create, amend, listFor: vi.fn() },
}));

const actions = await import("../src/server/assignment-evaluation-actions");
const { amendEvaluationAction, createEvaluationAction } = actions;
const {
  EvaluationAssignmentOpenError, EvaluationExistsError, EvaluationForbiddenError, EvaluationInvalidError, EvaluationNotFoundError,
  EvaluationsUnavailableError,
} = await import("../src/server/assignment-evaluations-store");

const blank = { error: "", message: "" };
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const STAFF = { role: "staff", employeeId: "BS-1001" } as const;
const ID = "5e000000-0000-4000-8000-000000000002";
const FORBIDDEN = "Only the Administrator or a manager over this assignment's department can evaluate it.";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const valid = { assignmentId: ID, evaluation: "  Delivered on time.  ", clientFeedback: " Happy client. " };
const sample: AssignmentEvaluation = {
  id: "e-1", assignmentId: ID, employeeId: "BS-1001", departmentId: "d-1", evaluation: "Delivered on time.", clientFeedback: "Happy client.",
  createdBy: "u-1", createdAt: "2026-10-16T00:00:00Z", authoredBy: "u-1", updatedAt: "2026-10-16T00:00:00Z",
  createdByName: null, createdByRole: "manager", authoredByName: null, authoredByRole: "manager", 
};

beforeEach(() => {
  getSession.mockResolvedValue(ADMIN);
  create.mockResolvedValue(sample);
  amend.mockResolvedValue(sample);
});
afterEach(() => vi.clearAllMocks());

describe("assignment evaluation actions module", () => {
  it("exports exactly the create and amend actions (no delete)", () => {
    expect(Object.keys(actions).sort()).toEqual(["amendEvaluationAction", "createEvaluationAction"]);
  });
});

describe("session gate", () => {
  for (const [label, session] of [["a staff session", STAFF], ["no session", null]] as const) {
    it(`refuses ${label} before validating or touching the store`, async () => {
      getSession.mockResolvedValue(session);
      expect(await createEvaluationAction(blank, form(valid))).toEqual({ error: FORBIDDEN, message: "" });
      expect(await amendEvaluationAction(blank, form(valid))).toEqual({ error: FORBIDDEN, message: "" });
      // Even an invalid form gets the forbidden message: the session is checked first.
      expect(await createEvaluationAction(blank, form({}))).toEqual({ error: FORBIDDEN, message: "" });
      expect(create).not.toHaveBeenCalled();
      expect(amend).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }
});

describe("createEvaluationAction", () => {
  for (const session of [ADMIN, MANAGER]) {
    it(`saves for ${session.role}, trimmed, naming only the assignment`, async () => {
      getSession.mockResolvedValue(session);
      expect(await createEvaluationAction(blank, form({ ...valid, employeeId: "BS-1003", createdBy: "forged" })))
        .toEqual({ error: "", message: "Evaluation saved." });
      expect(create).toHaveBeenCalledWith(session, ID, { evaluation: "Delivered on time.", clientFeedback: "Happy client." });
      expect(revalidatePath).toHaveBeenCalledWith("/");
    });
  }

  it("treats a missing client-feedback field as empty", async () => {
    await createEvaluationAction(blank, form({ assignmentId: ID, evaluation: "Good." }));
    expect(create).toHaveBeenCalledWith(ADMIN, ID, { evaluation: "Good.", clientFeedback: "" });
  });

  it("validates with zod before the store", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ ...valid, evaluation: "   " }, "Enter the evaluation."],
      [{ ...valid, evaluation: "x".repeat(4001) }, "Keep the evaluation to 4000 characters or fewer."],
      [{ ...valid, clientFeedback: "x".repeat(2001) }, "Keep the client feedback to 2000 characters or fewer."],
      [{ ...valid, assignmentId: "not-a-uuid" }, "Choose an existing assignment."],
      [{ evaluation: "x" }, "Choose an existing assignment."],
      [{ assignmentId: ID }, "Enter the evaluation."],
    ];
    for (const [fields, message] of cases) expect(await createEvaluationAction(blank, form(fields))).toEqual({ error: message, message: "" });
    expect(create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps the store's refusals to their messages and does not revalidate on them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [Error, string][] = [
      [new EvaluationForbiddenError(), FORBIDDEN],
      [new EvaluationAssignmentOpenError(), "Close the assignment before evaluating it."],
      [new EvaluationInvalidError("The evaluation can't be changed that way."), "The evaluation can't be changed that way."],
      [new EvaluationsUnavailableError(), "Evaluations are temporarily unavailable. Nothing was saved."],
    ];
    for (const [error, message] of cases) {
      create.mockRejectedValueOnce(error);
      expect(await createEvaluationAction(blank, form(valid))).toEqual({ error: message, message: "" });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("revalidates after an 'already evaluated' or 'not written yet' refusal, so a stale page shows the right form", async () => {
    create.mockRejectedValueOnce(new EvaluationExistsError());
    expect(await createEvaluationAction(blank, form(valid))).toEqual({ error: "This assignment already has an evaluation. Amend it instead.", message: "" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
    revalidatePath.mockClear();
    amend.mockRejectedValueOnce(new EvaluationNotFoundError());
    expect(await amendEvaluationAction(blank, form(valid))).toEqual({ error: "Write the evaluation first.", message: "" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("counts a CRLF line break as one character (as browsers submit textareas)", async () => {
    // 3999 characters + one line break = 4000, within the limit; sent as CRLF it would be 4001.
    const evaluation = `${"x".repeat(2000)}\r\n${"y".repeat(1999)}`;
    const clientFeedback = `${"a".repeat(1000)}\r\n${"b".repeat(999)}`;
    expect(await createEvaluationAction(blank, form({ assignmentId: ID, evaluation, clientFeedback }))).toEqual({ error: "", message: "Evaluation saved." });
    expect(create).toHaveBeenCalledWith(ADMIN, ID, {
      evaluation: `${"x".repeat(2000)}\n${"y".repeat(1999)}`, clientFeedback: `${"a".repeat(1000)}\n${"b".repeat(999)}`,
    });
  });

  it("rethrows an unknown error", async () => {
    const bug = new TypeError("bug");
    create.mockRejectedValueOnce(bug);
    await expect(createEvaluationAction(blank, form(valid))).rejects.toBe(bug);
  });
});

describe("amendEvaluationAction", () => {
  it("amends through the store and says so", async () => {
    getSession.mockResolvedValue(MANAGER);
    expect(await amendEvaluationAction(blank, form({ ...valid, clientFeedback: "" }))).toEqual({ error: "", message: "Evaluation updated." });
    expect(amend).toHaveBeenCalledWith(MANAGER, ID, { evaluation: "Delivered on time.", clientFeedback: "" });
    expect(create).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("maps a missing evaluation and a locked-field refusal", async () => {
    amend.mockRejectedValueOnce(new EvaluationNotFoundError());
    expect(await amendEvaluationAction(blank, form(valid))).toEqual({ error: "Write the evaluation first.", message: "" });
    amend.mockRejectedValueOnce(new EvaluationInvalidError("The evaluation can't be changed that way."));
    expect(await amendEvaluationAction(blank, form(valid))).toEqual({ error: "The evaluation can't be changed that way.", message: "" });
    amend.mockRejectedValueOnce(new EvaluationForbiddenError());
    expect(await amendEvaluationAction(blank, form(valid))).toEqual({ error: FORBIDDEN, message: "" });
  });

  it("validates before the store", async () => {
    expect(await amendEvaluationAction(blank, form({ ...valid, evaluation: "" }))).toEqual({ error: "Enter the evaluation.", message: "" });
    expect(amend).not.toHaveBeenCalled();
  });
});
