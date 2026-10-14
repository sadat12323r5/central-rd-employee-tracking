import { randomBytes, randomInt } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 7.1: the Administrator adds a throwaway employee to a throwaway department through the Employees
// view; the employee appears in the directory with that department, and their profile offers the
// Story 1.3 "create account" panel (no account is created as a side effect). The department carries
// this run's id and the employee a random BS-88xx id (a range no other test uses); both are deleted in
// `finally` through the service role. Needs the departments and employee_create migrations applied.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = `E2E Add ${run} Team`;
const EMPLOYEE_ID = `BS-88${String(randomInt(0, 100)).padStart(2, "0")}`;
const NAME = `E2E Joiner ${run}`;
const EMAIL = `e2e-joiner-${run}@example.com`;

test("the Administrator adds a new employee, who appears in the directory and can be given an account", async ({ page }) => {
  const service = serviceClient();
  try {
    // Leftover from an aborted run with the same random id.
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    const created = await service.from("departments").insert({ name: DEPARTMENT }).select("id").single();
    if (created.error) throw new Error(`Could not create throwaway department (${created.error.code}): ${created.error.message}`);

    await page.goto("/");
    await signInAsAdmin(page);
    await page.getByRole("navigation").getByRole("button", { name: /^Employees/ }).click();

    const form = page.getByRole("form", { name: "Add an employee" });
    await form.getByLabel("Employee ID").fill(EMPLOYEE_ID);
    await form.getByLabel("Full name").fill(NAME);
    await form.getByLabel("Job title").fill("Trainee Software Engineer");
    await form.getByLabel("Team").fill("Platform");
    await form.getByLabel("Email address").fill(EMAIL);
    await form.getByLabel("Department").selectOption({ label: DEPARTMENT });
    await form.getByLabel("Reporting manager").fill("Meera Das");
    await form.getByLabel("Office").fill("Dhaka HQ");
    await form.getByLabel("Employment type").selectOption("Trainee");
    await form.getByRole("button", { name: "Add employee" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${NAME} was added.` })).toBeVisible();

    // In the directory, with its department.
    await page.getByRole("textbox", { name: "Search employees" }).fill(EMPLOYEE_ID);
    const row = page.getByRole("row").filter({ hasText: NAME });
    await expect(row).toContainText(DEPARTMENT);

    // The profile offers the Story 1.3 account panel: no account was created.
    await page.getByRole("button", { name: `View ${NAME}'s profile` }).click();
    await expect(page.getByRole("heading", { name: NAME, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign-in account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Staff account" })).toBeVisible();
    await expect(page.getByText("Has a sign-in account")).toHaveCount(0);

    const { data } = await service.from("employees").select("department_id,auth_user_id,status").eq("employee_id", EMPLOYEE_ID).single();
    expect(data).toEqual({ department_id: created.data.id, auth_user_id: null, status: "Available" });
  } finally {
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    await service.from("departments").delete().eq("name", DEPARTMENT);
  }
});
