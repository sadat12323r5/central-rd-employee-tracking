import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, transfer, listFor, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn(),
  transfer: vi.fn(),
  listFor: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
vi.mock("../src/server/departments-store", () => ({ departmentsStore: { listFor } }));
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { transfer },
}));

const { transferEmployeeAction } = await import("../src/server/employee-actions");
const {
  EmployeesUnavailableError, TransferDepartmentError, TransferForbiddenError, TransferInvalidError, TransferNotFoundError,
  TransferOpenAssignmentError, TransferSameDepartmentError,
} = await import("../src/server/employees-store");

const P = "de9a0000-0000-4000-8000-0000000000e1";
const C = "de9a0000-0000-4000-8000-0000000000e2";
const blank = { error: "", message: "" };
const admin = { role: "admin" } as const;
const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const valid = () => form({ employeeId: "BS-1003", toDepartmentId: C });

describe("transferEmployeeAction (Story 4.8)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(manager);
    transfer.mockResolvedValue({ employeeId: "BS-1003", name: "Meera Das", fromDepartmentId: P, toDepartmentId: C });
    listFor.mockResolvedValue([
      { id: P, name: "Parent Team", parentId: null, managerUserId: manager.userId, managerEmployeeId: "BS-1002" },
      { id: C, name: "Child Team", parentId: P, managerUserId: null, managerEmployeeId: null },
    ]);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it.each([[{ role: "staff", employeeId: "BS-1003" }], [null]])("rejects session %j without touching the store", async session => {
    getSession.mockResolvedValue(session);
    expect(await transferEmployeeAction(blank, valid())).toEqual({ error: "Only an Administrator or a department manager can move employees.", message: "" });
    expect(transfer).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([[manager], [admin]])("moves the employee for %j, revalidates and names the destination", async session => {
    getSession.mockResolvedValue(session);
    const result = await transferEmployeeAction(blank, form({ employeeId: " BS-1003 ", toDepartmentId: C, actor: "someone-else" }));
    expect(result).toEqual({ error: "", message: "Meera Das was moved to Child Team." });
    expect(transfer).toHaveBeenCalledWith(session, "BS-1003", C);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("keeps the success when the department name cannot be read", async () => {
    listFor.mockRejectedValue(new Error("down"));
    expect(await transferEmployeeAction(blank, valid())).toEqual({ error: "", message: "Meera Das was moved to the selected department." });
  });

  it.each([
    [{ employeeId: "BS-1", toDepartmentId: C }, "Employee not found."],
    [{ toDepartmentId: C }, "Employee not found."],
    [{ employeeId: "BS-1003", toDepartmentId: "not-a-uuid" }, "Choose a department from the list."],
    [{ employeeId: "BS-1003" }, "Choose a department from the list."],
  ])("validates the form %j before the store", async (fields, message) => {
    expect(await transferEmployeeAction(blank, form(fields))).toEqual({ error: message, message: "" });
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([
    [new TransferForbiddenError(), "You can only move people between departments you manage."],
    [new TransferNotFoundError(), "Employee not found."],
    [new TransferDepartmentError(), "Choose a department from the list."],
    [new TransferSameDepartmentError(), "This employee is already in that department."],
    [new TransferOpenAssignmentError(), "Close this employee's open assignment before moving them."],
    [new TransferInvalidError(["toDepartmentId"]), "Choose a department from the list."],
    [new EmployeesUnavailableError(), "Employee records are temporarily unavailable. Nothing was changed."],
    [new Error("boom"), "Employee records are temporarily unavailable. Nothing was changed."],
  ])("maps %s to its message, without revalidating", async (error, message) => {
    transfer.mockRejectedValue(error);
    expect(await transferEmployeeAction(blank, valid())).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
