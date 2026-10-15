import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { e2eManagerStaff, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.5: a manager of a throwaway department creates an assignment for a throwaway employee, edits
// its latest update and closes it; it then appears in history. A second create while one is open (opened
// meanwhile elsewhere) shows the rejection.
// Assignments can never be deleted (and they pin their employee and department), so this spec reuses a
// fixed throwaway employee (BS-9190, outside the BS-98nn range global-setup sweeps) and a fixed department
// ("E2E Assignments"), points the department at this run's manager, and afterwards closes whatever it
// opened, clears the manager and archives the employee. Closed history from earlier runs stays and is
// harmless: every check uses this run's project name.
// Needs the departments, department_managers, manager_scope and assignments migrations applied.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = "E2E Assignments";
const SUBJECT = { id: "BS-9190", name: "E2E Assignment Subject" };
const FAR_FUTURE = "2099-12-31";

const subjectRow = (department_id: string) => ({
  employee_id: SUBJECT.id, name: SUBJECT.name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent",
  email: "e2e-assignment-subject@example.test", joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available",
  initials: "EA", avatar_color: "mint", summary: "Throwaway row reused by tests/e2e/assignments.spec.ts.", department_id, archived_at: null,
});

async function closeOpen(service: SupabaseClient) {
  const closed = await service.from("assignments").update({ status: "closed", completion_date: FAR_FUTURE }).eq("employee_id", SUBJECT.id).eq("status", "open");
  if (closed.error) throw new Error(`Could not close the throwaway assignments (${closed.error.code}): ${closed.error.message}`);
}

async function prepare(service: SupabaseClient, managerUserId: string) {
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
  const subject = await service.from("employees").upsert(subjectRow(departmentId), { onConflict: "employee_id", defaultToNull: false });
  if (subject.error) throw new Error(`Could not upsert the throwaway employee (${subject.error.code}): ${subject.error.message}`);
}

async function openCurrentWork(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("button", { name: /Employees/ }).click();
  await page.getByRole("button", { name: `View ${SUBJECT.name}'s profile` }).click();
  await page.getByRole("tab", { name: "Current work" }).click();
  return page.getByRole("tabpanel");
}

test("a manager creates, updates and closes an assignment; a second open one is rejected", async ({ page }) => {
  const manager = e2eManagerStaff();
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const project = `E2E project ${run}`;
  try {
    await prepare(service, account.data.auth_user_id as string);

    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    const panel = await openCurrentWork(page);

    // Create: no department field; the department shown is the employee's own.
    const create = panel.getByRole("form", { name: "Create an assignment" });
    await expect(create.getByLabel(/Department/)).toHaveCount(0);
    await create.getByLabel("Client").fill("Northwind (fictional)");
    await create.getByLabel("Project name").fill(project);
    await create.getByLabel("Role").fill("Developer");
    await create.getByLabel("Allocation (%)").fill("60");
    await create.getByLabel("Start date").fill("2026-10-01");
    await create.getByRole("button", { name: "Create assignment" }).click();
    await expect(panel.getByRole("status")).toHaveText("Assignment created.");
    await expect(panel.getByRole("heading", { name: project })).toBeVisible();
    for (const text of ["Northwind (fictional)", "Developer", "60%", "1 Oct 2026", DEPARTMENT]) await expect(panel.getByText(text, { exact: true })).toBeVisible();
    await expect(panel.getByText("Recorded Git activity")).toHaveCount(0);
    await expect(panel.getByRole("form", { name: "Create an assignment" })).toHaveCount(0);

    // Edit the latest update.
    const note = panel.getByRole("form", { name: "Edit the latest update" });
    await note.getByLabel("Latest update").fill("Kick-off done; first sprint planned.");
    await note.getByRole("button", { name: "Save update" }).click();
    await expect(panel.getByRole("status")).toHaveText("Latest update saved.");
    await expect(panel.getByText("Kick-off done; first sprint planned.", { exact: true }).first()).toBeVisible();

    // Close it: it moves to history, with no edit or close control.
    const close = panel.getByRole("form", { name: "Close the assignment" });
    await close.getByLabel("Completion date").fill("2026-10-10");
    await close.getByRole("button", { name: "Close assignment" }).click();
    await expect(panel.getByRole("status")).toHaveText("Assignment closed.");
    const item = panel.getByRole("list", { name: "Closed assignments" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: project }) });
    await expect(item).toContainText("Closed");
    await expect(item).toContainText("1 Oct 2026 – 10 Oct 2026");
    await expect(item.getByRole("button")).toHaveCount(0);

    // Another open assignment appears meanwhile (say, another manager): this form's create is rejected.
    const again = panel.getByRole("form", { name: "Create an assignment" });
    await expect(again).toBeVisible();
    const elsewhere = await service.from("assignments").insert({
      employee_id: SUBJECT.id, client: "Elsewhere (fictional)", project_name: `E2E elsewhere ${run}`, role: "Developer", allocation: 20, start_date: "2026-10-11",
    });
    if (elsewhere.error) throw new Error(`Could not open the competing assignment (${elsewhere.error.code}): ${elsewhere.error.message}`);
    await again.getByLabel("Client").fill("Northwind (fictional)");
    await again.getByLabel("Project name").fill(`${project} second`);
    await again.getByLabel("Role").fill("Developer");
    await again.getByLabel("Allocation (%)").fill("40");
    await again.getByLabel("Start date").fill("2026-10-12");
    await again.getByRole("button", { name: "Create assignment" }).click();
    await expect(panel.getByRole("alert")).toHaveText("This employee already has an open assignment. Close it first.");
    const saved = await service.from("assignments").select("id").eq("employee_id", SUBJECT.id).eq("project_name", `${project} second`);
    expect(saved.data ?? []).toEqual([]);
  } finally {
    await closeOpen(service).catch(error => console.error(error instanceof Error ? error.message : error));
    await service.from("departments").update({ manager_user_id: null }).eq("name", DEPARTMENT);
    await service.from("employees").update({ archived_at: new Date().toISOString() }).eq("employee_id", SUBJECT.id);
  }
});
