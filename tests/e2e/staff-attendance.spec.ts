import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { e2eStaff, signIn } from "./staff";

async function accessibilityScan(page: Page) {
  // Server Actions here revalidate the page in place; React briefly detaches and
  // reattaches the hoisted <title> node while patching in the fresh RSC payload.
  // Wait past that gap rather than scanning mid-transition.
  await page.waitForFunction(() => document.title.length > 0);
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
}

// Records live in server memory, so this uses a throwaway Staff account no other spec signs in as
// (global-setup.ts provisions it through the service role and links it to a throwaway employee).
test("a staff member clocks in, writes a daily log and clocks out", async ({ page }) => {
  const staff = e2eStaff(1);
  await page.goto("/");
  await signIn(page, staff.email, staff.password);

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

  results = await accessibilityScan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

// A different account from the test above, which completes its account's entry for today.
test("staff cannot see the manager portal", async ({ page }) => {
  const staff = e2eStaff(2);
  await page.goto("/");
  await signIn(page, staff.email, staff.password);
  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  await expect(page.getByText("A clearer view of your people.")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
});

test("the retired shared staff demo password is rejected with the generic message", async ({ page }) => {
  for (const email of ["rafi.ahmed@example.com", e2eStaff(2).email]) {
    await page.goto("/");
    await signIn(page, email, "Staff23Demo!");
    await expect(page.locator(".form-error")).toHaveText("The email or password is incorrect. Please try again.");
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  }
  await expect(page.getByText("Staff23Demo!")).toHaveCount(0);
});
