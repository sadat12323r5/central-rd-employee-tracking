"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AccountExistsError, AccountStateError, AccountsUnavailableError, AccountValidationError, ArchiveNotAuthorizedError, ArchiveRankError,
  ArchiveSelfError, createAccountsStore, createManagerAccessStore, type ArchiveResult,
} from "./accounts-store";
import type { ActionState } from "./attendance-actions";
import { getActor, getSession } from "./auth";
import { managerScope } from "./manager-scope";
import { getServiceClient, getUserClient } from "./supabase";

// Administrator-only Staff provisioning (Story 1.3). The admin session is checked here, at the
// server, before anything else: a Staff session or no session never reaches accounts-store.
// The account's email is the employee's own primary email, read by accounts-store; the form
// supplies only the Employee ID and the initial password (typed twice), which is never logged or echoed back.

const NOT_ADMIN = "Only an Administrator can create accounts.";
const EXISTS = "This employee already has a sign-in account.";
const UNKNOWN_EMPLOYEE = "Choose an existing employee.";
const BAD_PASSWORD = "The initial password must be 12 to 72 characters and meet the password policy.";
const MISMATCH = "The two passwords do not match.";
const UNAVAILABLE = "Accounts are temporarily unavailable. Nothing was created.";

const provisionInput = z.object({
  employeeId: z.string().trim().regex(/^BS-\d{4}$/),
  password: z.string().min(12).max(72),
});

function failure(error: string): ActionState {
  return { error, message: "" };
}

function validationMessage(fields: string[]): string {
  return fields.includes("employeeId") ? UNKNOWN_EMPLOYEE : BAD_PASSWORD;
}

export async function provisionStaffAccountAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (session?.role !== "admin") return failure(NOT_ADMIN);

  const parsed = provisionInput.safeParse({ employeeId: form.get("employeeId") ?? "", password: form.get("password") ?? "" });
  if (!parsed.success) return failure(validationMessage(parsed.error.issues.map(issue => String(issue.path[0]))));
  if (form.get("confirmPassword") !== parsed.data.password) return failure(MISMATCH);

  try {
    const account = await createAccountsStore(getServiceClient).create({ role: "staff", ...parsed.data });
    revalidatePath("/");
    return { error: "", message: `Sign-in account created for ${account.name ?? account.employeeId}.` };
  } catch (error) {
    if (error instanceof AccountExistsError) return failure(EXISTS);
    if (error instanceof AccountValidationError) return failure(validationMessage(error.fields));
    if (error instanceof AccountsUnavailableError) {
      console.error("Staff provisioning failed: accounts unavailable.", error.name);
      return failure(UNAVAILABLE);
    }
    console.error("Staff provisioning failed.", error instanceof Error ? error.name : "unknown error");
    return failure(UNAVAILABLE);
  }
}

// Archive and restore (Story 1.4; department managers since Story 4.9). The session is checked first:
// a Staff session or no session never reaches a store. The Administrator path is unchanged (service-role
// accounts-store, actor = the validated Supabase user from the session). A manager session goes through
// the manager access store: the manager's own JWT client and the manager scope, never the service role;
// the database function takes the actor from auth.uid(). The employee id comes only from the form.

const NOT_ADMIN_ARCHIVE = "Only an Administrator or a department manager can archive or restore accounts.";
const UNAVAILABLE_ARCHIVE = "Accounts are temporarily unavailable. Nothing was changed.";
const SELF = "You cannot archive your own account.";
const NOT_IN_DEPARTMENT = "You can only archive or restore accounts in your own department or its sub-departments.";
const RANK = "You cannot archive or restore an account with equal or higher authority than yours.";

const archiveForm = z.object({ employeeId: z.string().trim().regex(/^BS-\d{4}$/) });

async function setArchived(form: FormData, archive: boolean): Promise<ActionState> {
  const actor = await getActor();
  const role = actor?.identity.role;
  if (!actor || (role !== "admin" && role !== "manager")) return failure(NOT_ADMIN_ARCHIVE);

  const parsed = archiveForm.safeParse({ employeeId: form.get("employeeId") ?? "" });
  if (!parsed.success) return failure(UNKNOWN_EMPLOYEE);
  const { employeeId } = parsed.data;

  try {
    let result: ArchiveResult;
    if (actor.identity.role === "manager") {
      const store = createManagerAccessStore({ userClient: getUserClient, scope: managerScope });
      result = archive ? await store.archive(actor.identity, employeeId) : await store.restore(actor.identity, employeeId);
    } else {
      const store = createAccountsStore(getServiceClient);
      const input = { employeeId, actorId: actor.userId };
      result = archive ? await store.archive(input) : await store.restore(input);
    }
    revalidatePath("/");
    return {
      error: "",
      message: archive ? `${result.name} was archived. Their sign-in access has ended.` : `${result.name} was restored.`,
    };
  } catch (error) {
    if (error instanceof AccountStateError) {
      const name = error.employeeName ?? employeeId;
      return failure(error.state === "archived" ? `${name} is already archived.` : `${name} is not archived.`);
    }
    if (error instanceof ArchiveSelfError) return failure(SELF);
    if (error instanceof ArchiveNotAuthorizedError) return failure(NOT_IN_DEPARTMENT);
    if (error instanceof ArchiveRankError) return failure(RANK);
    if (error instanceof AccountValidationError && error.fields.includes("employeeId")) return failure(UNKNOWN_EMPLOYEE);
    console.error(`Account ${archive ? "archive" : "restore"} failed.`, error instanceof Error ? error.name : "unknown error");
    return failure(UNAVAILABLE_ARCHIVE);
  }
}

export async function archiveEmployeeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return setArchived(form, true);
}

export async function restoreEmployeeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return setArchived(form, false);
}
