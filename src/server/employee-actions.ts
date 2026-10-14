"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";
import { EMAIL_MAX, EMPLOYMENT_TYPES, normalizeEmail, normalizeText, TEXT_FIELD_MAX } from "@/domain/employee-input";
import type { ActionState } from "./attendance-actions";
import { getActor } from "./auth";
import {
  EmployeeExistsError, EmployeeForbiddenError, employeesStore, EmployeesUnavailableError, EmployeeValidationError,
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
