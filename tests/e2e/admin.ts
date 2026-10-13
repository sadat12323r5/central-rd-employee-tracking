import { expect, type Page } from "@playwright/test";

/** The throwaway Administrator created by global-setup.ts for this run. */
export function e2eAdmin() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD are not set; global-setup.ts did not run.");
  return { email, password };
}

export async function signInAsAdmin(page: Page) {
  const { email, password } = e2eAdmin();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  // The first sign-in of a run can be slow while the dev server compiles; wait for the request to finish.
  await expect(page.getByRole("button", { name: "Signing in…" })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "A clearer view of your people." })).toBeVisible();
}
