import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeDetailsInput, NewEmployeeInput } from "@/domain/employee-input";
import type { Actor } from "@/server/auth";
import type { SessionIdentity } from "@/server/session";

const { getActor, create, updateDetails, revalidatePath } = vi.hoisted(() => ({
  getActor: vi.fn<() => Promise<Actor | null>>(),
  create: vi.fn<(session: SessionIdentity, input: NewEmployeeInput) => Promise<{ employeeId: string; name: string }>>(),
  updateDetails: vi.fn<(session: SessionIdentity, employeeId: string, input: EmployeeDetailsInput) => Promise<{ employeeId: string; name: string }>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getActor }));
// The Supabase store is covered by employees-store.test.ts and, against the shared project, employee-create-rls.test.ts.
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { create, updateDetails, listFor: vi.fn(), getFor: vi.fn(), isActive: vi.fn() },
}));

const { createEmployeeAction, updateEmployeeDetailsAction } = await import("../src/server/employee-actions");
const {
  EmployeeExistsError, EmployeeForbiddenError, EmployeeNotFoundError, EmployeesUnavailableError, EmployeeValidationError,
} = await import("../src/server/employees-store");

const blank = { error: "", message: "" };
const ADMIN: SessionIdentity = { role: "admin" };
const MANAGER: SessionIdentity = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" };
const STAFF: SessionIdentity = { role: "staff", employeeId: "BS-1001" };
const DEPT = "de9a0000-0000-4000-8000-000000000001";

const NOT_ALLOWED = "Only an Administrator or a department manager can add employees.";
const NO_DEPARTMENT = "Choose a department. Every employee needs one.";
const DUPLICATE_ID = "An employee with this Employee ID already exists.";
const DUPLICATE_EMAIL = "An employee with this email already exists.";
const FORBIDDEN = "You can only add employees to your own department or its sub-departments.";
const UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was added.";

const fields = {
  employeeId: "BS-4321", name: "  Tanvir   Hasan ", title: "QA Engineer", team: "Quality", email: " Tanvir.Hasan@Example.com ",
  departmentId: DEPT, manager: "Meera Das", office: "Dhaka HQ", employmentType: "Trainee", joinedOn: "2026-10-01",
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const without = (key: keyof typeof fields) => Object.fromEntries(Object.entries(fields).filter(([k]) => k !== key));

beforeEach(() => {
  getActor.mockResolvedValue({ identity: ADMIN, userId: "admin-user" });
  create.mockImplementation(async (_session, input) => ({ employeeId: input.employeeId, name: input.name }));
});
afterEach(() => vi.clearAllMocks());

describe("createEmployeeAction role gate", () => {
  it.each([["a staff session", STAFF], ["no session", null]] as const)("refuses %s before the store", async (_label, identity) => {
    getActor.mockResolvedValue(identity ? { identity, userId: "u" } : null);
    expect(await createEmployeeAction(blank, form(fields))).toEqual({ error: NOT_ALLOWED, message: "" });
    expect(create).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([["an admin", ADMIN], ["a manager", MANAGER]] as const)("lets %s add an employee", async (_label, identity) => {
    getActor.mockResolvedValue({ identity, userId: "u" });
    expect(await createEmployeeAction(blank, form(fields))).toEqual({ error: "", message: "Tanvir Hasan was added." });
    expect(create).toHaveBeenCalledWith(identity, {
      employeeId: "BS-4321", name: "Tanvir Hasan", title: "QA Engineer", team: "Quality", email: "tanvir.hasan@example.com",
      departmentId: DEPT, manager: "Meera Das", office: "Dhaka HQ", employmentType: "Trainee", joinedOn: "2026-10-01",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });
});

describe("createEmployeeAction validation", () => {
  it("passes an empty join date through (the store defaults it to today)", async () => {
    await createEmployeeAction(blank, form({ ...fields, joinedOn: "" }));
    expect(create.mock.calls[0][1].joinedOn).toBe("");
    await createEmployeeAction(blank, form(without("joinedOn")));
    expect(create.mock.calls[1][1].joinedOn).toBe("");
  });

  it("refuses a missing department with its own message", async () => {
    expect(await createEmployeeAction(blank, form({ ...fields, departmentId: "" }))).toEqual({ error: NO_DEPARTMENT, message: "" });
    expect(await createEmployeeAction(blank, form(without("departmentId")))).toEqual({ error: NO_DEPARTMENT, message: "" });
    // Even when other fields are also wrong.
    expect(await createEmployeeAction(blank, form({ ...fields, employeeId: "x", departmentId: " " }))).toEqual({ error: NO_DEPARTMENT, message: "" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a department id that is not a UUID with the department message, before the store", async () => {
    for (const departmentId of ["not-a-uuid", "1", "de9a0000-0000-4000-8000-0000000000u1"]) {
      expect(await createEmployeeAction(blank, form({ ...fields, departmentId }))).toEqual({ error: NO_DEPARTMENT, message: "" });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [{ employeeId: "BS-12" }, /Employee ID/],
    [{ employeeId: "bs-1234" }, /Employee ID/],
    [{ name: "   " }, /name/],
    [{ title: "x".repeat(121) }, /job title/],
    [{ team: "" }, /team/],
    [{ email: "not-an-email" }, /email/],
    [{ email: `${"a".repeat(250)}@example.com` }, /email/],
    [{ manager: "" }, /reporting manager/],
    [{ office: "" }, /office/],
    [{ employmentType: "Contractor" }, /employment type/],
    [{ employmentType: "" }, /employment type/],
    [{ joinedOn: "2026-02-30" }, /join date/],
    [{ joinedOn: "01/10/2026" }, /join date/],
  ] as [Record<string, string>, RegExp][])("refuses %j with a message naming the field", async (changes, message) => {
    const result = await createEmployeeAction(blank, form({ ...fields, ...changes }));
    expect(result.message).toBe("");
    expect(result.error).toMatch(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a missing required field", async () => {
    expect((await createEmployeeAction(blank, form(without("office")))).error).toMatch(/office/);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores forged extra fields", async () => {
    await createEmployeeAction(blank, form({ ...fields, auth_user_id: "aaaa0000-0000-4000-8000-0000000000ff", status: "On project", archived_at: "2026-01-01" }));
    const input = create.mock.calls[0][1];
    expect(Object.keys(input).sort()).toEqual(Object.keys(fields).sort());
  });
});

describe("createEmployeeAction store refusals", () => {
  it("shows an Administrator refused by the database the unavailable message, never the manager-only one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(new EmployeeForbiddenError());
    expect(await createEmployeeAction(blank, form(fields))).toEqual({ error: UNAVAILABLE, message: "" });
  });

  it.each([
    [new EmployeeExistsError("employeeId"), DUPLICATE_ID],
    [new EmployeeExistsError("email"), DUPLICATE_EMAIL],
    [new EmployeeValidationError(["departmentId"]), NO_DEPARTMENT],
    [new EmployeesUnavailableError(), UNAVAILABLE],
    [new Error("boom"), UNAVAILABLE],
  ])("maps %s to its message, never reporting success", async (error, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(error);
    expect(await createEmployeeAction(blank, form(fields))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createEmployeeAction for a manager refused on scope", () => {
  it("names the department-scope rule", async () => {
    getActor.mockResolvedValue({ identity: MANAGER, userId: "u" });
    create.mockRejectedValue(new EmployeeForbiddenError());
    expect(await createEmployeeAction(blank, form(fields))).toEqual({ error: FORBIDDEN, message: "" });
  });
});

describe("updateEmployeeDetailsAction (Story 7.2)", () => {
  const DETAILS_NOT_ALLOWED = "Only an Administrator or a department manager can edit employee details.";
  const VIA_TRANSFER = "An employee's department can only change through a transfer.";
  const DETAILS_FORBIDDEN = "You can only edit employees in your own department or its sub-departments.";
  const NOT_FOUND = "Choose an existing employee.";
  const DETAILS_UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was changed.";

  const details = {
    employeeId: "BS-4321", title: "  Senior   QA Engineer ", team: "Quality", manager: "Meera Das", office: "Dhaka HQ",
    employmentType: "Permanent",
  };
  const detailsWithout = (key: keyof typeof details) => Object.fromEntries(Object.entries(details).filter(([k]) => k !== key));

  beforeEach(() => {
    updateDetails.mockImplementation(async (_session, employeeId) => ({ employeeId, name: "Tanvir Hasan" }));
  });

  it.each([["a staff session", STAFF], ["no session", null]] as const)("refuses %s before the store", async (_label, identity) => {
    getActor.mockResolvedValue(identity ? { identity, userId: "u" } : null);
    expect(await updateEmployeeDetailsAction(blank, form(details))).toEqual({ error: DETAILS_NOT_ALLOWED, message: "" });
    expect(updateDetails).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses Staff even on their own record", async () => {
    getActor.mockResolvedValue({ identity: STAFF, userId: "u" });
    const own = { ...details, employeeId: "BS-1001" };
    expect(await updateEmployeeDetailsAction(blank, form(own))).toEqual({ error: DETAILS_NOT_ALLOWED, message: "" });
    expect(updateDetails).not.toHaveBeenCalled();
  });

  it.each([["an admin", ADMIN], ["a manager", MANAGER]] as const)("lets %s save the five fields, normalised", async (_label, identity) => {
    getActor.mockResolvedValue({ identity, userId: "u" });
    expect(await updateEmployeeDetailsAction(blank, form(details))).toEqual({ error: "", message: "Tanvir Hasan's details were saved." });
    expect(updateDetails).toHaveBeenCalledWith(identity, "BS-4321", {
      title: "Senior QA Engineer", team: "Quality", manager: "Meera Das", office: "Dhaka HQ", employmentType: "Permanent",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it.each(["departmentId", "department"])("refuses a form carrying %s, with no store call", async key => {
    expect(await updateEmployeeDetailsAction(blank, form({ ...details, [key]: DEPT }))).toEqual({ error: VIA_TRANSFER, message: "" });
    expect(await updateEmployeeDetailsAction(blank, form({ ...details, [key]: "" }))).toEqual({ error: VIA_TRANSFER, message: "" });
    expect(updateDetails).not.toHaveBeenCalled();
  });

  it("ignores other forged fields", async () => {
    await updateEmployeeDetailsAction(blank, form({ ...details, name: "Forged", archived_at: "2026-01-01", auth_user_id: "x" }));
    expect(Object.keys(updateDetails.mock.calls[0][2]).sort()).toEqual(["employmentType", "manager", "office", "team", "title"]);
  });

  it.each([
    [{ title: "   " }, "Enter the job title."],
    [{ team: "" }, "Enter the team."],
    [{ manager: "x".repeat(121) }, "Keep the reporting manager to 120 characters or fewer."],
    [{ office: "" }, "Enter the office."],
    [{ employmentType: "Contractor" }, "Choose an employment type: Permanent, Trainee, Intern."],
    [{ employeeId: "nope" }, NOT_FOUND],
  ])("refuses bad input %j before the store", async (change, message) => {
    expect(await updateEmployeeDetailsAction(blank, form({ ...details, ...change }))).toEqual({ error: message, message: "" });
    expect(updateDetails).not.toHaveBeenCalled();
  });

  it("refuses a missing field", async () => {
    expect((await updateEmployeeDetailsAction(blank, form(detailsWithout("office")))).error).toBe("Enter the office.");
    expect((await updateEmployeeDetailsAction(blank, form(detailsWithout("employeeId")))).error).toBe(NOT_FOUND);
    expect(updateDetails).not.toHaveBeenCalled();
  });

  it("names the scope rule for a manager refused by the store", async () => {
    getActor.mockResolvedValue({ identity: MANAGER, userId: "u" });
    updateDetails.mockRejectedValue(new EmployeeForbiddenError());
    expect(await updateEmployeeDetailsAction(blank, form(details))).toEqual({ error: DETAILS_FORBIDDEN, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("shows an Administrator refused by the database the unavailable message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    updateDetails.mockRejectedValue(new EmployeeForbiddenError());
    expect(await updateEmployeeDetailsAction(blank, form(details))).toEqual({ error: DETAILS_UNAVAILABLE, message: "" });
    error.mockRestore();
  });

  it.each([
    [new EmployeeNotFoundError(), NOT_FOUND],
    [new EmployeeValidationError(["details"]), "Check the employee details."],
    [new EmployeesUnavailableError(), DETAILS_UNAVAILABLE],
    [new Error("boom"), DETAILS_UNAVAILABLE],
  ])("maps %s", async (refusal, message) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    updateDetails.mockRejectedValue(refusal);
    expect(await updateEmployeeDetailsAction(blank, form(details))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
