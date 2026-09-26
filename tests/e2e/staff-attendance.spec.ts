import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// color-contrast is excluded for the same reason as accessibility.spec.ts.
function accessibilityScan(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).disableRules(["color-contrast"]).analyze();
}

// Records live in server memory, so this uses an employee no other spec signs in as.
test("a staff member clocks in, writes a daily log and clocks out", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("rafi.ahmed@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Staff23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();

  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  let results = await accessibilityScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await page.getByRole("radio", { name: "Remote" }).check();
  await page.getByRole("button", { name: "Clock in" }).click();
  await expect(page.getByRole("button", { name: "Clock out" })).toBeVisible();

  await page.getByLabel("What did you work on today?").fill("Reviewed the regression suite.");
  await page.getByRole("textbox", { name: "Task 1" }).fill("Regression review");
  await page.getByRole("spinbutton", { name: "Hours" }).fill("0.25");
  await page.getByRole("button", { name: "Save log" }).click();
  await expect(page.getByText("Daily log saved.")).toBeVisible();

  results = await accessibilityScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await page.getByRole("button", { name: "Clock out" }).click();
  await expect(page.getByRole("cell", { name: "Completed" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "1 task" })).toBeVisible();
});

test("staff cannot see the manager portal", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("sara.islam@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Staff23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  await expect(page.getByText("A clearer view of your people.")).toHaveCount(0);
});
