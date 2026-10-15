import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 7.3: the Administrator adds, edits and removes an employment entry on a throwaway employee's
// Employment tab; the removed entry disappears from the tab but its row is kept with removed_at set.
// The employee is BS-8850 (a range no other test uses; the Story 7.3 live test uses BS-8800..BS-8802).
// Cleanup in `finally` through the service role is soft, because history rows can never be deleted
// (a trigger refuses every delete) and employees.employee_id is ON DELETE RESTRICT: every active entry
// of the employee is removed, the employee is archived and taken out of the throwaway department, and the
// department is deleted. The next run upserts the same employee again. Needs the departments and
// employment_history migrations applied.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = `E2E History ${run} Team`;
const EMPLOYEE_ID = "BS-8850";
const NAME = `E2E Historian ${run}`;
const EMPLOYER = `Orbit Analytics ${run} (fictional)`;

test("the Administrator adds, edits and removes an employment entry on the Employment tab", async ({ page }) => {
  const service = serviceClient();
  try {
    const created = await service.from("departments").insert({ name: DEPARTMENT }).select("id").single();
    if (created.error) throw new Error(`Could not create throwaway department (${created.error.code}): ${created.error.message}`);
    // Upserted: an earlier run's archived copy of this employee is re-used (it can never be deleted).
    const upserted = await service.from("employees").upsert({
      employee_id: EMPLOYEE_ID, name: NAME, title: "Engineer", team: "Platform", employment_type: "Permanent",
      email: `e2e-historian-${run}@example.com`, joined_on: "2026-10-01", manager: "Meera Das", office: "Dhaka HQ",
      status: "Available", initials: "EH", avatar_color: "mint", summary: "", department_id: created.data.id,
      auth_user_id: null, archived_at: null,
    }, { onConflict: "employee_id", defaultToNull: false });
    if (upserted.error) throw new Error(`Could not create throwaway employee (${upserted.error.code}): ${upserted.error.message}`);

    await page.goto("/");
    await signInAsAdmin(page);
    await page.getByRole("navigation").getByRole("button", { name: /^Employees/ }).click();
    await page.getByRole("textbox", { name: "Search employees" }).fill(EMPLOYEE_ID);
    await page.getByRole("button", { name: `View ${NAME}'s profile` }).click();
    await page.getByRole("tab", { name: "Employment" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("heading", { name: "Employment history" })).toBeVisible();
    await expect(panel.getByText("No employment history has been recorded.")).toBeVisible();

    // Add.
    const add = panel.getByRole("form", { name: "Add employment entry" });
    await add.getByLabel("Role").fill("Junior Engineer");
    await add.getByLabel("Employer").fill(EMPLOYER);
    await add.getByLabel("Period").fill("2021 – 2022");
    await add.getByLabel("Detail (optional)").fill("Built internal tools.");
    await add.getByRole("button", { name: "Add entry" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Employment entry added." })).toBeVisible();
    await expect(panel.locator(".timeline-item")).toHaveCount(1);
    await expect(panel.locator(".timeline-item h3")).toHaveText("Junior Engineer");

    // Edit.
    await panel.getByRole("button", { name: `Edit employment entry: Junior Engineer, ${EMPLOYER}` }).click();
    const edit = panel.getByRole("form", { name: `Edit employment entry: Junior Engineer, ${EMPLOYER}` });
    await expect(edit.getByLabel("Period")).toHaveValue("2021 – 2022");
    await edit.getByLabel("Role").fill("Software Engineer");
    await edit.getByRole("button", { name: "Save entry" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Employment entry saved." })).toBeVisible();
    await expect(panel.locator(".timeline-item h3")).toHaveText("Software Engineer");

    // Remove (with a confirmation step).
    await panel.getByRole("button", { name: `Remove employment entry: Software Engineer, ${EMPLOYER}` }).click();
    await panel.getByRole("button", { name: "Confirm remove" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Employment entry removed. It is kept in the record's history." })).toBeVisible();
    await expect(panel.locator(".timeline-item")).toHaveCount(0);
    await expect(panel.getByText("No employment history has been recorded.")).toBeVisible();

    // The row is kept, with removed_at set.
    const { data, error } = await service.from("employment_history").select("role,employer,period,removed_at").eq("employee_id", EMPLOYEE_ID).eq("employer", EMPLOYER);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ role: "Software Engineer", period: "2021 – 2022" });
    expect(data![0].removed_at).not.toBeNull();
  } finally {
    await service.from("employment_history").update({ removed_at: new Date().toISOString() }).eq("employee_id", EMPLOYEE_ID).is("removed_at", null);
    await service.from("employees").update({ archived_at: new Date().toISOString(), department_id: null }).eq("employee_id", EMPLOYEE_ID);
    await service.from("departments").delete().eq("name", DEPARTMENT);
  }
});
