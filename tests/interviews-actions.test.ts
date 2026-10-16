import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalInterview, InterviewChanges, NewInterview } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, add, update, withdraw, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  add: vi.fn<(session: SessionIdentity, input: NewInterview) => Promise<ExternalInterview>>(),
  update: vi.fn<(session: SessionIdentity, id: string, changes: InterviewChanges) => Promise<ExternalInterview>>(),
  withdraw: vi.fn<(session: SessionIdentity, id: string) => Promise<ExternalInterview>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by interviews-store.test.ts and, against the shared project, interviews-rls.test.ts.
vi.mock("../src/server/interviews-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/interviews-store")>()),
  interviewsStore: { add, update, withdraw, listFor: vi.fn() },
}));

const { addInterviewAction, updateInterviewAction, withdrawInterviewAction } = await import("../src/server/interviews-actions");
const {
  InterviewLockedError, InterviewNotFoundError, InterviewsForbiddenError, InterviewsUnavailableError, InterviewWithdrawnError,
} = await import("../src/server/interviews-store");

const blank = { error: "", message: "" };
const NADIA = { role: "staff", employeeId: "BS-1001" } as const;
const valid = { company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen" };
const ID = "5eed0000-0000-4000-8000-000010010000";
const edit = { id: ID, stage: "Offer stage", outcome: "Offer received", feedback: "Strong design round." };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  getSession.mockResolvedValue(NADIA);
  add.mockImplementation(async (session, input) => ({
    id: "new", employeeId: session.role === "staff" ? session.employeeId : "?", ...input, feedback: "", withdrawn: false,
  }));
  const stored = { id: ID, employeeId: "BS-1001", company: "Orbit", role: "AI Engineer", date: "2026-10-20", stage: "", outcome: "", feedback: "", withdrawn: false };
  update.mockImplementation(async (_session, id, changes) => ({ ...stored, id, ...changes }));
  withdraw.mockImplementation(async (_session, id) => ({ ...stored, id, withdrawn: true }));
});
afterEach(() => vi.clearAllMocks());

describe("addInterviewAction", () => {
  it("saves the interview for the signed-in employee and says so", async () => {
    expect(await addInterviewAction(blank, form(valid))).toEqual({ error: "", message: "Interview added." });
    expect(add).toHaveBeenCalledWith(NADIA, { ...valid, outcome: "" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("trims fields and keeps a free-text outcome", async () => {
    await addInterviewAction(blank, form({ company: "  Orbit  ", role: " AI Engineer ", date: "2026-10-20", stage: " Offer stage ", outcome: " Awaiting offer letter " }));
    expect(add).toHaveBeenCalledWith(NADIA, { company: "Orbit", role: "AI Engineer", date: "2026-10-20", stage: "Offer stage", outcome: "Awaiting offer letter" });
  });

  it("ignores an employee id in the form and saves to the session employee", async () => {
    expect((await addInterviewAction(blank, form({ ...valid, employeeId: "BS-1008", employee_id: "BS-1008" }))).message).toBe("Interview added.");
    expect(add).toHaveBeenCalledTimes(1);
    const [session, input] = add.mock.calls[0];
    expect(session).toEqual(NADIA);
    expect(input).not.toHaveProperty("employeeId");
    expect(input).not.toHaveProperty("employee_id");
  });

  it.each([
    ["a missing company", { ...valid, company: "" }, /company/i],
    ["a blank company", { ...valid, company: "   " }, /company/i],
    ["a missing role", { company: valid.company, date: valid.date, stage: valid.stage }, /role/i],
    ["a missing stage", { ...valid, stage: "" }, /stage/i],
    ["a missing date", { ...valid, date: "" }, /date/i],
    ["a malformed date", { ...valid, date: "20/10/2026" }, /date/i],
    ["an impossible date", { ...valid, date: "2026-02-30" }, /date/i],
    ["a company over 200 characters", { ...valid, company: "x".repeat(201) }, /200 characters/],
    ["a role over 200 characters", { ...valid, role: "x".repeat(201) }, /200 characters/],
    ["a stage over 200 characters", { ...valid, stage: "x".repeat(201) }, /200 characters/],
    ["an outcome over 200 characters", { ...valid, outcome: "x".repeat(201) }, /200 characters/],
  ])("saves nothing for %s and returns a field error", async (_label, fields, message) => {
    const result = await addInterviewAction(blank, form(fields as Record<string, string>));
    expect(result.error).toMatch(message);
    expect(result.message).toBe("");
    expect(add).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("accepts fields of exactly 200 characters", async () => {
    const long = "x".repeat(200);
    expect((await addInterviewAction(blank, form({ ...valid, company: long, role: long, stage: long, outcome: long }))).error).toBe("");
  });

  it.each([["an Administrator", { role: "admin" } as const], ["a signed-out caller", null]])("saves nothing for %s and asks to sign in", async (_label, session) => {
    getSession.mockResolvedValue(session);
    const result = await addInterviewAction(blank, form(valid));
    expect(result.error).toMatch(/sign in/i);
    expect(result.message).toBe("");
    expect(add).not.toHaveBeenCalled();
  });

  it("asks to sign in when the store refuses the session", async () => {
    add.mockRejectedValue(new InterviewsForbiddenError());
    const result = await addInterviewAction(blank, form(valid));
    expect(result).toEqual({ error: expect.stringMatching(/sign in/i), message: "" });
  });

  it("says nothing was saved when interviews are unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    add.mockRejectedValue(new InterviewsUnavailableError());
    try {
      expect(await addInterviewAction(blank, form(valid))).toEqual({
        error: "External interviews could not be reached, so nothing was saved. Please try again in a moment.", message: "",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rethrows unexpected errors", async () => {
    add.mockRejectedValue(new Error("bug"));
    await expect(addInterviewAction(blank, form(valid))).rejects.toThrow("bug");
  });
});

describe("updateInterviewAction (Story 2.2)", () => {
  it("saves stage, outcome and feedback for the signed-in author and says so", async () => {
    expect(await updateInterviewAction(blank, form(edit))).toEqual({ error: "", message: "Interview updated." });
    expect(update).toHaveBeenCalledWith(NADIA, ID, { stage: "Offer stage", outcome: "Offer received", feedback: "Strong design round." });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("trims fields and defaults missing outcome and feedback to empty", async () => {
    await updateInterviewAction(blank, form({ id: ` ${ID} `, stage: "  Final round " }));
    expect(update).toHaveBeenCalledWith(NADIA, ID, { stage: "Final round", outcome: "", feedback: "" });
  });

  it.each([["company"], ["role"], ["date"], ["interview_date"], ["employeeId"], ["employee_id"]])("saves nothing when the form also carries %s", async name => {
    const result = await updateInterviewAction(blank, form({ ...edit, [name]: "Changed" }));
    expect(result).toEqual({ error: expect.stringMatching(/Company, role and date can't be changed/), message: "" });
    expect(update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty stage", { ...edit, stage: "" }, /stage/i],
    ["a blank stage", { ...edit, stage: "   " }, /stage/i],
    ["a stage over 200 characters", { ...edit, stage: "x".repeat(201) }, /200 characters/],
    ["an outcome over 200 characters", { ...edit, outcome: "x".repeat(201) }, /200 characters/],
    ["feedback over 2000 characters", { ...edit, feedback: "x".repeat(2001) }, /2000 characters/],
    ["a non-uuid id", { ...edit, id: "a" }, /interview/i],
    ["a missing id", { stage: "Offer stage" }, /interview/i],
  ])("saves nothing for %s and returns a field error", async (_label, fields, message) => {
    const result = await updateInterviewAction(blank, form(fields as Record<string, string>));
    expect(result.error).toMatch(message);
    expect(result.message).toBe("");
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts feedback of exactly 2000 characters", async () => {
    expect((await updateInterviewAction(blank, form({ ...edit, feedback: "x".repeat(2000) }))).error).toBe("");
  });

  it.each([["an Administrator", { role: "admin" } as const], ["a signed-out caller", null]])("saves nothing for %s and asks to sign in as staff", async (_label, session) => {
    getSession.mockResolvedValue(session);
    const result = await updateInterviewAction(blank, form(edit));
    expect(result.error).toMatch(/sign in again as a staff member/i);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["another staff member's entry", new InterviewNotFoundError(), /not found, or it is not yours/],
    ["a withdrawn entry", new InterviewWithdrawnError(), /already been withdrawn/],
    ["a locked field", new InterviewLockedError(), /can't be changed/],
    ["a refused session", new InterviewsForbiddenError(), /sign in/i],
  ])("reports %s without saying it saved", async (_label, error, message) => {
    update.mockRejectedValue(error);
    const result = await updateInterviewAction(blank, form(edit));
    expect(result).toEqual({ error: expect.stringMatching(message), message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says nothing was saved when interviews are unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    update.mockRejectedValue(new InterviewsUnavailableError());
    try {
      expect((await updateInterviewAction(blank, form(edit))).error).toMatch(/nothing was saved/);
      expect(revalidatePath).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rethrows unexpected errors", async () => {
    update.mockRejectedValue(new Error("bug"));
    await expect(updateInterviewAction(blank, form(edit))).rejects.toThrow("bug");
  });
});

describe("withdrawInterviewAction (Story 2.2)", () => {
  it("withdraws the author's entry and says so", async () => {
    expect(await withdrawInterviewAction(blank, form({ id: ID }))).toEqual({ error: "", message: "Interview withdrawn." });
    expect(withdraw).toHaveBeenCalledWith(NADIA, ID);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("saves nothing for a non-uuid or missing id", async () => {
    for (const fields of [{ id: "not-a-uuid" }, {}] as Record<string, string>[]) {
      expect((await withdrawInterviewAction(blank, form(fields))).error).toMatch(/interview/i);
    }
    expect(withdraw).not.toHaveBeenCalled();
  });

  it.each([["an Administrator", { role: "admin" } as const], ["a signed-out caller", null]])("saves nothing for %s", async (_label, session) => {
    getSession.mockResolvedValue(session);
    expect((await withdrawInterviewAction(blank, form({ id: ID }))).error).toMatch(/sign in again as a staff member/i);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it.each([
    ["another staff member's entry", new InterviewNotFoundError(), /not found, or it is not yours/],
    ["an already withdrawn entry", new InterviewWithdrawnError(), /already been withdrawn/],
  ])("reports %s without saying it saved", async (_label, error, message) => {
    withdraw.mockRejectedValue(error);
    expect(await withdrawInterviewAction(blank, form({ id: ID }))).toEqual({ error: expect.stringMatching(message), message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says nothing was saved when interviews are unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withdraw.mockRejectedValue(new InterviewsUnavailableError());
    try {
      expect((await withdrawInterviewAction(blank, form({ id: ID }))).error).toMatch(/nothing was saved/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("own-record identity for managers and linked Administrators (Story 4.10)", () => {
  const MANAGER = { role: "manager", employeeId: "BS-1004", userId: "u-manager" } as const;
  const LINKED_ADMIN = { role: "admin", employeeId: "BS-1005" } as const;

  it.each([["a manager", MANAGER, "BS-1004"], ["a linked Administrator", LINKED_ADMIN, "BS-1005"]] as const)(
    "%s adds, updates and withdraws through the store as `{ role: \"staff\", employeeId }`, ignoring a form employee id",
    async (_label, session, employeeId) => {
      getSession.mockResolvedValue(session);
      const own = { role: "staff", employeeId };
      expect(await addInterviewAction(blank, form({ ...valid, employeeId: "BS-1008" }))).toEqual({ error: "", message: "Interview added." });
      expect(add).toHaveBeenCalledWith(own, { ...valid, outcome: "" });
      expect(await updateInterviewAction(blank, form(edit))).toEqual({ error: "", message: "Interview updated." });
      expect(update).toHaveBeenCalledWith(own, ID, { stage: edit.stage, outcome: edit.outcome, feedback: edit.feedback });
      expect(await withdrawInterviewAction(blank, form({ id: ID }))).toEqual({ error: "", message: "Interview withdrawn." });
      expect(withdraw).toHaveBeenCalledWith(own, ID);
    },
  );

  it("refuses an unlinked Administrator before any store call", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    expect((await addInterviewAction(blank, form(valid))).error).toMatch(/sign in/i);
    expect((await updateInterviewAction(blank, form(edit))).error).toMatch(/sign in/i);
    expect((await withdrawInterviewAction(blank, form({ id: ID }))).error).toMatch(/sign in/i);
    expect(add).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
  });
});
