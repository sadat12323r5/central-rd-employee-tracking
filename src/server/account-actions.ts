"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AccountExistsError, AccountsUnavailableError, AccountValidationError, createAccountsStore } from "./accounts-store";
import type { ActionState } from "./attendance-actions";
import { getSession } from "./auth";
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
