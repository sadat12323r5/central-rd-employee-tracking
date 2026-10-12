import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalInterview, NewInterview } from "@/server/interviews-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, add, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  add: vi.fn<(session: SessionIdentity, input: NewInterview) => Promise<ExternalInterview>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by interviews-store.test.ts and, against the shared project, interviews-rls.test.ts.
vi.mock("../src/server/interviews-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/interviews-store")>()),
  interviewsStore: { add, listFor: vi.fn() },
}));

const { addInterviewAction } = await import("../src/server/interviews-actions");
const { InterviewsForbiddenError, InterviewsUnavailableError } = await import("../src/server/interviews-store");

const blank = { error: "", message: "" };
const NADIA = { role: "staff", employeeId: "BS-1001" } as const;
const valid = { company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen" };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  getSession.mockResolvedValue(NADIA);
  add.mockImplementation(async (session, input) => ({
    id: "new", employeeId: session.role === "staff" ? session.employeeId : "?", ...input, feedback: "",
  }));
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
