import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.7: a throwaway Staff member adds a past project, edits it and withdraws it in "My assignments";
// a throwaway manager over the employee's department then sees it in the Current work history marked
// "Self-reported" and "Withdrawn", with no edit, withdraw or evaluation control.
// Backfilled projects can never be deleted (and they pin their employee and department), so this spec
// reuses a fixed throwaway employee (BS-9192, outside the BS-98nn range global-setup sweeps) and a fixed
// department ("E2E Backfill"). It links a Staff account it creates for the employee and points the
// department at this run's manager; afterwards it clears the manager, unlinks and archives the employee and
// deletes the account. Earlier runs' entries stay and are harmless: every check uses this run's project name.
// Needs the departments, department_managers, manager_scope, assignments, assignment_evaluations and
// backfilled_projects migrations.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = "E2E Backfill";
const SUBJECT = { id: "BS-9192", name: "E2E Backfill Subject" };

const subjectRow = (department_id: string, auth_user_id: string) => ({
  employee_id: SUBJECT.id, name: SUBJECT.name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent",
  email: "e2e-backfill-subject@example.test", joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available",
  initials: "EB", avatar_color: "mint", summary: "Throwaway row reused by tests/e2e/backfill.spec.ts.",
  department_id, auth_user_id, archived_at: null,
});

async function prepare(service: SupabaseClient, managerUserId: string, subjectUserId: string) {
  const found = await service.from("departments").select("id").eq("name", DEPARTMENT).maybeSingle();
  if (found.error) throw new Error(`Could not read the throwaway department (${found.error.code}): ${found.error.message}`);
  let departmentId = found.data?.id as string | undefined;
  if (departmentId) {
    const updated = await service.from("departments").update({ manager_user_id: managerUserId, parent_department_id: null }).eq("id", departmentId);
    if (updated.error) throw new Error(`Could not update the throwaway department (${updated.error.code}): ${updated.error.message}`);
  } else {
    const created = await service.from("departments").insert({ name: DEPARTMENT, manager_user_id: managerUserId }).select("id").single();
    if (created.error) throw new Error(`Could not create the throwaway department (${created.error.code}): ${created.error.message}`);
    departmentId = created.data.id as string;
  }
  const subject = await service.from("employees").upsert(subjectRow(departmentId, subjectUserId), { onConflict: "employee_id", defaultToNull: false });
  if (subject.error) throw new Error(`Could not upsert the throwaway employee (${subject.error.code}): ${subject.error.message}`);
}

test("a Staff member adds, edits and withdraws a past project; a manager sees it Self-reported and Withdrawn, read-only", async ({ page, browser }) => {
  const manager = e2eManagerStaff();
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const project = `E2E past project ${run}`;
  const subjectEmail = `e2e-staff-backfill-${run}@example.test`;
  const subjectPassword = `E2e-${randomBytes(18).toString("base64url")}`;
  const created = await service.auth.admin.createUser({
    email: subjectEmail, password: subjectPassword, email_confirm: true, app_metadata: { role: "staff", employee_id: SUBJECT.id },
  });
  if (created.error || !created.data.user) throw new Error(`Could not create the subject's account: ${created.error?.message ?? "no user returned"}`);
  const subjectUserId = created.data.user.id;
  const managerContext = await browser.newContext();
  try {
    await prepare(service, account.data.auth_user_id as string, subjectUserId);

    // The employee adds a past project.
    await page.goto("/");
    await signIn(page, subjectEmail, subjectPassword);
    const mine = page.locator("section").filter({ has: page.getByRole("heading", { name: "My assignments" }) });
    await expect(mine).toBeVisible();
    const add = mine.getByRole("form", { name: "Add a past project" });
    await add.getByLabel("Department").selectOption({ label: DEPARTMENT });
    await add.getByLabel("Client").fill("Old Bank (fictional)");
    await add.getByLabel("Project name").fill(project);
    await add.getByLabel("Completion date").fill("2025-12-15");
    await add.getByLabel("Outcome").fill("Delivered the audit report.");
    await add.getByRole("button", { name: "Add past project" }).click();
    await expect(add.getByRole("status")).toHaveText("Past project added.");
    const row = mine.getByRole("list", { name: "Past projects you added" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: project }) });
    await expect(row).toContainText("Self-reported");
    await expect(row).toContainText(`Old Bank (fictional) · ${DEPARTMENT}`);
    await expect(row).toContainText("Completed 15 Dec 2025");

    // Edits it.
    await row.getByText("Edit", { exact: true }).click();
    const edit = row.getByRole("form", { name: `Edit past project: ${project}, 15 Dec 2025` });
    await edit.getByLabel(/^Outcome/).fill("Delivered the audit report; findings closed.");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(row.locator(".callout")).toHaveText("Delivered the audit report; findings closed.");

    // Withdraws it: it stays listed, marked, with no controls.
    // The withdraw control sits on the entry itself, outside the Edit <details>.
    await row.getByRole("button", { name: `Withdraw past project: ${project}, 15 Dec 2025` }).click();
    await expect(row.getByText("Past project withdrawn.")).toBeVisible();
    await expect(row).toContainText("Withdrawn");
    await expect(row.locator("input, textarea, button, select, form, details")).toHaveCount(0);

    // The manager sees it in the Current work history, read-only.
    const managerPage = await managerContext.newPage();
    await managerPage.goto("/");
    await signIn(managerPage, manager.email, manager.password);
    await expect(managerPage.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    await managerPage.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Employees/ }).click();
    await managerPage.getByRole("button", { name: `View ${SUBJECT.name}'s profile` }).click();
    await managerPage.getByRole("tab", { name: "Current work" }).click();
    const panel = managerPage.getByRole("tabpanel");
    const item = panel.getByRole("list", { name: "Work history" }).getByRole("listitem")
      .filter({ has: managerPage.getByRole("heading", { name: project }) });
    await expect(item).toContainText("Self-reported");
    await expect(item).toContainText("Withdrawn");
    await expect(item).toContainText("Delivered the audit report; findings closed.");
    await expect(item).toContainText(`Completed 15 Dec 2025 · ${DEPARTMENT}`);
    await expect(item.locator("input, textarea, button, select, form, details")).toHaveCount(0);
  } finally {
    await managerContext.close();
    await service.from("departments").update({ manager_user_id: null }).eq("name", DEPARTMENT);
    await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).eq("employee_id", SUBJECT.id);
    await service.auth.admin.deleteUser(subjectUserId);
  }
});
