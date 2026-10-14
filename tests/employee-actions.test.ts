import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewEmployeeInput } from "@/domain/employee-input";
import type { Actor } from "@/server/auth";
import type { SessionIdentity } from "@/server/session";

const { getActor, create, revalidatePath } = vi.hoisted(() => ({
  getActor: vi.fn<() => Promise<Actor | null>>(),
  create: vi.fn<(session: SessionIdentity, input: NewEmployeeInput) => Promise<{ employeeId: string; name: string }>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getActor }));
// The Supabase store is covered by employees-store.test.ts and, against the shared project, employee-create-rls.test.ts.
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { create, listFor: vi.fn(), getFor: vi.fn(), isActive: vi.fn() },
}));

const { createEmployeeAction } = await import("../src/server/employee-actions");
const {
  EmployeeExistsError, EmployeeForbiddenError, EmployeesUnavailableError, EmployeeValidationError,
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
