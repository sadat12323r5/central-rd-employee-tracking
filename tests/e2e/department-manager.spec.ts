import { randomBytes } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eManagerStaff, e2eNoAccountEmployee, e2eUnlinkedEmployee, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 4.2: the Administrator makes a throwaway Staff account the manager of a throwaway department;
// that account's next request reaches the management portal (no Interviews & placements, no
// Departments); removing the manager returns it to the staff portal on its next request. An employee
// without a sign-in account is refused with the provision-first message.
// Two browser contexts: A is the Administrator, B the Staff member being made a manager. The department
// carries this run's id and is deleted in afterAll through the service role (its manager goes with it).
// Story 4.3: a manager of a throwaway department sees only that department's throwaway employees in the
// directory, with the department's name, and none of the seeded demo employees.
// Needs the departments, department_managers and manager_scope migrations applied to the shared project.
const run = randomBytes(4).toString("hex");
const PREFIX = `E2E Mgr ${run}`;

/** Postgres / PostgREST "table/column does not exist" codes, returned until the migrations are applied. */
const SCHEMA_MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

test.afterAll(async () => {
  const service = serviceClient();
  const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
  if (deleted.error && !SCHEMA_MISSING.has(deleted.error.code)) throw new Error(`Could not delete throwaway departments: ${deleted.error.message}`);
});

async function openDepartments(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Departments" }).click();
  await expect(page.getByRole("heading", { name: "Departments", level: 1 })).toBeVisible();
}

function departmentRow(page: Page, name: string): Locator {
  return page.getByRole("table", { name: "Departments" }).getByRole("row").filter({ has: page.getByLabel(`Edit department: ${name}`, { exact: true }) });
}

/** Opens the row's manager form, chooses `value` (an Employee ID or "none") and saves. */
async function setManager(page: Page, department: string, value: string) {
  const row = departmentRow(page, department);
  const summary = row.getByLabel(`Set manager: ${department}`, { exact: true });
  const select = row.getByLabel(/^Manager/);
  if (!(await select.isVisible())) await summary.click();
  await select.selectOption(value);
  await row.getByRole("button", { name: "Save manager" }).click();
}

test("the Administrator assigns and removes a department manager; the manager's portal follows on the next request", async ({ browser }) => {
  const manager = e2eManagerStaff();
  const department = `${PREFIX} Team`;
  const { baseURL, viewport } = test.info().project.use;
  const adminContext = await browser.newContext({ baseURL, viewport });
  const managerContext = await browser.newContext({ baseURL, viewport });
  const admin = await adminContext.newPage();
  const member = await managerContext.newPage();

  try {
    // B: before anything, the Staff account gets the staff portal.
    await member.goto("/");
    await signIn(member, manager.email, manager.password);
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();

    // A: add a throwaway department; it starts with no manager.
    await admin.goto("/");
    await signInAsAdmin(admin);
    await openDepartments(admin);
    const addForm = admin.getByRole("form", { name: "Add a department" });
    await addForm.getByLabel("Department name").fill(department);
    await addForm.getByRole("button", { name: "Add department" }).click();
    await expect(addForm.getByText("Department added.")).toBeVisible();
    await expect(departmentRow(admin, department).getByRole("cell").nth(2)).toHaveText("No manager");

    // A: make the Staff account its manager.
    await setManager(admin, department, manager.id);
    await expect(admin.getByText("Manager updated.")).toBeVisible();
    await expect(departmentRow(admin, department).getByRole("cell").nth(2)).toHaveText(manager.name);

    // B: the next request is a manager session: the management portal without interviews or departments.
    await member.reload();
    await expect(member.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    const nav = member.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("button", { name: "Employees" })).toBeVisible();
    await expect(nav.getByRole("button", { name: /Interviews & placements/ })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Departments" })).toHaveCount(0);
    await expect(member.getByText("Department manager")).toBeVisible();
    await expect(member.getByText("Upcoming interviews")).toHaveCount(0);

    // A: remove the manager.
    await admin.reload();
    await openDepartments(admin);
    await setManager(admin, department, "none");
    await expect(admin.getByText("Manager removed.")).toBeVisible();
    await expect(departmentRow(admin, department).getByRole("cell").nth(2)).toHaveText("No manager");

    // B: the next request is plain Staff again.
    await member.reload();
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();
    await expect(member.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  } finally {
    await adminContext.close();
    await managerContext.close();
  }
});

test("an employee without a sign-in account is refused as manager with the provision-first message", async ({ page }) => {
  const employee = e2eNoAccountEmployee();
  const department = `${PREFIX} Unstaffed`;
  await page.goto("/");
  await signInAsAdmin(page);
  await openDepartments(page);
  const addForm = page.getByRole("form", { name: "Add a department" });
  await addForm.getByLabel("Department name").fill(department);
  await addForm.getByRole("button", { name: "Add department" }).click();
  await expect(addForm.getByText("Department added.")).toBeVisible();

  const row = departmentRow(page, department);
  await row.getByLabel(`Set manager: ${department}`, { exact: true }).click();
  await expect(row.getByLabel(/^Manager/).locator(`option[value="${employee.id}"]`)).toHaveText(`${employee.name} (${employee.id}) · no account`);
  await setManager(page, department, employee.id);
  await expect(row.getByRole("alert")).toHaveText(`${employee.name} has no sign-in account yet. Provision their account first, then make them a manager.`);
  await expect(row.getByRole("cell").nth(2)).toHaveText("No manager");
});

test("a manager sees only their department's employees, with the department name (Story 4.3)", async ({ page }) => {
  const manager = e2eManagerStaff();
  const members = [e2eUnlinkedEmployee(), e2eNoAccountEmployee()];
  const department = `${PREFIX} Scoped`;
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const created = await service.from("departments").insert({ name: department, manager_user_id: account.data.auth_user_id }).select("id").single();
  if (created.error) throw new Error(`Could not create the throwaway department (${created.error.code}): ${created.error.message}`);
  const departmentId = created.data.id as string;
  const memberIds = members.map(m => m.id);
  try {
    const placed = await service.from("employees").update({ department_id: departmentId }).in("employee_id", memberIds);
    if (placed.error) throw new Error(`Could not place the throwaway employees: ${placed.error.message}`);

    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await nav.getByRole("button", { name: /Employees/ }).click();
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(members.length + 1);
    for (const member of members) {
      await expect(table.getByRole("row").filter({ hasText: member.name })).toContainText(department);
    }
    // None of the seeded demo employees, and not the manager's own record (outside the department).
    await expect(table.getByText("Nadia Rahman")).toHaveCount(0);
    await expect(table.getByText(manager.name)).toHaveCount(0);
    await expect(nav.getByRole("button", { name: /Employees/ })).toContainText(String(members.length));
  } finally {
    await service.from("employees").update({ department_id: null }).in("employee_id", memberIds);
    await service.from("departments").delete().eq("id", departmentId);
  }
});
