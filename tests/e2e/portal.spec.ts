import { test, expect } from "@playwright/test";

test("admin login, directory filters, profiles, export and logout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByText("Nadia Rahman", { exact: true })).toHaveCount(0);
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.locator(".form-error")).toContainText("incorrect");
  await page.getByLabel("Password", { exact: true }).fill("Brain23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-desktop.png", fullPage: true });
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill("TypeScript");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export directory" }).click();
  expect((await download).suggestedFilename()).toBe("bs23-demo-employees.csv");
  await page.getByRole("textbox", { name: "Search employees" }).fill("No matching employee");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByLabel("Filter by status").selectOption("In training");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "View Nadia Rahman's profile" }).click();
  await expect(page.getByRole("heading", { name: "Nadia Rahman", exact: true })).toBeVisible();
  for (const tab of ["Employment", "Training", "Skills & evaluation", "Current work", "Interviews", "Attendance", "Overview"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }
  await page.getByRole("tab", { name: "Interviews", exact: true }).click();
  await expect(page.getByRole("heading", { name: "External job interviews" })).toBeVisible();
  await expect(page.getByText("Northstar Labs (fictional)", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/employee-profile.png", fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
  for (const section of ["Learning & development", "Interviews & placements", "Attendance & leave"]) {
    await page.getByRole("navigation").getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
  await page.locator(".sidebar").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nadia Rahman", { exact: true })).toHaveCount(0);
});

test("mobile layout and sign out remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.screenshot({ path: "test-results/login-mobile.png", fullPage: true });
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Brain23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
  await page.screenshot({ path: "test-results/mobile-layout-check.png", fullPage: true });
  expect(await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ width: 390, document: 390 });
  await page.screenshot({ path: "test-results/dashboard-mobile.png", fullPage: true });
  await page.locator(".mobile-sign-out").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
});
