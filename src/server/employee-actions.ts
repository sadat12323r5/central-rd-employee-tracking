"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import { EMAIL_MAX, EMPLOYMENT_TYPES, normalizeEmail, normalizeText, TEXT_FIELD_MAX } from "@/domain/employee-input";
import type { ActionState } from "./attendance-actions";
import { getActor, getSession } from "./auth";
import { departmentsStore } from "./departments-store";
import {
  EmployeeExistsError, EmployeeForbiddenError, EmployeeNotFoundError, employeesStore, EmployeesUnavailableError, EmployeeValidationError,
  TransferDepartmentError, TransferForbiddenError, TransferInvalidError, TransferNotFoundError,
  TransferOpenAssignmentError, TransferSameDepartmentError,
} from "./employees-store";

// Story 7.1: the Administrator (any department) and department managers (departments in their subtree)
// add a new employee. The role is checked here, at the server, before anything else: a Staff session or
// no session never reaches employees-store. Only the listed fields are read from the form; status,
// initials, avatar colour and summary are derived by the store, and nothing here creates a sign-in
// account (that stays with Story 1.3's provisioning).

const NOT_ALLOWED = "Only an Administrator or a department manager can add employees.";
const NO_DEPARTMENT = "Choose a department. Every employee needs one.";
const DUPLICATE_ID = "An employee with this Employee ID already exists.";
const DUPLICATE_EMAIL = "An employee with this email already exists.";
const FORBIDDEN = "You can only add employees to your own department or its sub-departments.";
const UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was added.";

/** A required free-text field: trimmed, inner whitespace collapsed, 1–120 characters. */
const text = (label: string) => z.string({ error: `Enter the ${label}.` })
  .transform(normalizeText)
  .pipe(z.string().min(1, `Enter the ${label}.`).max(TEXT_FIELD_MAX, `Keep the ${label} to ${TEXT_FIELD_MAX} characters or fewer.`));

const newEmployee = z.object({
  employeeId: z.string({ error: "Enter the Employee ID, like BS-1234." }).trim()
    .regex(/^BS-\d{4}$/, "Enter the Employee ID as BS followed by four digits, like BS-1234."),
  name: text("name"),
  title: text("job title"),
  team: text("team"),
  email: z.string({ error: "Enter the email address." }).transform(normalizeEmail)
    .pipe(z.string().min(1, "Enter the email address.").max(EMAIL_MAX, `Keep the email address to ${EMAIL_MAX} characters or fewer.`)
      .pipe(z.email("Enter a valid email address."))),
  departmentId: z.string({ error: NO_DEPARTMENT }).trim().min(1, NO_DEPARTMENT).uuid(NO_DEPARTMENT),
  manager: text("reporting manager"),
  office: text("office"),
  employmentType: z.enum(EMPLOYMENT_TYPES, { error: `Choose an employment type: ${EMPLOYMENT_TYPES.join(", ")}.` }),
  joinedOn: z.string().trim().default("")
    .refine(value => value === "" || isCalendarDate(value), "Enter the join date as a real date, YYYY-MM-DD."),
});

const FIELDS = ["employeeId", "name", "title", "team", "email", "departmentId", "manager", "office", "employmentType", "joinedOn"] as const;

/** Only the known fields, and only string values: anything else in the form (e.g. auth_user_id, status) is ignored. */
function fieldsOf(form: FormData): Record<string, string | undefined> {
  return Object.fromEntries(FIELDS.map(key => {
    const value = form.get(key);
    return [key, typeof value === "string" ? value : undefined];
  }));
}

function failure(error: string): ActionState {
  return { error, message: "" };
}

export async function createEmployeeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await getActor();
  const session = actor?.identity;
  if (session?.role !== "admin" && session?.role !== "manager") return failure(NOT_ALLOWED);

  const parsed = newEmployee.safeParse(fieldsOf(form));
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // A missing department gets its own message, whatever else is wrong.
    const department = issues.find(issue => issue.path[0] === "departmentId");
    return failure(department ? NO_DEPARTMENT : issues[0]?.message ?? "Check the employee details.");
  }

  try {
    const added = await employeesStore.create(session, parsed.data);
    revalidatePath("/");
    return { error: "", message: `${added.name} was added.` };
  } catch (error) {
    if (error instanceof EmployeeExistsError) return failure(error.field === "employeeId" ? DUPLICATE_ID : DUPLICATE_EMAIL);
    if (error instanceof EmployeeForbiddenError) {
      // The Administrator has authority over every department: a refusal (e.g. RLS with the insert policy
      // not applied, or a stale JWT role) is not about scope, so never show the manager-only message.
      if (session.role === "admin") {
        console.error("Adding an employee failed: refused for an Administrator.", error.name);
        return failure(UNAVAILABLE);
      }
      return failure(FORBIDDEN);
    }
    if (error instanceof EmployeeValidationError) {
      return failure(error.fields.includes("departmentId") ? NO_DEPARTMENT : "Check the employee details.");
    }
    if (error instanceof EmployeesUnavailableError) {
      console.error("Adding an employee failed: employee records unavailable.", error.name);
      return failure(UNAVAILABLE);
    }
    console.error("Adding an employee failed.", error instanceof Error ? error.name : "unknown error");
    return failure(UNAVAILABLE);
  }
}

// Story 7.2: the Administrator (anyone) and department managers (employees in their subtree) edit an
// employee's title, team, reporting manager, office and employment type. The role is checked here first:
// Staff (even on their own record) and no session never reach employees-store. A form that carries a
// department at all is refused: an employee's department changes only through a transfer.

const DETAILS_NOT_ALLOWED = "Only an Administrator or a department manager can edit employee details.";
const DEPARTMENT_VIA_TRANSFER = "An employee's department can only change through a transfer.";
const DETAILS_FORBIDDEN = "You can only edit employees in your own department or its sub-departments.";
const NO_SUCH_EMPLOYEE = "Choose an existing employee.";
const DETAILS_UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was changed.";

const employeeDetails = z.object({
  employeeId: z.string({ error: NO_SUCH_EMPLOYEE }).trim().regex(/^BS-\d{4}$/, NO_SUCH_EMPLOYEE),
  title: text("job title"),
  team: text("team"),
  manager: text("reporting manager"),
  office: text("office"),
  employmentType: z.enum(EMPLOYMENT_TYPES, { error: `Choose an employment type: ${EMPLOYMENT_TYPES.join(", ")}.` }),
});

const DETAIL_FIELDS = ["employeeId", "title", "team", "manager", "office", "employmentType"] as const;

export async function updateEmployeeDetailsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await getActor();
  const session = actor?.identity;
  if (session?.role !== "admin" && session?.role !== "manager") return failure(DETAILS_NOT_ALLOWED);
  if (form.has("departmentId") || form.has("department")) return failure(DEPARTMENT_VIA_TRANSFER);

  const parsed = employeeDetails.safeParse(Object.fromEntries(DETAIL_FIELDS.map(key => {
    const value = form.get(key);
    return [key, typeof value === "string" ? value : undefined];
  })));
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Check the employee details.");

  const { employeeId, ...details } = parsed.data;
  try {
    const saved = await employeesStore.updateDetails(session, employeeId, details);
    revalidatePath("/");
    return { error: "", message: `${saved.name}'s details were saved.` };
  } catch (error) {
    if (error instanceof EmployeeForbiddenError) {
      // The Administrator has authority over everyone: a refusal (e.g. the function not applied, or a
      // stale JWT role) is not about scope, so never show the manager-only message.
      if (session.role === "admin") {
        console.error("Editing employee details failed: refused for an Administrator.", error.name);
        return failure(DETAILS_UNAVAILABLE);
      }
      return failure(DETAILS_FORBIDDEN);
    }
    if (error instanceof EmployeeNotFoundError) return failure(NO_SUCH_EMPLOYEE);
    if (error instanceof EmployeeValidationError) return failure("Check the employee details.");
    console.error("Editing employee details failed.", error instanceof Error ? error.name : "unknown error");
    return failure(DETAILS_UNAVAILABLE);
  }
}

// Story 4.8: the Administrator, or a manager with authority over both departments, moves an employee to
// another department. The session is checked first: Staff or no session never reaches the store. The
// form sends only the Employee ID and the destination department id; the actor comes from the session
// (the database function takes it from auth.uid()). employees-store.transfer() is the only writer.

const TRANSFER_NOT_ALLOWED = "Only an Administrator or a department manager can move employees.";
const TRANSFER_FORBIDDEN = "You can only move people between departments you manage.";
const TRANSFER_NOT_FOUND = "Employee not found.";
const TRANSFER_UNKNOWN_DEPARTMENT = "Choose a department from the list.";
const TRANSFER_SAME = "This employee is already in that department.";
const TRANSFER_OPEN_ASSIGNMENT = "Close this employee's open assignment before moving them.";
const TRANSFER_UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was changed.";

const transferForm = z.object({
  employeeId: z.string({ error: TRANSFER_NOT_FOUND }).trim().regex(/^BS-\d{4}$/, TRANSFER_NOT_FOUND),
  toDepartmentId: z.string({ error: TRANSFER_UNKNOWN_DEPARTMENT }).trim().pipe(z.uuid(TRANSFER_UNKNOWN_DEPARTMENT)),
});

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
};

export async function transferEmployeeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin" && session?.role !== "manager") return failure(TRANSFER_NOT_ALLOWED);

  const parsed = transferForm.safeParse({ employeeId: field(form, "employeeId"), toDepartmentId: field(form, "toDepartmentId") });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? TRANSFER_UNKNOWN_DEPARTMENT);

  let name: string;
  try {
    ({ name } = await employeesStore.transfer(session, parsed.data.employeeId, parsed.data.toDepartmentId));
  } catch (error) {
    if (error instanceof TransferForbiddenError) return failure(TRANSFER_FORBIDDEN);
    if (error instanceof TransferNotFoundError) return failure(TRANSFER_NOT_FOUND);
    if (error instanceof TransferDepartmentError) return failure(TRANSFER_UNKNOWN_DEPARTMENT);
    if (error instanceof TransferSameDepartmentError) return failure(TRANSFER_SAME);
    if (error instanceof TransferOpenAssignmentError) return failure(TRANSFER_OPEN_ASSIGNMENT);
    if (error instanceof TransferInvalidError) return failure(error.fields.includes("employeeId") ? TRANSFER_NOT_FOUND : TRANSFER_UNKNOWN_DEPARTMENT);
    console.error("Employee transfer failed.", error instanceof Error ? error.name : "unknown error");
    return failure(TRANSFER_UNAVAILABLE);
  }
  revalidatePath("/");

  // The transfer is done; the name is only for the message. A failed lookup never turns success into an error.
  let department = "the selected department";
  try {
    department = (await departmentsStore.listFor(session)).find(d => d.id === parsed.data.toDepartmentId)?.name ?? department;
  } catch {
    // Keep the generic wording.
  }
  return { error: "", message: `${name} was moved to ${department}.` };
}
