"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DEPARTMENT_NAME_MAX, normalizeDepartmentName } from "@/domain/departments";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import {
  DepartmentCycleError, DepartmentNameInvalidError, DepartmentNameTakenError, DepartmentNotFoundError, DepartmentsForbiddenError,
  departmentsStore, DepartmentsUnavailableError, ManagerArchivedError, ManagerEmployeeNotFoundError, ManagerHasNoAccountError,
} from "./departments-store";

// Story 4.1: the Administrator adds, renames and re-parents departments. There is no delete action.
// Story 4.2: the Administrator sets or removes a department's manager (an employee with an existing
// sign-in account). Every action here is Administrator only; Staff and manager sessions are refused.
const FORBIDDEN = "Only an Administrator can manage departments.";
const TAKEN = "A department with that name already exists.";
const CYCLE = "A department can't be placed under itself or one of its own sub-departments.";
const NOT_FOUND = "Choose an existing department.";
const UNAVAILABLE = "Departments are temporarily unavailable. Nothing was saved.";
const MANAGER_NOT_FOUND = "Choose an existing department and employee.";
const NAME = `Enter a department name of 1 to ${DEPARTMENT_NAME_MAX} characters.`;

const name = z.string({ error: "Enter the department name." })
  .transform(normalizeDepartmentName)
  .pipe(z.string().min(1, "Enter the department name.").max(DEPARTMENT_NAME_MAX, `Keep the department name to ${DEPARTMENT_NAME_MAX} characters or fewer.`));

/** "" (or a missing field) means top level; anything else must be a department id. */
const parentId = z.string().trim().default("")
  .pipe(z.union([z.literal(""), z.string().uuid("Choose an existing parent department.")]))
  .transform(value => (value === "" ? null : value));

const departmentId = z.string({ error: "Choose a department." }).trim().uuid("Choose an existing department.");

/** An Employee ID, or "none" to remove the manager (mapped to null). */
const manager = z.string({ error: "Choose a manager, or No manager." }).trim()
  .pipe(z.union([
    z.literal("none"),
    z.string().min(1, "Choose a manager, or No manager.").regex(/^BS-\d{4}$/, "Choose an employee from the list."),
  ]))
  .transform(value => (value === "none" ? null : value));

const newDepartment = z.object({ name, parentId });
const managerChange = z.object({ id: departmentId, manager });
const departmentChanges = z.object({ id: departmentId, name, parentId });

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
};

/** Maps the store's refusals to messages. Unknown errors are rethrown. */
function refusal(error: unknown): ActionState {
  if (error instanceof ManagerHasNoAccountError || error instanceof ManagerArchivedError) return { error: error.message, message: "" };
  if (error instanceof ManagerEmployeeNotFoundError) return { error: MANAGER_NOT_FOUND, message: "" };
  if (error instanceof DepartmentsForbiddenError) return { error: FORBIDDEN, message: "" };
  if (error instanceof DepartmentNameTakenError) return { error: TAKEN, message: "" };
  if (error instanceof DepartmentCycleError) return { error: CYCLE, message: "" };
  if (error instanceof DepartmentNotFoundError) return { error: NOT_FOUND, message: "" };
  if (error instanceof DepartmentNameInvalidError) return { error: NAME, message: "" };
  // Never report success when the database could not be reached or refused the write.
  if (error instanceof DepartmentsUnavailableError) {
    console.error("Departments unavailable.", error, { cause: error.cause });
    return { error: UNAVAILABLE, message: "" };
  }
  throw error;
}

export async function createDepartmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin") return { error: FORBIDDEN, message: "" };

  const parsed = newDepartment.safeParse({ name: field(form, "name"), parentId: field(form, "parentId") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the department details.", message: "" };

  try {
    await departmentsStore.create(session, parsed.data);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Department added." };
}

export async function updateDepartmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin") return { error: FORBIDDEN, message: "" };

  const parsed = departmentChanges.safeParse({ id: field(form, "id"), name: field(form, "name"), parentId: field(form, "parentId") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the department details.", message: "" };

  const { id, ...input } = parsed.data;
  try {
    await departmentsStore.update(session, id, input);
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: "Department updated." };
}

export async function setDepartmentManagerAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin") return { error: FORBIDDEN, message: "" };

  const parsed = managerChange.safeParse({ id: field(form, "id"), manager: field(form, "manager") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the manager details.", message: "" };

  const { id, manager: employeeId } = parsed.data;
  try {
    await departmentsStore.setManager(session, id, employeeId);
  } catch (error) {
    // For this action an unknown department is reported together with the employee choice.
    if (error instanceof DepartmentNotFoundError) return { error: MANAGER_NOT_FOUND, message: "" };
    return refusal(error);
  }
  revalidatePath("/");
  return { error: "", message: employeeId === null ? "Manager removed." : "Manager updated." };
}
