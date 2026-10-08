"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AccountExistsError, AccountStateError, AccountsUnavailableError, AccountValidationError, ArchiveSelfError, createAccountsStore,
} from "./accounts-store";
import type { ActionState } from "./attendance-actions";
import { getActor, getSession } from "./auth";
import { getServiceClient } from "./supabase";

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

// Administrator-only archive and restore (Story 1.4). As above, the admin session is checked first,
// and a Staff session or no session never reaches accounts-store. The acting Administrator recorded in
// audit_events is the validated Supabase user from the session, never anything in the form.

const NOT_ADMIN_ARCHIVE = "Only an Administrator can archive or restore accounts.";
const UNAVAILABLE_ARCHIVE = "Accounts are temporarily unavailable. Nothing was changed.";
const SELF = "You cannot archive your own account.";

const archiveForm = z.object({ employeeId: z.string().trim().regex(/^BS-\d{4}$/) });

async function setArchived(form: FormData, archive: boolean): Promise<ActionState> {
  const actor = await getActor();
  if (actor?.identity.role !== "admin") return failure(NOT_ADMIN_ARCHIVE);

  const parsed = archiveForm.safeParse({ employeeId: form.get("employeeId") ?? "" });
  if (!parsed.success) return failure(UNKNOWN_EMPLOYEE);
  const { employeeId } = parsed.data;

  try {
    const store = createAccountsStore(getServiceClient);
    const input = { employeeId, actorId: actor.userId };
    const result = archive ? await store.archive(input) : await store.restore(input);
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
