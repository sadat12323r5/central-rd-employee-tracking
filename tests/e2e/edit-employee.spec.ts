import { randomBytes, randomInt } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 7.2: the Administrator opens a throwaway employee's profile, edits the title and office, and sees
// the success message and the new title in the profile header. There is no department control: the
// department is shown read-only. The department carries this run's id and the employee a random
// BS-8750..BS-8799 id (a range no other test uses); both are deleted in `finally` through the service
// role. Needs the departments and employee_details_update migrations applied.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = `E2E Edit ${run} Team`;
const EMPLOYEE_ID = `BS-87${String(randomInt(50, 100)).padStart(2, "0")}`;
const NAME = `E2E Editee ${run}`;

test("the Administrator edits an employee's basic details and sees them on the profile", async ({ page }) => {
  const service = serviceClient();
  try {
    // Leftover from an aborted run with the same random id.
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    const created = await service.from("departments").insert({ name: DEPARTMENT }).select("id").single();
    if (created.error) throw new Error(`Could not create throwaway department (${created.error.code}): ${created.error.message}`);
    const inserted = await service.from("employees").insert({
      employee_id: EMPLOYEE_ID, name: NAME, title: "Junior Engineer", team: "Platform", employment_type: "Trainee",
      email: `e2e-editee-${run}@example.com`, joined_on: "2026-10-01", manager: "Meera Das", office: "Dhaka HQ",
      status: "Available", initials: "EE", avatar_color: "mint", summary: "", department_id: created.data.id,
    }, { defaultToNull: false });
    if (inserted.error) throw new Error(`Could not create throwaway employee (${inserted.error.code}): ${inserted.error.message}`);

    await page.goto("/");
    await signInAsAdmin(page);
    await page.getByRole("navigation").getByRole("button", { name: /^Employees/ }).click();
    await page.getByRole("textbox", { name: "Search employees" }).fill(EMPLOYEE_ID);
    await page.getByRole("button", { name: `View ${NAME}'s profile` }).click();
    await expect(page.getByRole("heading", { name: NAME, exact: true })).toBeVisible();

    const form = page.getByRole("form", { name: "Edit employee details" });
    await expect(form.getByLabel("Job title")).toHaveValue("Junior Engineer");
    // No department control; the department is shown read-only.
    await expect(form.getByLabel(/department/i)).toHaveCount(0);
    await expect(form.getByText(DEPARTMENT)).toBeVisible();
    await expect(form.getByText("Changes through a transfer.")).toBeVisible();

    await form.getByLabel("Job title").fill("Senior Engineer");
    await form.getByLabel("Office").fill("Chattogram");
    await form.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${NAME}'s details were saved.` })).toBeVisible();
    await expect(page.locator(".profile-title")).toContainText("Senior Engineer");
    await expect(page.locator(".profile-meta")).toContainText("Chattogram");

    const { data } = await service.from("employees").select("title,office,team,department_id").eq("employee_id", EMPLOYEE_ID).single();
    expect(data).toEqual({ title: "Senior Engineer", office: "Chattogram", team: "Platform", department_id: created.data.id });
  } finally {
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    await service.from("departments").delete().eq("name", DEPARTMENT);
  }
});
