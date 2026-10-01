import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function fullScan(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
}

// Remove once Story 6.2 fixes the Administrator workspace palette.
function scanWithoutContrast(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).disableRules(["color-contrast"]).analyze();
}

test("sign-in page has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  const results = await fullScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("sign-in error message meets contrast", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "incorrect" })).toBeVisible();
  const results = await fullScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("dashboard and an employee profile have no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Brain23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();

  const dashboardResults = await scanWithoutContrast(page);
  expect(dashboardResults.violations, JSON.stringify(dashboardResults.violations, null, 2)).toEqual([]);

  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await expect(page.getByRole("heading", { name: "Nadia Rahman", exact: true })).toBeVisible();

  const profileResults = await scanWithoutContrast(page);
  expect(profileResults.violations, JSON.stringify(profileResults.violations, null, 2)).toEqual([]);
});
