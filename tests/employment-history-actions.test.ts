import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmploymentHistoryInput } from "@/domain/employment-history";
import type { EmploymentHistoryEntry } from "@/server/employment-history-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, add, update, remove, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  add: vi.fn<(session: SessionIdentity, employeeId: string, input: EmploymentHistoryInput) => Promise<EmploymentHistoryEntry>>(),
  update: vi.fn<(session: SessionIdentity, id: string, input: EmploymentHistoryInput) => Promise<EmploymentHistoryEntry>>(),
  remove: vi.fn<(session: SessionIdentity, id: string) => Promise<EmploymentHistoryEntry>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by employment-history-store.test.ts and, against the shared project, employment-history-rls.test.ts.
vi.mock("../src/server/employment-history-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employment-history-store")>()),
  employmentHistoryStore: { add, update, remove, listFor: vi.fn() },
}));

const { addEmploymentHistoryAction, updateEmploymentHistoryAction, removeEmploymentHistoryAction } = await import("../src/server/employment-history-actions");
const {
  EmploymentHistoryForbiddenError, EmploymentHistoryInvalidError, EmploymentHistoryNotFoundError, EmploymentHistoryRemovedError,
  EmploymentHistoryUnavailableError,
} = await import("../src/server/employment-history-store");

const blank = { error: "", message: "" };
const NADIA = { role: "staff", employeeId: "BS-1001" } as const;
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const valid = { role: "QA Engineer", employer: "Brain Station 23", period: "2024 – Present", detail: "Test automation." };
const ID = "e4b10000-0000-4000-8000-000010010000";

const OWN_ONLY = "You can only change your own employment history.";
const FORBIDDEN = "You can only change employment history for yourself or for employees in your department.";
const UNAVAILABLE = "Employment history could not be reached, so nothing was saved. Please try again in a moment.";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const stored = (employeeId: string, id = ID): EmploymentHistoryEntry => ({
  id, employeeId, role: valid.role, company: valid.employer, period: valid.period, detail: valid.detail, createdAt: "2026-10-15T00:00:00Z",
});

beforeEach(() => {
  getSession.mockResolvedValue(NADIA);
  add.mockImplementation(async (_session, employeeId) => stored(employeeId, "new"));
  update.mockImplementation(async (_session, id) => stored("BS-1001", id));
  remove.mockImplementation(async (_session, id) => stored("BS-1001", id));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.clearAllMocks());

describe("addEmploymentHistoryAction", () => {
  it("saves a Staff entry for the session's own employee and says so", async () => {
    expect(await addEmploymentHistoryAction(blank, form(valid))).toEqual({ error: "", message: "Employment entry added." });
    expect(add).toHaveBeenCalledWith(NADIA, "BS-1001", valid);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("accepts a Staff form naming the session's own employee", async () => {
    expect((await addEmploymentHistoryAction(blank, form({ ...valid, employeeId: "BS-1001" }))).message).toBe("Employment entry added.");
    expect(add).toHaveBeenCalledWith(NADIA, "BS-1001", valid);
  });

  it.each([["employeeId"], ["employee_id"]])("refuses a Staff form whose %s names someone else, without a store call", async name => {
    expect(await addEmploymentHistoryAction(blank, form({ ...valid, [name]: "BS-1002" }))).toEqual({ error: OWN_ONLY, message: "" });
    expect(add).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("saves for the form's employee for an Administrator and a manager", async () => {
    getSession.mockResolvedValue(ADMIN);
    expect((await addEmploymentHistoryAction(blank, form({ ...valid, employeeId: " BS-1003 " }))).message).toBe("Employment entry added.");
    expect(add).toHaveBeenLastCalledWith(ADMIN, "BS-1003", valid);
    getSession.mockResolvedValue(MANAGER);
    expect((await addEmploymentHistoryAction(blank, form({ ...valid, employeeId: "BS-1002" }))).message).toBe("Employment entry added.");
    expect(add).toHaveBeenLastCalledWith(MANAGER, "BS-1002", valid);
  });

  it.each([[{}], [{ employeeId: "" }], [{ employeeId: "1003" }]])("requires a valid Employee ID for an Administrator or manager (%o)", async extra => {
    getSession.mockResolvedValue(ADMIN);
    const result = await addEmploymentHistoryAction(blank, form({ ...valid, ...extra }));
    expect(result.error).toMatch(/employee/i);
    expect(add).not.toHaveBeenCalled();
  });

  it("trims and collapses whitespace, and defaults a missing detail to empty", async () => {
    await addEmploymentHistoryAction(blank, form({ role: "  QA   Engineer ", employer: " Brain  Station 23 ", period: " 2024  – Present " }));
    expect(add).toHaveBeenCalledWith(NADIA, "BS-1001", { role: "QA Engineer", employer: "Brain Station 23", period: "2024 – Present", detail: "" });
  });

  it.each([
    ["a missing role", { ...valid, role: "" }, /role/i],
    ["a blank employer", { ...valid, employer: "   " }, /employer/i],
    ["a missing period", { role: valid.role, employer: valid.employer }, /period/i],
    ["a period without a year", { ...valid, period: "Present" }, /year/i],
    ["a role over 200 characters", { ...valid, role: "x".repeat(201) }, /role.*200 characters/],
    ["an employer over 200 characters", { ...valid, employer: "x".repeat(201) }, /employer.*200 characters/],
    ["a period over 60 characters", { ...valid, period: `2020 ${"x".repeat(60)}` }, /period.*60 characters/],
    ["a detail over 2000 characters", { ...valid, detail: "x".repeat(2001) }, /detail.*2000 characters/],
  ])("rejects %s, naming the field, without a store call", async (_name, fields, message) => {
    const result = await addEmploymentHistoryAction(blank, form(fields as Record<string, string>));
    expect(result.error).toMatch(message);
    expect(result.message).toBe("");
    expect(add).not.toHaveBeenCalled();
  });

  it("asks a signed-out caller to sign in, without a store call", async () => {
    getSession.mockResolvedValue(null);
    expect((await addEmploymentHistoryAction(blank, form(valid))).error).toMatch(/sign in/i);
    expect(add).not.toHaveBeenCalled();
  });

  it("maps the store's refusals and never reports a failed write as saved", async () => {
    const cases: [Error, string | RegExp][] = [
      [new EmploymentHistoryForbiddenError(), FORBIDDEN],
      [new EmploymentHistoryInvalidError(["period"]), /period/],
      [new EmploymentHistoryInvalidError(["entry"]), /Check the employment entry/],
      [new EmploymentHistoryUnavailableError(), UNAVAILABLE],
    ];
    for (const [error, message] of cases) {
      add.mockRejectedValueOnce(error);
      const result = await addEmploymentHistoryAction(blank, form(valid));
      expect(result.message).toBe("");
      if (typeof message === "string") expect(result.error).toBe(message);
      else expect(result.error).toMatch(message);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors", async () => {
    add.mockRejectedValueOnce(new TypeError("bug"));
    await expect(addEmploymentHistoryAction(blank, form(valid))).rejects.toThrow("bug");
  });
});

describe("updateEmploymentHistoryAction", () => {
  it("saves the entry by id; the employee is never taken from the form", async () => {
    expect(await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid }))).toEqual({ error: "", message: "Employment entry saved." });
    expect(update).toHaveBeenCalledWith(NADIA, ID, valid);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("refuses a Staff form naming someone else, without a store call", async () => {
    expect(await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid, employeeId: "BS-1002" }))).toEqual({ error: OWN_ONLY, message: "" });
    expect(update).not.toHaveBeenCalled();
  });

  it("lets an Administrator and a manager save (the store checks the entry's employee)", async () => {
    for (const session of [ADMIN, MANAGER]) {
      getSession.mockResolvedValue(session);
      expect((await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid, employeeId: "BS-1002" }))).message).toBe("Employment entry saved.");
      expect(update).toHaveBeenLastCalledWith(session, ID, valid);
    }
  });

  it.each([["", /entry/i], ["not-a-uuid", /valid employment entry/i]])("rejects a bad id %j", async (id, message) => {
    expect((await updateEmploymentHistoryAction(blank, form({ id, ...valid }))).error).toMatch(message);
    expect(update).not.toHaveBeenCalled();
  });

  it("validates the fields like add", async () => {
    expect((await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid, period: "Now" }))).error).toMatch(/year/);
    expect(update).not.toHaveBeenCalled();
  });

  it("maps not found, removed, forbidden and unavailable", async () => {
    const cases: [Error, string][] = [
      [new EmploymentHistoryNotFoundError(), "That employment entry was not found."],
      [new EmploymentHistoryRemovedError(), "That entry was removed and can no longer be changed."],
      [new EmploymentHistoryForbiddenError(), FORBIDDEN],
      [new EmploymentHistoryUnavailableError(), UNAVAILABLE],
    ];
    for (const [error, message] of cases) {
      update.mockRejectedValueOnce(error);
      expect(await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid }))).toEqual({ error: message, message: "" });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("asks a signed-out caller to sign in", async () => {
    getSession.mockResolvedValue(null);
    expect((await updateEmploymentHistoryAction(blank, form({ id: ID, ...valid }))).error).toMatch(/sign in/i);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("removeEmploymentHistoryAction", () => {
  it("removes the entry and says it is kept", async () => {
    expect(await removeEmploymentHistoryAction(blank, form({ id: ID }))).toEqual({
      error: "", message: "Employment entry removed. It is kept in the record's history.",
    });
    expect(remove).toHaveBeenCalledWith(NADIA, ID);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("refuses a Staff form naming someone else, and a bad id, without a store call", async () => {
    expect((await removeEmploymentHistoryAction(blank, form({ id: ID, employeeId: "BS-1002" }))).error).toBe(OWN_ONLY);
    expect((await removeEmploymentHistoryAction(blank, form({ id: "x" }))).error).toMatch(/valid employment entry/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("maps a second removal to the removed message", async () => {
    remove.mockRejectedValueOnce(new EmploymentHistoryRemovedError());
    expect((await removeEmploymentHistoryAction(blank, form({ id: ID }))).error).toBe("That entry was removed and can no longer be changed.");
  });

  it("asks a signed-out caller to sign in", async () => {
    getSession.mockResolvedValue(null);
    expect((await removeEmploymentHistoryAction(blank, form({ id: ID }))).error).toMatch(/sign in/i);
    expect(remove).not.toHaveBeenCalled();
  });
});
