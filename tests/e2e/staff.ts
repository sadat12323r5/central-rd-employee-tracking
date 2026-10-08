import type { Page } from "@playwright/test";

/** A throwaway Staff account linked by global-setup.ts (1 or 2). */
export function e2eStaff(n: 1 | 2) {
  const email = process.env[`E2E_STAFF_${n}_EMAIL`];
  const password = process.env[`E2E_STAFF_${n}_PASSWORD`];
  const id = process.env[`E2E_STAFF_${n}_ID`];
  if (!email || !password || !id) throw new Error(`E2E_STAFF_${n}_* are not set; global-setup.ts did not run.`);
  return { email, password, id };
}

/** The throwaway employee global-setup.ts left without an account, for the provisioning spec. */
export function e2eUnlinkedEmployee() {
  const id = process.env.E2E_STAFF_UNLINKED_ID;
  const name = process.env.E2E_STAFF_UNLINKED_NAME;
  const email = process.env.E2E_STAFF_UNLINKED_EMAIL;
  if (!id || !name || !email) throw new Error("E2E_STAFF_UNLINKED_* are not set; global-setup.ts did not run.");
  return { id, name, email };
}

export async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
}
