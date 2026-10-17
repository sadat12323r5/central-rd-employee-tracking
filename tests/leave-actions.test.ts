import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaveRecord } from "@/data/employees";
import { categoryForWorkingDays, countWorkingDays } from "@/domain/leave";
import type { LeaveInput } from "@/server/leave-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, record, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  record: vi.fn<(session: SessionIdentity, employeeId: string, input: LeaveInput) => Promise<LeaveRecord>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by leave-store.test.ts and, against the shared project, leave-rls.test.ts.
vi.mock("../src/server/leave-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/leave-store")>()),
  leaveStore: { record, listFor: vi.fn() },
}));

const { recordLeaveAction } = await import("../src/server/leave-actions");
const {
  LeaveCalendarMissingError, LeaveEmployeeNotFoundError, LeaveForbiddenError, LeaveOverlapError, LeaveUnavailableError, LeaveValidationFailedError,
} = await import("../src/server/leave-store");

const blank = { error: "", message: "" };
const NADIA = { role: "staff", employeeId: "BS-1001" } as const;
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const MARCH = { startDate: "2026-03-02", endDate: "2026-03-05" };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

// A stand-in for the store's counting: the 2026 weekends plus Independence Day (26 Mar), as the provisional calendar has.
const policy = { holidays: new Set(["2026-03-26"]), supportedYearStart: 2026, supportedYearEnd: 2026 };
const stored = (employeeId: string, input: LeaveInput): LeaveRecord => {
  const workingDays = countWorkingDays(input.startDate, input.endDate, policy);
  return {
    id: "new", employeeId, ...input, workingDays, category: categoryForWorkingDays(workingDays).category,
    calendarVersionId: "cal-v3", cancelledAt: null, createdAt: "2026-10-17T00:00:00Z",
  };
};

beforeEach(() => {
  getSession.mockResolvedValue(NADIA);
  record.mockImplementation(async (_session, employeeId, input) => stored(employeeId, input));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.clearAllMocks());

describe("recordLeaveAction", () => {
  it("records Staff own leave and reports the working days and category", async () => {
    expect(await recordLeaveAction(blank, form(MARCH))).toEqual({ error: "", message: "Leave recorded: 4 working days (4–14 working days)." });
    expect(record).toHaveBeenCalledWith(NADIA, "BS-1001", MARCH);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("reports a holiday-excluded count: 25–27 Mar 2026 is 2 working days (1–3)", async () => {
    expect((await recordLeaveAction(blank, form({ startDate: "2026-03-25", endDate: "2026-03-27" }))).message)
      .toBe("Leave recorded: 2 working days (1–3 working days).");
  });

  it("says \"1 working day\" for a single day", async () => {
    expect((await recordLeaveAction(blank, form({ startDate: "2026-03-02", endDate: "2026-03-02" }))).message)
      .toBe("Leave recorded: 1 working day (1–3 working days).");
  });

  it("accepts a Staff form naming the session's own employee", async () => {
    expect((await recordLeaveAction(blank, form({ ...MARCH, employeeId: "BS-1001" }))).error).toBe("");
    expect(record).toHaveBeenCalledWith(NADIA, "BS-1001", MARCH);
  });

  it.each([["employeeId"], ["employee_id"]])("refuses a Staff form whose %s names someone else, without a store call", async name => {
    expect(await recordLeaveAction(blank, form({ ...MARCH, [name]: "BS-1002" }))).toEqual({ error: "You can only record your own leave.", message: "" });
    expect(record).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("records for the form's employee for an Administrator (anyone) and a manager (in scope)", async () => {
    getSession.mockResolvedValue(ADMIN);
    expect((await recordLeaveAction(blank, form({ ...MARCH, employeeId: " BS-1003 " }))).error).toBe("");
    expect(record).toHaveBeenLastCalledWith(ADMIN, "BS-1003", MARCH);
    getSession.mockResolvedValue(MANAGER);
    expect((await recordLeaveAction(blank, form({ ...MARCH, employeeId: "BS-1002" }))).error).toBe("");
    expect(record).toHaveBeenLastCalledWith(MANAGER, "BS-1002", MARCH);
  });

  it("records a manager's own leave from My record with the form's (own) employee", async () => {
    getSession.mockResolvedValue(MANAGER);
    expect((await recordLeaveAction(blank, form({ ...MARCH, employeeId: "BS-1009" }))).message).toBe("Leave recorded: 4 working days (4–14 working days).");
    expect(record).toHaveBeenCalledWith(MANAGER, "BS-1009", MARCH);
  });

  it("refuses a manager out of scope with the department message", async () => {
    getSession.mockResolvedValue(MANAGER);
    record.mockRejectedValue(new LeaveForbiddenError());
    expect(await recordLeaveAction(blank, form({ ...MARCH, employeeId: "BS-1003" })))
      .toEqual({ error: "You can only record leave for employees in your department.", message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ employeeId: "" }], [{ employeeId: "1003" }]])("requires a valid Employee ID for an Administrator or manager (%o)", async extra => {
    getSession.mockResolvedValue(ADMIN);
    const result = await recordLeaveAction(blank, form({ ...MARCH, ...extra }));
    expect(result.error).toMatch(/employee/i);
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses without a session", async () => {
    getSession.mockResolvedValue(null);
    expect((await recordLeaveAction(blank, form(MARCH))).error).toMatch(/sign in/i);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ["an impossible date", { startDate: "2026-02-30", endDate: "2026-03-02" }],
    ["a missing end date", { startDate: "2026-03-02" }],
    ["a non-ISO date", { startDate: "02/03/2026", endDate: "2026-03-05" }],
  ])("rejects %s without a store call", async (_name, fields) => {
    expect(await recordLeaveAction(blank, form(fields as Record<string, string>)))
      .toEqual({ error: "Enter real dates for the start and end of the leave.", message: "" });
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a reversed range without a store call", async () => {
    expect(await recordLeaveAction(blank, form({ startDate: "2026-03-05", endDate: "2026-03-02" })))
      .toEqual({ error: "The end date must be on or after the start date.", message: "" });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ["overlap", new LeaveOverlapError({ startDate: "2026-03-02", endDate: "2026-03-05" }), "This overlaps leave already recorded from 2 Mar 2026 to 5 Mar 2026."],
    ["a year outside the calendar", new LeaveValidationFailedError("UNSUPPORTED_YEAR", { year: 2027, supportedYearStart: 2026, supportedYearEnd: 2026 }),
      "The holiday calendar covers 2026 only, so leave in 2027 can't be counted yet."],
    ["a year outside a two-year calendar", new LeaveValidationFailedError("UNSUPPORTED_YEAR", { year: 2028, supportedYearStart: 2026, supportedYearEnd: 2027 }),
      "The holiday calendar covers 2026–2027, so leave in 2028 can't be counted yet."],
    ["zero working days", new LeaveValidationFailedError("ZERO_WORKING_DAYS"), "This period has no working days (only weekends and holidays)."],
    ["an invalid date from the store", new LeaveValidationFailedError("INVALID_DATE"), "Enter real dates for the start and end of the leave."],
    ["a reversed range from the store", new LeaveValidationFailedError("REVERSED_RANGE"), "The end date must be on or after the start date."],
    ["no calendar", new LeaveCalendarMissingError(), "No holiday calendar is loaded yet. Ask the Administrator to load it."],
    ["an unknown employee", new LeaveEmployeeNotFoundError(), "No employee has this Employee ID."],
    ["the database being down", new LeaveUnavailableError(), "Leave is temporarily unavailable. Nothing was saved."],
  ])("maps %s to its message and saves nothing", async (_name, error, message) => {
    record.mockRejectedValue(error);
    expect(await recordLeaveAction(blank, form(MARCH))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error", async () => {
    const bug = new TypeError("bug");
    record.mockRejectedValue(bug);
    await expect(recordLeaveAction(blank, form(MARCH))).rejects.toBe(bug);
  });
});
