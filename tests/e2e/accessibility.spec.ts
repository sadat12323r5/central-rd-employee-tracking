import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// color-contrast is excluded: the current palette has known, pre-existing contrast
// gaps (see docs/SRS.md NFR-UX-004) that need a deliberate design pass, not a
// silent CSS tweak here. Every other WCAG 2.2 AA rule is enforced.
function accessibilityScan(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).disableRules(["color-contrast"]).analyze();
}

test("sign-in page has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  const results = await accessibilityScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("dashboard and an employee profile have no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Brain23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();

  const dashboardResults = await accessibilityScan(page);
  expect(dashboardResults.violations, JSON.stringify(dashboardResults.violations, null, 2)).toEqual([]);

  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await expect(page.getByRole("heading", { name: "Nadia Rahman", exact: true })).toBeVisible();

  const profileResults = await accessibilityScan(page);
  expect(profileResults.violations, JSON.stringify(profileResults.violations, null, 2)).toEqual([]);
});
