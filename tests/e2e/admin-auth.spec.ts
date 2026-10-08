import { test, expect } from "@playwright/test";

test("the retired demo Administrator credentials are rejected", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("manager@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Brain23Demo!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.locator(".form-error")).toHaveText("The email or password is incorrect. Please try again.");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByText("Brain23Demo!")).toHaveCount(0);
});

for (const path of ["/signup", "/sign-up", "/register"]) {
  test(`there is no self-registration route at ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  });
}

test("the sign-in page offers no sign-up or registration link", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /sign up|register|create (an )?account/i })).toHaveCount(0);
});
