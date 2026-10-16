import { expect, type Page } from "@playwright/test";

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

/** The linked throwaway Staff account the archive spec archives and restores. */
export function e2eArchiveStaff() {
  const id = process.env.E2E_STAFF_ARCHIVE_ID;
  const name = process.env.E2E_STAFF_ARCHIVE_NAME;
  const email = process.env.E2E_STAFF_ARCHIVE_EMAIL;
  const password = process.env.E2E_STAFF_ARCHIVE_PASSWORD;
  if (!id || !name || !email || !password) throw new Error("E2E_STAFF_ARCHIVE_* are not set; global-setup.ts did not run.");
  return { id, name, email, password };
}

/** Story 4.2: the linked throwaway Staff account the department-manager spec makes a manager. */
export function e2eManagerStaff() {
  const id = process.env.E2E_STAFF_MANAGER_ID;
  const name = process.env.E2E_STAFF_MANAGER_NAME;
  const email = process.env.E2E_STAFF_MANAGER_EMAIL;
  const password = process.env.E2E_STAFF_MANAGER_PASSWORD;
  if (!id || !name || !email || !password) throw new Error("E2E_STAFF_MANAGER_* are not set; global-setup.ts did not run.");
  return { id, name, email, password };
}

/** Story 4.2: the throwaway employee that never gets a sign-in account. */
export function e2eNoAccountEmployee() {
  const id = process.env.E2E_STAFF_NO_ACCOUNT_ID;
  const name = process.env.E2E_STAFF_NO_ACCOUNT_NAME;
  if (!id || !name) throw new Error("E2E_STAFF_NO_ACCOUNT_* are not set; global-setup.ts did not run.");
  return { id, name };
}

/** Story 4.9: the linked throwaway Staff account the manager-archive spec places in a managed department. */
export function e2eManagedStaff() {
  const id = process.env.E2E_STAFF_MANAGED_ID;
  const name = process.env.E2E_STAFF_MANAGED_NAME;
  const email = process.env.E2E_STAFF_MANAGED_EMAIL;
  const password = process.env.E2E_STAFF_MANAGED_PASSWORD;
  if (!id || !name || !email || !password) throw new Error("E2E_STAFF_MANAGED_* are not set; global-setup.ts did not run.");
  return { id, name, email, password };
}

export async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  // The first sign-in of a run can be slow while the dev server compiles; wait for the request to finish.
  await expect(page.getByRole("button", { name: "Signing in…" })).toHaveCount(0, { timeout: 30_000 });
}
