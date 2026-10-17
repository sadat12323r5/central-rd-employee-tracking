import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.10: a department manager uses "My record" in the management portal for their own self-service.
// The e2e manager account (E2E_STAFF_MANAGER_*) is made a manager through a throwaway department created
// through the service role; the department's manager is cleared and the department deleted in `finally`.
// The interview it adds is deleted by global-teardown.ts with the throwaway employee's other rows.
// The e2e Administrator is not linked to an employee record, so it gets no "My record".
const run = randomBytes(4).toString("hex");

/** Postgres / PostgREST "table/column does not exist" codes, returned until the migrations are applied. */
const SCHEMA_MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

function checkCleanup(what: string, error: { code: string; message: string } | null) {
  if (error && !SCHEMA_MISSING.has(error.code)) throw new Error(`Could not ${what}: ${error.message}`);
}

test("a manager opens \"My record\", adds an interview and sees it listed there", async ({ page }) => {
  const manager = e2eManagerStaff();
  const company = `E2E My Record Co ${run}`;
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const created = await service.from("departments").insert({ name: `E2E My Record ${run}`, manager_user_id: account.data.auth_user_id })
    .select("id").single();
  if (created.error) throw new Error(`Could not create the throwaway department (${created.error.code}): ${created.error.message}`);
  const departmentId = created.data.id as string;

  try {
    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    await expect(page.getByText("Department manager")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await nav.getByRole("button", { name: "My record" }).click();
    await expect(page.getByRole("heading", { name: "My record", level: 1 })).toBeVisible();
    const record = page.getByRole("region", { name: "My record" });
    // The self-service body: attendance, daily log, assignments, training and interviews, without a second shell.
    await expect(record.getByRole("heading", { name: "Today's work log" })).toBeVisible();
    await expect(record.getByRole("heading", { name: "My assignments" })).toBeVisible();
    await expect(record.getByRole("heading", { name: "Current enrolments" })).toBeVisible();
    await expect(record.getByRole("heading", { name: "External interviews" })).toBeVisible();
    await expect(record.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    await record.getByRole("textbox", { name: "Company" }).fill(company);
    await record.getByRole("textbox", { name: "Role" }).fill("Engineering Lead");
    await record.getByLabel("Interview date").fill("2026-10-21");
    await record.getByRole("textbox", { name: "Stage", exact: true }).fill("Recruiter screen");
    await record.getByRole("button", { name: "Add interview" }).click();
    await expect(record.getByText("Interview added.")).toBeVisible();

    const row = () => page.getByRole("region", { name: "My record" }).getByRole("table", { name: "Your external interviews" })
      .getByRole("row").filter({ hasText: company });
    await expect(row()).toContainText("Engineering Lead");
    await expect(row()).toContainText("21 Oct 2026");

    // Persisted against the manager's own record: still listed in "My record" after a reload.
    await page.reload();
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "My record" }).click();
    await expect(row()).toHaveCount(1);
  } finally {
    const cleared = await service.from("departments").update({ manager_user_id: null }).eq("id", departmentId);
    checkCleanup("clear the throwaway department's manager", cleared.error);
    const deleted = await service.from("departments").delete().eq("id", departmentId);
    checkCleanup("delete the throwaway department", deleted.error);
  }
});

test("the unlinked e2e Administrator has no \"My record\"", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Employees" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "My record" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "My record" })).toHaveCount(0);
});
