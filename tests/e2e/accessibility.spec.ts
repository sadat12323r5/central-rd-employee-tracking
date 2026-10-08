import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { e2eAdmin, signInAsAdmin } from "./admin";

function fullScan(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
}

test("sign-in page has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  const results = await fullScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("sign-in error message meets contrast", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(e2eAdmin().email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "incorrect" })).toBeVisible();
  const results = await fullScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

async function expectNoViolations(page: Page, label: string) {
  const results = await fullScan(page);
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

const profileTabs = ["Overview", "Employment", "Training", "Skills & evaluation", "Current work", "Interviews", "Attendance"];

test("dashboard, directory and every employee profile tab have no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await expectNoViolations(page, "dashboard");

  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
  await expectNoViolations(page, "directory");

  await page.getByRole("textbox", { name: "Search employees" }).fill("No matching employee");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expectNoViolations(page, "directory empty state");

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await expect(page.getByRole("heading", { name: "Nadia Rahman", exact: true })).toBeVisible();
  for (const name of profileTabs) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expectNoViolations(page, `profile tab "${name}"`);
  }
});
