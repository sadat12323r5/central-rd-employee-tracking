import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { e2eManagedStaff, e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.8: a department manager moves a Staff member from their department P to its child C through the
// profile's Department panel; after a reload the profile shows C.
// The e2e manager (E2E_STAFF_MANAGER_*) gets throwaway departments P (managed) and C (child of P, no
// manager); the managed throwaway Staff employee (E2E_STAFF_MANAGED_*) starts in P and has no assignments.
// Cleanup in `finally`: clear the employee's department_id and delete C, then P (if they were created).
// The audit row stays (audit_events is append-only and has no foreign keys).
// Needs the departments, department_managers, manager_scope, assignments and department_transfer migrations.
const run = randomBytes(4).toString("hex");

/** Postgres / PostgREST "table/column does not exist" codes, returned until the migrations are applied. */
const SCHEMA_MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

function checkCleanup(what: string, error: { code: string; message: string } | null) {
  if (error && !SCHEMA_MISSING.has(error.code)) throw new Error(`Could not ${what}: ${error.message}`);
}

async function openProfile(page: Page, id: string, name: string) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Employees/ }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(id);
  await page.getByRole("button", { name: `View ${name}'s profile` }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("a department manager transfers a Staff member from their department to its child department", async ({ page }) => {
  const manager = e2eManagerStaff();
  const staff = e2eManagedStaff();
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const P = `E2E Transfer P ${run}`;
  const C = `E2E Transfer C ${run}`;
  let parentId: string | null = null;
  let childId: string | null = null;

  try {
    const parent = await service.from("departments").insert({ name: P, manager_user_id: account.data.auth_user_id }).select("id").single();
    if (parent.error) throw new Error(`Could not create the throwaway department P (${parent.error.code}): ${parent.error.message}`);
    parentId = parent.data.id as string;
    const child = await service.from("departments").insert({ name: C, parent_department_id: parentId }).select("id").single();
    if (child.error) throw new Error(`Could not create the throwaway department C (${child.error.code}): ${child.error.message}`);
    childId = child.data.id as string;
    const placed = await service.from("employees").update({ department_id: parentId }).eq("employee_id", staff.id);
    if (placed.error) throw new Error(`Could not place the throwaway employee: ${placed.error.message}`);

    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByText("Department manager")).toBeVisible();
    await openProfile(page, staff.id, staff.name);

    const panel = page.locator("article").filter({ has: page.getByRole("heading", { name: "Department", exact: true }) });
    await expect(panel.getByText(`Department: ${P}`)).toBeVisible();
    await panel.getByLabel("Move to department").selectOption({ label: C });
    await panel.getByRole("button", { name: "Transfer employee" }).click();
    await expect(panel.getByRole("status")).toHaveText(`${staff.name} was moved to ${C}.`);

    // After a reload the profile reads the new department from the database.
    await page.reload();
    await openProfile(page, staff.id, staff.name);
    await expect(panel.getByText(`Department: ${C}`)).toBeVisible();
    const stored = await service.from("employees").select("department_id").eq("employee_id", staff.id).single();
    expect(stored.data?.department_id).toBe(childId);
  } finally {
    const cleared = await service.from("employees").update({ department_id: null }).eq("employee_id", staff.id);
    checkCleanup("clear the throwaway employee's department", cleared.error);
    for (const id of [childId, parentId]) {
      if (!id) continue;
      const deleted = await service.from("departments").delete().eq("id", id);
      checkCleanup("delete a throwaway department", deleted.error);
    }
  }
});
