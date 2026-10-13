import { test, expect, type Page } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eArchiveStaff, signIn } from "./staff";

// Two browser contexts: A is the Administrator, B the Staff member being archived and restored.
// The spec always restores the employee at the end (also after a failure), so teardown is unaffected.

async function openDirectory(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
}

async function searchFor(page: Page, id: string) {
  await page.getByRole("textbox", { name: "Search employees" }).fill(id);
}

test("an Administrator archives a Staff account, ending its access, then restores it", async ({ browser }) => {
  const staff = e2eArchiveStaff();
  const { baseURL, viewport } = test.info().project.use;
  const adminContext = await browser.newContext({ baseURL, viewport });
  const staffContext = await browser.newContext({ baseURL, viewport });
  const admin = await adminContext.newPage();
  const member = await staffContext.newPage();
  let archived = false;

  try {
    // B: the staff member is signed in to their own portal.
    await member.goto("/");
    await signIn(member, staff.email, staff.password);
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();

    // A: the Administrator archives them from their profile.
    await admin.goto("/");
    await signInAsAdmin(admin);
    await openDirectory(admin);
    await searchFor(admin, staff.id);
    await admin.getByRole("button", { name: `View ${staff.name}'s profile` }).click();
    await expect(admin.getByRole("heading", { name: "Account access" })).toBeVisible();
    await expect(admin.getByText("Archiving ends this person's sign-in access immediately.", { exact: false })).toBeVisible();
    await admin.getByRole("button", { name: "Archive employee" }).click();
    archived = true;
    await expect(admin.getByRole("status").filter({ hasText: `${staff.name} was archived. Their sign-in access has ended.` })).toBeVisible();
    await expect(admin.getByRole("button", { name: "Restore employee" })).toBeVisible();
    await expect(admin.locator(".profile-header").getByText("Archived", { exact: true })).toBeVisible();

    // B: the live session ends on the next request.
    await member.reload();
    await expect(member.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(member.getByRole("button", { name: "Clock in" })).toHaveCount(0);

    // B: the correct password now gets the generic message.
    await signIn(member, staff.email, staff.password);
    await expect(member.locator(".form-error")).toContainText("incorrect");
    await expect(member.getByRole("button", { name: "Clock in" })).toHaveCount(0);

    // A: hidden from the default directory, listed under "Archived employees", profile data unchanged.
    await admin.reload();
    await openDirectory(admin);
    await searchFor(admin, staff.id);
    await expect(admin.getByRole("button", { name: `View ${staff.name}'s profile` })).toHaveCount(0);
    await admin.getByLabel("Show employees").selectOption("Archived employees");
    await admin.getByRole("button", { name: `View ${staff.name}'s profile` }).click();
    await expect(admin.getByRole("heading", { name: staff.name, exact: true })).toBeVisible();
    await expect(admin.locator(".profile-header").getByText("Archived", { exact: true })).toBeVisible();
    await expect(admin.getByRole("link", { name: staff.email })).toBeVisible();
    await expect(admin.getByText("Has a sign-in account")).toBeVisible();

    // A: restore.
    await admin.getByRole("button", { name: "Restore employee" }).click();
    await expect(admin.getByRole("status").filter({ hasText: `${staff.name} was restored.` })).toBeVisible();
    archived = false;
    await expect(admin.getByRole("button", { name: "Archive employee" })).toBeVisible();

    // A: back in the default directory.
    await admin.reload();
    await openDirectory(admin);
    await searchFor(admin, staff.id);
    await expect(admin.getByRole("button", { name: `View ${staff.name}'s profile` })).toBeVisible();

    // B: signs in again to their own portal.
    await member.reload();
    await signIn(member, staff.email, staff.password);
    await expect(member.getByRole("button", { name: "Clock in" })).toBeVisible();
    await expect(member.locator(".staff-identity")).toContainText(staff.id);
  } finally {
    if (archived) {
      // Restore through the app so the account is left as global-setup.ts created it.
      await admin.goto("/");
      if (await admin.getByLabel("Email address").isVisible()) await signInAsAdmin(admin);
      await openDirectory(admin);
      await admin.getByLabel("Show employees").selectOption("Archived employees");
      await searchFor(admin, staff.id);
      const profile = admin.getByRole("button", { name: `View ${staff.name}'s profile` });
      if (await profile.count()) {
        await profile.click();
        await admin.getByRole("button", { name: "Restore employee" }).click();
        await expect(admin.getByRole("status").filter({ hasText: "was restored." })).toBeVisible();
      }
    }
    await adminContext.close();
    await staffContext.close();
  }
});
