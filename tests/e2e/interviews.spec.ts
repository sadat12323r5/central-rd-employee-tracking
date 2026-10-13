import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eStaff, signIn } from "./staff";

// Story 2.1: a staff member reports an external interview and the Administrator sees it with no extra
// step. Uses throwaway Staff account 2 (global-setup.ts links it to a throwaway employee;
// global-teardown.ts deletes that employee's interviews before the employee). Needs the
// external_interviews migration applied to the shared project.
test("a staff member adds an external interview and the Administrator sees it", async ({ page }) => {
  const staff = e2eStaff(2);
  const company = `E2E Interview Co ${randomBytes(4).toString("hex")}`;

  await page.goto("/");
  await signIn(page, staff.email, staff.password);
  await expect(page.getByRole("heading", { name: "External interviews" })).toBeVisible();

  await page.getByRole("textbox", { name: "Company" }).fill(company);
  await page.getByRole("textbox", { name: "Role" }).fill("Platform Engineer");
  await page.getByLabel("Interview date").fill("2026-10-20");
  await page.getByRole("textbox", { name: "Stage", exact: true }).fill("Recruiter screen");
  await page.getByRole("button", { name: "Add interview" }).click();
  await expect(page.getByText("Interview added.")).toBeVisible();

  const ownRow = page.getByRole("table", { name: "Your external interviews" }).getByRole("row").filter({ hasText: company });
  await expect(ownRow).toContainText("Platform Engineer");
  await expect(ownRow).toContainText("20 Oct 2026");
  await expect(ownRow).toContainText("Recruiter screen");
  await expect(ownRow).toContainText("No outcome yet");

  // Persisted: still there after a reload.
  await page.reload();
  await expect(page.getByRole("table", { name: "Your external interviews" }).getByRole("row").filter({ hasText: company })).toHaveCount(1);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();

  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(staff.id);
  await page.getByRole("button", { name: /^View .*'s profile$/ }).click();
  await page.getByRole("tab", { name: "Interviews", exact: true }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: company })).toBeVisible();
  await expect(panel.getByText("20 Oct 2026 · Recruiter screen")).toBeVisible();
  await expect(panel.getByText("No outcome yet")).toBeVisible();

  await page.getByRole("button", { name: /back to/i }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Interviews & placements" }).click();
  const row = page.getByRole("row").filter({ hasText: company });
  await expect(row).toContainText("Platform Engineer");
  await expect(row).toContainText("20 Oct 2026");
  await expect(row).toContainText("No outcome yet");
});

// Story 2.2: the author updates stage, outcome and feedback, then withdraws the entry; it leaves both
// active views but stays in history labelled "Withdrawn", and the Administrator sees it with no controls.
// Uses throwaway Staff account 2 like the 2.1 test. Needs both interview migrations applied.
test("a staff member updates and withdraws an interview; the Administrator sees it in history only", async ({ page }) => {
  const staff = e2eStaff(2);
  const company = `E2E Withdraw Co ${randomBytes(4).toString("hex")}`;
  const ownTable = () => page.getByRole("table", { name: "Your external interviews" });

  await page.goto("/");
  await signIn(page, staff.email, staff.password);
  await page.getByRole("textbox", { name: "Company" }).fill(company);
  await page.getByRole("textbox", { name: "Role" }).fill("Data Engineer");
  await page.getByLabel("Interview date").fill("2026-10-22");
  await page.getByRole("textbox", { name: "Stage", exact: true }).fill("Recruiter screen");
  await page.getByRole("button", { name: "Add interview" }).click();
  await expect(page.getByText("Interview added.")).toBeVisible();

  // Update: only stage, outcome and feedback are offered.
  const row = ownTable().getByRole("row").filter({ hasText: company });
  await row.getByText("Update", { exact: true }).click();
  await expect(row.locator('[name="company"], [name="role"], [name="date"]')).toHaveCount(0);
  await row.getByRole("textbox", { name: `Stage · ${company}` }).fill("Final round");
  await row.getByRole("textbox", { name: `Outcome (optional) · ${company}` }).fill("Awaiting offer");
  await row.getByRole("textbox", { name: `Feedback (optional) · ${company}` }).fill("Strong system design discussion.");
  await row.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Interview updated.")).toBeVisible();
  await page.reload();
  const updated = ownTable().getByRole("row").filter({ hasText: company });
  await expect(updated).toContainText("Final round");
  await expect(updated).toContainText("Awaiting offer");
  await expect(updated).toContainText("Strong system design discussion.");

  // Withdraw: leaves the active table, appears in the Withdrawn history.
  await updated.getByText("Update", { exact: true }).click();
  await updated.getByRole("button", { name: new RegExp(`^Withdraw interview: ${company}`) }).click();
  await expect(page.getByText("Interview withdrawn.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: company })).toHaveCount(0);
  const history = page.getByRole("list", { name: "Withdrawn (history)" }).getByRole("listitem").filter({ hasText: company });
  await expect(history).toContainText("Withdrawn");
  await expect(history.getByRole("button")).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Interviews & placements" }).click();
  await expect(page.getByRole("row").filter({ hasText: company })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(staff.id);
  await page.getByRole("button", { name: /^View .*'s profile$/ }).click();
  await page.getByRole("tab", { name: "Interviews", exact: true }).click();
  const withdrawn = page.getByRole("region", { name: "Withdrawn (history)" });
  await expect(withdrawn.getByRole("heading", { name: company })).toBeVisible();
  await expect(withdrawn.getByText("Withdrawn", { exact: true })).toBeVisible();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("button", { name: /withdraw|update|save/i })).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(0);
});
