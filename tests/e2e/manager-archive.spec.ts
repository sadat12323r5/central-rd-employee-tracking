import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { e2eManagedStaff, e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.9: a department manager archives a Staff account in their own department, which ends that
// account's access on its next sign-in, then restores it. Same behaviour as the Administrator's archive
// (Story 1.4), through the manager's own JWT and the manager_set_employee_archived function.
// The e2e manager (E2E_STAFF_MANAGER_*) gets a throwaway department containing one linked throwaway
// Staff employee (E2E_STAFF_MANAGED_*), who is signed in on a second browser context before the archive.
// Cleanup in `finally`: restore through the service role if still archived, clear department_id and
// delete the department (if it was created).
// Needs the departments, department_managers, manager_scope and manager_archive migrations applied.
const run = randomBytes(4).toString("hex");

/** Postgres / PostgREST "table/column does not exist" codes, returned until the migrations are applied. */
const SCHEMA_MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

function checkCleanup(what: string, error: { code: string; message: string } | null) {
  if (error && !SCHEMA_MISSING.has(error.code)) throw new Error(`Could not ${what}: ${error.message}`);
}

async function openProfile(page: Page, id: string, name: string, show: "Active employees" | "Archived employees" = "Active employees") {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Employees/ }).click();
  await page.getByLabel("Show employees").selectOption(show);
  await page.getByRole("textbox", { name: "Search employees" }).fill(id);
  await page.getByRole("button", { name: `View ${name}'s profile` }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("a department manager archives a Staff account in their department, ending its access, then restores it", async ({ browser }) => {
  const manager = e2eManagerStaff();
  const staff = e2eManagedStaff();
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const { baseURL, viewport } = test.info().project.use;
  const managerContext = await browser.newContext({ baseURL, viewport });
  const staffContext = await browser.newContext({ baseURL, viewport });
  const lead = await managerContext.newPage();
  const member = await staffContext.newPage();

  let departmentId: string | null = null;

  try {
    const created = await service.from("departments").insert({ name: `E2E Mgr Archive ${run}`, manager_user_id: account.data.auth_user_id }).select("id").single();
    if (created.error) throw new Error(`Could not create the throwaway department (${created.error.code}): ${created.error.message}`);
    departmentId = created.data.id as string;
    const placed = await service.from("employees").update({ department_id: departmentId }).eq("employee_id", staff.id);
    if (placed.error) throw new Error(`Could not place the throwaway employee: ${placed.error.message}`);

    // The employee is signed in to their own portal.
    await member.goto("/");
    await signIn(member, staff.email, staff.password);
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();

    // The manager opens the employee's profile and archives them.
    await lead.goto("/");
    await signIn(lead, manager.email, manager.password);
    await expect(lead.getByText("Department manager")).toBeVisible();
    await openProfile(lead, staff.id, staff.name);
    await expect(lead.getByRole("heading", { name: "Account access" })).toBeVisible();
    await expect(lead.getByRole("heading", { name: "Sign-in account" })).toHaveCount(0);
    await lead.getByRole("button", { name: "Archive employee" }).click();
    await expect(lead.getByRole("status").filter({ hasText: `${staff.name} was archived. Their sign-in access has ended.` })).toBeVisible();
    await expect(lead.getByRole("button", { name: "Restore employee" })).toBeVisible();
    await expect(lead.locator(".profile-header").getByText("Archived", { exact: true })).toBeVisible();

    // The employee's live session ends on the next request.
    await member.reload();
    await expect(member.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(member.getByRole("button", { name: "Clock in" })).toHaveCount(0);

    // The employee's correct password now gets the generic message.
    await signIn(member, staff.email, staff.password);
    await expect(member.locator(".form-error")).toContainText("incorrect");
    await expect(member.getByRole("button", { name: "Clock in" })).toHaveCount(0);

    // The manager finds them under "Archived employees" and restores them.
    await lead.reload();
    await openProfile(lead, staff.id, staff.name, "Archived employees");
    await lead.getByRole("button", { name: "Restore employee" }).click();
    await expect(lead.getByRole("status").filter({ hasText: `${staff.name} was restored.` })).toBeVisible();
    await expect(lead.getByRole("button", { name: "Archive employee" })).toBeVisible();

    // The employee can sign in again.
    await member.reload();
    await signIn(member, staff.email, staff.password);
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();
  } finally {
    await managerContext.close();
    await staffContext.close();
    const restored = await service.from("employees").update({ archived_at: null }).eq("employee_id", staff.id).not("archived_at", "is", null);
    checkCleanup("restore the throwaway employee", restored.error);
    const cleared = await service.from("employees").update({ department_id: null }).eq("employee_id", staff.id);
    checkCleanup("clear the throwaway employee's department", cleared.error);
    if (departmentId) {
      const deleted = await service.from("departments").delete().eq("id", departmentId);
      checkCleanup("delete the throwaway department", deleted.error);
    }
  }
});
