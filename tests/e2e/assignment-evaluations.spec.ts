import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.6: a manager of a throwaway department closes a throwaway employee's assignment, writes its
// evaluation with client feedback and amends it; the employee, signed in as Staff, then sees it read-only
// in "My assignments".
// Assignments and evaluations can never be deleted (and they pin their employee and department), so this
// spec reuses a fixed throwaway employee (BS-9191, outside the BS-98nn range global-setup sweeps) and a
// fixed department ("E2E Evaluations"). It links a Staff account it creates for the employee, points the
// department at this run's manager, opens a fresh assignment for this run, and afterwards closes whatever
// it opened, clears the manager, unlinks and archives the employee and deletes the account. Earlier runs'
// history stays and is harmless: every check uses this run's project name.
// Needs the departments, department_managers, manager_scope, assignments and assignment_evaluations migrations.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = "E2E Evaluations";
const SUBJECT = { id: "BS-9191", name: "E2E Evaluation Subject" };
const FAR_FUTURE = "2099-12-31";

const subjectRow = (department_id: string, auth_user_id: string) => ({
  employee_id: SUBJECT.id, name: SUBJECT.name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent",
  email: "e2e-evaluation-subject@example.test", joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available",
  initials: "EE", avatar_color: "mint", summary: "Throwaway row reused by tests/e2e/assignment-evaluations.spec.ts.",
  department_id, auth_user_id, archived_at: null,
});

async function closeOpen(service: SupabaseClient) {
  const closed = await service.from("assignments").update({ status: "closed", completion_date: FAR_FUTURE }).eq("employee_id", SUBJECT.id).eq("status", "open");
  if (closed.error) throw new Error(`Could not close the throwaway assignments (${closed.error.code}): ${closed.error.message}`);
}

async function prepare(service: SupabaseClient, managerUserId: string, subjectUserId: string, project: string) {
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
  await closeOpen(service);
  const subject = await service.from("employees").upsert(subjectRow(departmentId, subjectUserId), { onConflict: "employee_id", defaultToNull: false });
  if (subject.error) throw new Error(`Could not upsert the throwaway employee (${subject.error.code}): ${subject.error.message}`);
  const opened = await service.from("assignments").insert({
    employee_id: SUBJECT.id, client: "Harbour Systems (fictional)", project_name: project, role: "Developer", allocation: 60, start_date: "2026-09-01",
  });
  if (opened.error) throw new Error(`Could not open the throwaway assignment (${opened.error.code}): ${opened.error.message}`);
}

async function openCurrentWork(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("button", { name: /Employees/ }).click();
  await page.getByRole("button", { name: `View ${SUBJECT.name}'s profile` }).click();
  await page.getByRole("tab", { name: "Current work" }).click();
  return page.getByRole("tabpanel");
}

test("a manager evaluates a closed assignment and amends it; the employee sees it read-only", async ({ page, browser }) => {
  const manager = e2eManagerStaff();
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const project = `E2E evaluated project ${run}`;
  const subjectEmail = `e2e-staff-evaluation-${run}@example.test`;
  const subjectPassword = `E2e-${randomBytes(18).toString("base64url")}`;
  const created = await service.auth.admin.createUser({
    email: subjectEmail, password: subjectPassword, email_confirm: true, app_metadata: { role: "staff", employee_id: SUBJECT.id },
  });
  if (created.error || !created.data.user) throw new Error(`Could not create the subject's account: ${created.error?.message ?? "no user returned"}`);
  const subjectUserId = created.data.user.id;
  const staffContext = await browser.newContext();
  try {
    await prepare(service, account.data.auth_user_id as string, subjectUserId, project);

    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    const panel = await openCurrentWork(page);

    // The open assignment is offered no evaluation form.
    await expect(panel.getByRole("form", { name: /evaluation/i })).toHaveCount(0);
    const close = panel.getByRole("form", { name: "Close the assignment" });
    await close.getByLabel("Completion date").fill("2026-10-10");
    await close.getByRole("button", { name: "Close assignment" }).click();
    await expect(panel.getByRole("status").first()).toHaveText("Assignment closed.");

    // Write the evaluation with client feedback.
    const item = panel.getByRole("list", { name: "Work history" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: project }) });
    await expect(item.getByText("Not evaluated yet.")).toBeVisible();
    await item.getByText("Write evaluation").click();
    const write = item.getByRole("form", { name: `Write evaluation for ${project}` });
    await write.getByLabel("Evaluation").fill("Delivered the migration on time.");
    await write.getByLabel("Client feedback (optional)").fill("The client praised the hand-over.");
    await write.getByRole("button", { name: "Save evaluation" }).click();
    await expect(item.getByRole("status")).toHaveText("Evaluation saved.");
    const shown = item.getByRole("region", { name: `Evaluation of ${project}` });
    await expect(shown.getByText("Delivered the migration on time.")).toBeVisible();
    await expect(shown.getByText("The client praised the hand-over.")).toBeVisible();
    await expect(shown.getByText(/^Written by .+ on \d{1,2} [A-Z][a-z]{2} \d{4}$/)).toBeVisible();
    await expect(item.getByText("Amend evaluation")).toBeVisible();

    // Amend it.
    await item.getByText("Amend evaluation").click();
    const amend = item.getByRole("form", { name: `Amend evaluation for ${project}` });
    await amend.getByLabel("Evaluation").fill("Delivered the migration on time; documentation was thorough.");
    await amend.getByRole("button", { name: "Save amendment" }).click();
    await expect(item.getByRole("status")).toHaveText("Evaluation updated.");
    await expect(shown.getByText("Delivered the migration on time; documentation was thorough.")).toBeVisible();
    await expect(shown.getByText(/ · amended by .+ on \d{1,2} [A-Z][a-z]{2} \d{4}$/)).toBeVisible();

    // The employee sees it read-only in "My assignments".
    const staff = await staffContext.newPage();
    await staff.goto("/");
    await signIn(staff, subjectEmail, subjectPassword);
    const mine = staff.locator("section").filter({ has: staff.getByRole("heading", { name: "My assignments" }) });
    await expect(mine).toBeVisible();
    const row = mine.getByRole("listitem").filter({ has: staff.getByRole("heading", { name: project }) });
    await expect(row).toContainText("Closed");
    await expect(row.getByText("Delivered the migration on time; documentation was thorough.")).toBeVisible();
    await expect(row.getByText("The client praised the hand-over.")).toBeVisible();
    // Story 4.7 adds the past-project form to the section; the assignments themselves stay read-only.
    await expect(mine.getByRole("list", { name: "Your assignments" }).locator("input, textarea, button, select, form")).toHaveCount(0);
  } finally {
    await staffContext.close();
    await closeOpen(service).catch(error => console.error(error instanceof Error ? error.message : error));
    await service.from("departments").update({ manager_user_id: null }).eq("name", DEPARTMENT);
    await service.from("employees").update({ auth_user_id: null, archived_at: new Date().toISOString() }).eq("employee_id", SUBJECT.id);
    await service.auth.admin.deleteUser(subjectUserId);
  }
});
