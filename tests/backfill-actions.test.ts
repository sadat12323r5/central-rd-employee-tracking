import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfilledProject, BackfillInput } from "@/server/backfilled-project-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, add, edit, withdraw, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  add: vi.fn<(session: SessionIdentity, input: BackfillInput) => Promise<BackfilledProject>>(),
  edit: vi.fn<(session: SessionIdentity, id: string, input: BackfillInput) => Promise<BackfilledProject>>(),
  withdraw: vi.fn<(session: SessionIdentity, id: string) => Promise<BackfilledProject>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by backfilled-project-store.test.ts and, live, backfill-rls.test.ts.
vi.mock("../src/server/backfilled-project-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/backfilled-project-store")>()),
  backfilledProjectStore: { add, edit, withdraw, listFor: vi.fn(), departmentOptions: vi.fn() },
}));

const actions = await import("../src/server/backfill-actions");
const { addBackfillAction, editBackfillAction, withdrawBackfillAction } = actions;
const {
  BackfillDepartmentError, BackfillForbiddenError, BackfillInvalidError, BackfillNoEmployeeError, BackfillUnavailableError, BackfillWithdrawnError,
} = await import("../src/server/backfilled-project-store");

const blank = { error: "", message: "" };
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const STAFF = { role: "staff", employeeId: "BS-1001" } as const;
const ID = "bf000000-0000-4000-8000-000000000001";
const DEPT = "de9a0000-0000-4000-8000-000000000002";
const NO_EMPLOYEE = "Only an employee can add their own past projects.";
const FORBIDDEN = "Only the employee who added this past project can change it.";
const WITHDRAWN = "This past project was withdrawn and can't be changed.";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const valid = {
  departmentId: DEPT, client: " Harbour Systems (fictional) ", projectName: " Data migration ", completionDate: "2025-12-15",
  outcome: "  Migrated 40 services.  ",
};
const parsed: BackfillInput = {
  departmentId: DEPT, client: "Harbour Systems (fictional)", projectName: "Data migration", completionDate: "2025-12-15", outcome: "Migrated 40 services.",
};
const sample: BackfilledProject = {
  id: ID, employeeId: "BS-1001", departmentId: DEPT, departmentName: "Central R&D", client: "Harbour Systems (fictional)", projectName: "Data migration",
  completionDate: "2025-12-15", outcome: "Migrated 40 services.", status: "active", createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z", withdrawnAt: null, provenance: "backfilled",
};

beforeEach(() => {
  getSession.mockResolvedValue(STAFF);
  add.mockResolvedValue(sample);
  edit.mockResolvedValue(sample);
  withdraw.mockResolvedValue({ ...sample, status: "withdrawn", withdrawnAt: "2026-10-16T01:00:00Z" });
});
afterEach(() => vi.clearAllMocks());

describe("backfill actions module", () => {
  it("exports exactly the add, edit and withdraw actions (no delete)", () => {
    expect(Object.keys(actions).sort()).toEqual(["addBackfillAction", "editBackfillAction", "withdrawBackfillAction"]);
  });
});

describe("session gate", () => {
  for (const [label, session] of [["no session", null], ["an Administrator session without an employee record", ADMIN]] as const) {
    it(`refuses ${label} before validating or touching the store`, async () => {
      getSession.mockResolvedValue(session);
      expect(await addBackfillAction(blank, form(valid))).toEqual({ error: NO_EMPLOYEE, message: "" });
      expect(await editBackfillAction(blank, form({ ...valid, id: ID }))).toEqual({ error: NO_EMPLOYEE, message: "" });
      expect(await withdrawBackfillAction(blank, form({ id: ID }))).toEqual({ error: NO_EMPLOYEE, message: "" });
      // Even an invalid form gets the session message: the session is checked first.
      expect(await addBackfillAction(blank, form({}))).toEqual({ error: NO_EMPLOYEE, message: "" });
      expect(add).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }
});

describe("addBackfillAction", () => {
  for (const session of [STAFF, MANAGER]) {
    it(`adds for a ${session.role} session, trimmed, never taking the owner from the form`, async () => {
      getSession.mockResolvedValue(session);
      expect(await addBackfillAction(blank, form({ ...valid, employeeId: "BS-1003" }))).toEqual({ error: "", message: "Past project added." });
      expect(add).toHaveBeenCalledWith(session, parsed);
      expect(revalidatePath).toHaveBeenCalledWith("/");
    });
  }

  it("validates with zod before the store", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ ...valid, departmentId: "" }, "Choose a department from the list."],
      [{ ...valid, departmentId: "not-a-uuid" }, "Choose a department from the list."],
      [{ ...valid, client: "   " }, "Enter the client."],
      [{ ...valid, client: "x".repeat(201) }, "Keep the client to 200 characters or fewer."],
      [{ ...valid, projectName: "" }, "Enter the project name."],
      [{ ...valid, projectName: "x".repeat(201) }, "Keep the project name to 200 characters or fewer."],
      [{ ...valid, completionDate: "2025-02-30" }, "Enter a valid completion date."],
      [{ ...valid, completionDate: "" }, "Enter a valid completion date."],
      [{ ...valid, outcome: "  " }, "Enter the outcome."],
      [{ ...valid, outcome: "x".repeat(2001) }, "Keep the outcome to 2000 characters or fewer."],
    ];
    for (const [fields, message] of cases) expect(await addBackfillAction(blank, form(fields)), message).toEqual({ error: message, message: "" });
    const { outcome: _, ...missing } = valid;
    expect(await addBackfillAction(blank, form(missing))).toEqual({ error: "Enter the outcome.", message: "" });
    expect(add).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("counts a CRLF line break as one character, as the textarea does", async () => {
    // 1000 line breaks + 1000 letters: 2000 characters in the textarea, 3000 if CRLF were counted twice.
    const outcome = "a\r\n".repeat(1000).trimEnd() + "a";
    expect(await addBackfillAction(blank, form({ ...valid, outcome }))).toEqual({ error: "", message: "Past project added." });
    expect(add.mock.calls[0][1].outcome).toBe("a\n".repeat(1000).trimEnd() + "a");
    expect(add.mock.calls[0][1].outcome).not.toContain("\r");
  });

  it("maps the store's refusals to their messages and does not revalidate on them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [Error, string][] = [
      [new BackfillNoEmployeeError(), NO_EMPLOYEE],
      [new BackfillForbiddenError(), FORBIDDEN],
      [new BackfillDepartmentError(), "Choose a department from the list."],
      [new BackfillInvalidError("The completion date can't be in the future."), "The completion date can't be in the future."],
      [new BackfillUnavailableError(), "Past projects are temporarily unavailable. Nothing was saved."],
    ];
    for (const [error, message] of cases) {
      add.mockRejectedValueOnce(error);
      expect(await addBackfillAction(blank, form(valid))).toEqual({ error: message, message: "" });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("rethrows an unknown error", async () => {
    const bug = new TypeError("bug");
    add.mockRejectedValueOnce(bug);
    await expect(addBackfillAction(blank, form(valid))).rejects.toBe(bug);
  });
});

describe("editBackfillAction", () => {
  it("edits the named entry with the parsed values", async () => {
    expect(await editBackfillAction(blank, form({ ...valid, id: ` ${ID} ` }))).toEqual({ error: "", message: "Past project updated." });
    expect(edit).toHaveBeenCalledWith(STAFF, ID, parsed);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("refuses a missing or malformed id, and invalid values, before the store", async () => {
    expect(await editBackfillAction(blank, form(valid))).toEqual({ error: "Choose an existing past project.", message: "" });
    expect(await editBackfillAction(blank, form({ ...valid, id: "nope" }))).toEqual({ error: "Choose an existing past project.", message: "" });
    expect(await editBackfillAction(blank, form({ ...valid, id: ID, client: "" }))).toEqual({ error: "Enter the client.", message: "" });
    expect(edit).not.toHaveBeenCalled();
  });

  it("maps forbidden and withdrawn refusals; a withdrawn one refreshes the stale page", async () => {
    edit.mockRejectedValueOnce(new BackfillForbiddenError());
    expect(await editBackfillAction(blank, form({ ...valid, id: ID }))).toEqual({ error: FORBIDDEN, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
    edit.mockRejectedValueOnce(new BackfillWithdrawnError());
    expect(await editBackfillAction(blank, form({ ...valid, id: ID }))).toEqual({ error: WITHDRAWN, message: "" });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });
});

describe("withdrawBackfillAction", () => {
  it("withdraws the named entry; nothing else is read from the form", async () => {
    expect(await withdrawBackfillAction(blank, form({ id: ID, employeeId: "BS-1003", status: "active" }))).toEqual({ error: "", message: "Past project withdrawn." });
    expect(withdraw).toHaveBeenCalledWith(STAFF, ID);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("refuses a malformed id before the store", async () => {
    expect(await withdrawBackfillAction(blank, form({}))).toEqual({ error: "Choose an existing past project.", message: "" });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("maps the store's refusals", async () => {
    withdraw.mockRejectedValueOnce(new BackfillWithdrawnError());
    expect(await withdrawBackfillAction(blank, form({ id: ID }))).toEqual({ error: WITHDRAWN, message: "" });
    withdraw.mockRejectedValueOnce(new BackfillForbiddenError());
    getSession.mockResolvedValue(MANAGER);
    expect(await withdrawBackfillAction(blank, form({ id: ID }))).toEqual({ error: FORBIDDEN, message: "" });
  });
});
