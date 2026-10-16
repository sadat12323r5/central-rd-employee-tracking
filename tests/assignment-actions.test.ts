import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assignment, AssignmentInput } from "@/server/assignments-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, create, updateNote, close, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  create: vi.fn<(session: SessionIdentity, employeeId: string, input: AssignmentInput) => Promise<Assignment>>(),
  updateNote: vi.fn<(session: SessionIdentity, id: string, note: string) => Promise<Assignment>>(),
  close: vi.fn<(session: SessionIdentity, id: string, completionDate: string) => Promise<Assignment>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by assignments-store.test.ts and, against the shared project, assignments-rls.test.ts.
vi.mock("../src/server/assignments-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/assignments-store")>()),
  assignmentsStore: { create, updateNote, close, listFor: vi.fn() },
}));

const actions = await import("../src/server/assignment-actions");
const { closeAssignmentAction, createAssignmentAction, updateAssignmentNoteAction } = actions;
const {
  AssignmentAlreadyOpenError, AssignmentClosedError, AssignmentEmployeeNotFoundError, AssignmentInvalidError, AssignmentNoDepartmentError,
  AssignmentsForbiddenError, AssignmentsUnavailableError,
} = await import("../src/server/assignments-store");

const blank = { error: "", message: "" };
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const STAFF = { role: "staff", employeeId: "BS-1001" } as const;
const ID = "5e000000-0000-4000-8000-000000000001";

const FORBIDDEN = "Only the Administrator or a manager over this employee's department can manage assignments.";
const ALREADY_OPEN = "This employee already has an open assignment. Close it first.";
const CLOSED = "This assignment is closed and can't be changed.";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const valid = { employeeId: "BS-1001", client: " Northwind (fictional) ", projectName: "Portal rebuild", role: "Developer", allocation: "60", startDate: "2026-10-01" };
const sample: Assignment = {
  id: ID, employeeId: "BS-1001", departmentId: "d-1", client: "Northwind (fictional)", projectName: "Portal rebuild", role: "Developer",
  allocation: 60, startDate: "2026-10-01", latestUpdate: "", status: "open", completionDate: null, createdAt: "2026-10-14T00:00:00Z", closedAt: null,
  provenance: "assignment",
};

beforeEach(() => {
  getSession.mockResolvedValue(ADMIN);
  create.mockResolvedValue(sample);
  updateNote.mockResolvedValue(sample);
  close.mockResolvedValue({ ...sample, status: "closed", completionDate: "2026-10-10" });
});
afterEach(() => vi.clearAllMocks());

describe("assignment actions module", () => {
  it("exports exactly the create, note and close actions (no delete)", () => {
    expect(Object.keys(actions).sort()).toEqual(["closeAssignmentAction", "createAssignmentAction", "updateAssignmentNoteAction"]);
  });
});

describe("session gate", () => {
  const calls = [
    () => createAssignmentAction(blank, form(valid)),
    () => updateAssignmentNoteAction(blank, form({ id: ID, note: "x" })),
    () => closeAssignmentAction(blank, form({ id: ID, completionDate: "2026-10-10" })),
  ];
  for (const [label, session] of [["a staff session", STAFF], ["no session", null]] as const) {
    it(`refuses ${label} before validating or touching the store`, async () => {
      getSession.mockResolvedValue(session);
      for (const call of calls) expect(await call()).toEqual({ error: FORBIDDEN, message: "" });
      // Even an invalid form gets the forbidden message: the session is checked first.
      expect(await createAssignmentAction(blank, form({}))).toEqual({ error: FORBIDDEN, message: "" });
      expect(create).not.toHaveBeenCalled();
      expect(updateNote).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("lets admin and manager sessions through to the store with their own session", async () => {
    for (const session of [ADMIN, MANAGER]) {
      getSession.mockResolvedValue(session);
      expect(await createAssignmentAction(blank, form(valid))).toEqual({ error: "", message: "Assignment created." });
      expect(create).toHaveBeenLastCalledWith(session, "BS-1001", {
        client: "Northwind (fictional)", projectName: "Portal rebuild", role: "Developer", allocation: 60, startDate: "2026-10-01",
      });
    }
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });
});

describe("createAssignmentAction", () => {
  it("never passes a department from the form", async () => {
    await createAssignmentAction(blank, form({ ...valid, departmentId: "d-evil", department_id: "d-evil" }));
    expect(create.mock.calls[0][2]).not.toHaveProperty("departmentId");
    expect(create.mock.calls[0][2]).not.toHaveProperty("department_id");
  });

  it("validates every field with zod before the store", async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ client: "  " }, /client/],
      [{ projectName: "" }, /project name/],
      [{ role: "x".repeat(201) }, /role/],
      [{ allocation: "101" }, /0 to 100/],
      [{ allocation: "-1" }, /0 to 100/],
      [{ allocation: "12.5" }, /0 to 100/],
      [{ allocation: "abc" }, /0 to 100/],
      [{ allocation: "" }, /0 to 100/],
      [{ startDate: "2026-02-30" }, /valid start date/],
      [{ startDate: "" }, /start date/],
      [{ employeeId: "1001" }, /existing employee/],
    ];
    for (const [change, message] of cases) {
      const result = await createAssignmentAction(blank, form({ ...valid, ...change }));
      expect(result.error).toMatch(message);
      expect(result.message).toBe("");
    }
    const missing = new FormData();
    expect((await createAssignmentAction(blank, missing)).error).not.toBe("");
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts allocation 0 and 100", async () => {
    for (const allocation of ["0", "100"]) expect((await createAssignmentAction(blank, form({ ...valid, allocation }))).error).toBe("");
  });

  it("maps the store's refusals to their messages and reports nothing as saved", async () => {
    const cases: [Error, string][] = [
      [new AssignmentAlreadyOpenError(), ALREADY_OPEN],
      [new AssignmentsForbiddenError(), FORBIDDEN],
      [new AssignmentNoDepartmentError(), "Place this employee in a department first."],
      [new AssignmentEmployeeNotFoundError("BS-1001"), "Choose an existing employee."],
      [new AssignmentInvalidError("Enter a valid start date."), "Enter a valid start date."],
    ];
    for (const [error, message] of cases) {
      create.mockRejectedValueOnce(error);
      expect(await createAssignmentAction(blank, form(valid))).toEqual({ error: message, message: "" });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports unavailability (logged) and rethrows unknown errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValueOnce(new AssignmentsUnavailableError());
    expect(await createAssignmentAction(blank, form(valid))).toEqual({ error: "Assignments are temporarily unavailable. Nothing was saved.", message: "" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    const bug = new TypeError("bug");
    create.mockRejectedValueOnce(bug);
    await expect(createAssignmentAction(blank, form(valid))).rejects.toBe(bug);
  });
});

describe("updateAssignmentNoteAction", () => {
  it("saves the trimmed note by assignment id only (the employee comes from the row)", async () => {
    getSession.mockResolvedValue(MANAGER);
    expect(await updateAssignmentNoteAction(blank, form({ id: ID, note: "  Demo delivered. ", employeeId: "BS-2000" })))
      .toEqual({ error: "", message: "Latest update saved." });
    expect(updateNote).toHaveBeenCalledWith(MANAGER, ID, "Demo delivered.");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("allows an empty note and refuses one over 2000 characters or a bad id", async () => {
    expect((await updateAssignmentNoteAction(blank, form({ id: ID, note: "" }))).error).toBe("");
    expect((await updateAssignmentNoteAction(blank, form({ id: ID, note: "x".repeat(2001) }))).error).toMatch(/2000/);
    expect((await updateAssignmentNoteAction(blank, form({ id: "not-a-uuid", note: "x" }))).error).toMatch(/existing assignment/);
    expect(updateNote).toHaveBeenCalledTimes(1);
  });

  it("maps a closed assignment and an out-of-scope one", async () => {
    updateNote.mockRejectedValueOnce(new AssignmentClosedError());
    expect(await updateAssignmentNoteAction(blank, form({ id: ID, note: "x" }))).toEqual({ error: CLOSED, message: "" });
    updateNote.mockRejectedValueOnce(new AssignmentsForbiddenError());
    expect(await updateAssignmentNoteAction(blank, form({ id: ID, note: "x" }))).toEqual({ error: FORBIDDEN, message: "" });
  });
});

describe("closeAssignmentAction", () => {
  it("closes by assignment id with a calendar completion date", async () => {
    expect(await closeAssignmentAction(blank, form({ id: ID, completionDate: "2026-10-10" }))).toEqual({ error: "", message: "Assignment closed." });
    expect(close).toHaveBeenCalledWith(ADMIN, ID, "2026-10-10");
  });

  it("refuses an invalid or missing completion date before the store", async () => {
    for (const completionDate of ["2026-13-01", "10/10/2026", ""]) {
      expect((await closeAssignmentAction(blank, form({ id: ID, completionDate }))).error).toMatch(/completion date/);
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("maps a date before the start, an already closed assignment and forbidden", async () => {
    close.mockRejectedValueOnce(new AssignmentInvalidError("The completion date can't be before the start date."));
    expect(await closeAssignmentAction(blank, form({ id: ID, completionDate: "2026-01-01" })))
      .toEqual({ error: "The completion date can't be before the start date.", message: "" });
    close.mockRejectedValueOnce(new AssignmentClosedError());
    expect(await closeAssignmentAction(blank, form({ id: ID, completionDate: "2026-10-10" }))).toEqual({ error: CLOSED, message: "" });
    close.mockRejectedValueOnce(new AssignmentsForbiddenError());
    expect(await closeAssignmentAction(blank, form({ id: ID, completionDate: "2026-10-10" }))).toEqual({ error: FORBIDDEN, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
