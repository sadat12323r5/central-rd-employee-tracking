import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eUnlinkedEmployee, signIn } from "./staff";

test("an Administrator creates a Staff account, and that employee signs in to their own portal", async ({ page }) => {
  const employee = e2eUnlinkedEmployee();
  const password = `Init-${randomBytes(12).toString("base64url")}`;

  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(employee.id);
  await page.getByRole("button", { name: `View ${employee.name}'s profile` }).click();
  await expect(page.getByRole("heading", { name: employee.name, exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Sign-in account" })).toBeVisible();
  await page.getByLabel("Initial password", { exact: true }).fill(password);
  await page.getByLabel("Confirm initial password").fill(password);
  await page.getByRole("button", { name: "Create Staff account" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Sign-in account created for ${employee.name}.` })).toBeVisible();
  await expect(page.getByText("Has a sign-in account")).toBeVisible();
  // The password is never echoed back, and a second account cannot be requested from the UI.
  await expect(page.getByText(password)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Staff account" })).toHaveCount(0);

  // After a reload the persisted link still shows.
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(employee.id);
  await page.getByRole("button", { name: `View ${employee.name}'s profile` }).click();
  await expect(page.getByText("Has a sign-in account")).toBeVisible();
  await expect(page.getByLabel("Initial password", { exact: true })).toHaveCount(0);

  await page.locator(".sidebar").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();

  await signIn(page, employee.email, password);
  await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  await expect(page.locator(".staff-identity")).toContainText(`${employee.name}`);
  await expect(page.locator(".staff-identity")).toContainText(employee.id);
  await expect(page.getByText("A clearer view of your people.")).toHaveCount(0);
});
