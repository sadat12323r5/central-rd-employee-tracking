import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eStaff, signIn } from "./staff";

// Story 3.1: completed training is read from `training_history` (seeded by `npm run db:seed` after the
// training_history migration). Both tests only read: the Administrator opens a seeded demo employee,
// and a throwaway Staff account (no training rows, no fixture entry) sees the empty state.

test("the Administrator sees Nadia's completed training next to her in-progress training", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await page.getByRole("tab", { name: "Training", exact: true }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "React · practical foundations" })).toBeVisible();
  await expect(panel.getByText("Completed: 20 Aug 2026")).toBeVisible();
  await expect(panel.getByText("Completed · assessment passed")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Technical leadership & collaboration" })).toBeVisible();
  await expect(panel.getByText("Target completion: 28 Sep 2026")).toBeVisible();

  await page.getByRole("button", { name: /back to/i }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Learning & development" }).click();
  const nadia = page.getByRole("row").filter({ hasText: "Nadia Rahman" });
  await expect(nadia).toHaveCount(2);
  await expect(nadia.filter({ hasText: "React · practical foundations" })).toContainText("20 Aug 2026");
});

test("a staff member sees the Completed training section, with an empty state when there is none", async ({ page }) => {
  const staff = e2eStaff(2);
  await page.goto("/");
  await signIn(page, staff.email, staff.password);
  await expect(page.getByRole("heading", { name: "Completed training" })).toBeVisible();
  await expect(page.getByText("You have no completed training on record yet.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Your completed training" })).toHaveCount(0);
});
