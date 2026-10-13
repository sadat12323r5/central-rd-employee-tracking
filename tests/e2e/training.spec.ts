import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eStaff, signIn } from "./staff";

// Story 3.1: completed training is read from `training_history`; Story 3.2: in-progress enrolments come
// from the LMS adapter (its stub reads `lms_stub_enrolments`). Both are seeded by `npm run db:seed` after
// their migrations. Both tests only read: the Administrator opens a seeded demo employee, and a
// throwaway Staff account (no training rows, no LMS enrolments) sees the empty states. Seeded stub data
// may be stale (synced more than 24 hours ago); the tests do not depend on that label.

test("the Administrator sees Nadia's completed training and her in-progress LMS enrolment", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await page.getByRole("tab", { name: "Training", exact: true }).click();
  const panel = page.getByRole("tabpanel");
  const completed = panel.getByRole("region", { name: "Completed training" });
  await expect(completed.getByRole("heading", { name: "React · practical foundations" })).toBeVisible();
  await expect(completed.getByText("Completed: 20 Aug 2026")).toBeVisible();
  await expect(completed.getByText("Completed · assessment passed")).toBeVisible();
  const current = panel.getByRole("region", { name: "Current enrolments" });
  await expect(current.getByRole("heading", { name: "Technical leadership & collaboration" })).toBeVisible();
  await expect(current.getByText("Target completion: 28 Sep 2026")).toBeVisible();
  await expect(current.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: /back to/i }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Learning & development" }).click();
  const nadia = page.getByRole("row").filter({ hasText: "Nadia Rahman" });
  await expect(nadia).toHaveCount(2);
  await expect(nadia.filter({ hasText: "React · practical foundations" })).toContainText("20 Aug 2026");
  await expect(nadia.filter({ hasText: "Technical leadership & collaboration" })).toContainText("28 Sep 2026");
});

test("a staff member sees the Current enrolments and Completed training sections, with empty states when there are none", async ({ page }) => {
  const staff = e2eStaff(2);
  await page.goto("/");
  await signIn(page, staff.email, staff.password);
  await expect(page.getByRole("heading", { name: "Current enrolments" })).toBeVisible();
  await expect(page.getByText("No current enrolments.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Your current enrolments" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Completed training" })).toBeVisible();
  await expect(page.getByText("You have no completed training on record yet.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Your completed training" })).toHaveCount(0);
});
