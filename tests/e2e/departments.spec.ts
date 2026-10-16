import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 4.1: the Administrator adds a department, renames it and moves it under another, and there is no
// delete control. Department names carry this run's id; the teardown below deletes them through the
// service role (children detached first: parent_department_id is ON DELETE RESTRICT). Needs the
// departments migration applied to the shared project.
const run = randomBytes(4).toString("hex");
const PREFIX = `E2E Dept ${run}`;

/** Postgres / PostgREST "table does not exist" codes, returned until the departments migration is applied. */
const SCHEMA_MISSING = new Set(["42P01", "PGRST205"]);

test.afterAll(async () => {
  const service = serviceClient();
  const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
  if (detached.error && !SCHEMA_MISSING.has(detached.error.code)) throw new Error(`Could not detach throwaway departments: ${detached.error.message}`);
  const deleted = await service.from("departments").delete().like("name", `${PREFIX}%`);
  if (deleted.error && !SCHEMA_MISSING.has(deleted.error.code)) throw new Error(`Could not delete throwaway departments: ${deleted.error.message}`);
});

test("the Administrator adds, renames and re-parents a department, with no delete control", async ({ page }) => {
  const parent = `${PREFIX} Parent`;
  const added = `${PREFIX} Lab`;
  const renamed = `${PREFIX} Quality Lab`;

  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Departments" }).click();
  await expect(page.getByRole("heading", { name: "Departments", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Departments" });
  const addForm = page.getByRole("form", { name: "Add a department" });

  // A top-level department, then another one (also top level) to move under it.
  for (const name of [parent, added]) {
    await addForm.getByLabel("Department name").fill(name);
    await addForm.getByLabel("Parent department").selectOption({ label: "Top level" });
    await addForm.getByRole("button", { name: "Add department" }).click();
    await expect(addForm.getByText("Department added.")).toBeVisible();
    const listed = table.getByRole("row").filter({ has: page.getByLabel(`Edit department: ${name}`, { exact: true }) });
    await expect(listed.getByRole("cell").nth(1)).toHaveText("Top level");
  }

  // Rename and re-parent the second one in one save.
  const row = table.getByRole("row").filter({ has: page.getByLabel(`Edit department: ${added}`, { exact: true }) });
  await row.getByLabel(`Edit department: ${added}`, { exact: true }).click();
  const nameField = row.getByLabel(/^Department name/);
  const parentField = row.getByLabel(/^Parent department/);
  await nameField.fill(renamed);
  await parentField.selectOption({ label: parent });
  // Pinned before saving: the row's labels follow the new name once the page refreshes.
  const saveButton = row.getByRole("button", { name: "Save department" });
  const status = page.getByText("Department updated.");
  await saveButton.click();
  await expect(status).toBeVisible();

  // Persisted: after a reload the renamed department is listed under its new parent.
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Departments" }).click();
  const saved = page.getByRole("table", { name: "Departments" }).getByRole("row").filter({ has: page.getByLabel(`Edit department: ${renamed}`, { exact: true }) });
  await expect(saved.getByRole("cell").nth(0)).toHaveText(renamed);
  await expect(saved.getByRole("cell").nth(1)).toHaveText(parent);

  // No way to delete a department anywhere in the section.
  await expect(page.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);
});

test("the directory shows each employee's department", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await expect(page.getByRole("columnheader", { name: "Department" })).toBeVisible();
  // Seeded fixture employee: db:seed places every fixture employee in Central R&D.
  await page.getByRole("textbox", { name: "Search employees" }).fill("BS-1001");
  const nadia = page.getByRole("row").filter({ hasText: "Nadia Rahman" });
  await expect(nadia).toContainText("Central R&D");
});
