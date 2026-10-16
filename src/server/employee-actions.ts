"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
import { departmentsStore } from "./departments-store";
import {
  employeesStore, TransferDepartmentError, TransferForbiddenError, TransferInvalidError, TransferNotFoundError,
  TransferOpenAssignmentError, TransferSameDepartmentError,
} from "./employees-store";

// Story 4.8: the Administrator, or a manager with authority over both departments, moves an employee to
// another department. The session is checked first: Staff or no session never reaches the store. The
// form sends only the Employee ID and the destination department id; the actor comes from the session
// (the database function takes it from auth.uid()). employees-store.transfer() is the only writer.

const NOT_MANAGER = "Only an Administrator or a department manager can move employees.";
const FORBIDDEN = "You can only move people between departments you manage.";
const NOT_FOUND = "Employee not found.";
const UNKNOWN_DEPARTMENT = "Choose a department from the list.";
const SAME = "This employee is already in that department.";
const OPEN_ASSIGNMENT = "Close this employee's open assignment before moving them.";
const UNAVAILABLE = "Employee records are temporarily unavailable. Nothing was changed.";

const transferForm = z.object({
  employeeId: z.string({ error: NOT_FOUND }).trim().regex(/^BS-\d{4}$/, NOT_FOUND),
  toDepartmentId: z.string({ error: UNKNOWN_DEPARTMENT }).trim().pipe(z.uuid(UNKNOWN_DEPARTMENT)),
});

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
};

const failure = (error: string): ActionState => ({ error, message: "" });

export async function transferEmployeeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin" && session?.role !== "manager") return failure(NOT_MANAGER);

  const parsed = transferForm.safeParse({ employeeId: field(form, "employeeId"), toDepartmentId: field(form, "toDepartmentId") });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? UNKNOWN_DEPARTMENT);

  let name: string;
  try {
    ({ name } = await employeesStore.transfer(session, parsed.data.employeeId, parsed.data.toDepartmentId));
  } catch (error) {
    if (error instanceof TransferForbiddenError) return failure(FORBIDDEN);
    if (error instanceof TransferNotFoundError) return failure(NOT_FOUND);
    if (error instanceof TransferDepartmentError) return failure(UNKNOWN_DEPARTMENT);
    if (error instanceof TransferSameDepartmentError) return failure(SAME);
    if (error instanceof TransferOpenAssignmentError) return failure(OPEN_ASSIGNMENT);
    if (error instanceof TransferInvalidError) return failure(error.fields.includes("employeeId") ? NOT_FOUND : UNKNOWN_DEPARTMENT);
    console.error("Employee transfer failed.", error instanceof Error ? error.name : "unknown error");
    return failure(UNAVAILABLE);
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
