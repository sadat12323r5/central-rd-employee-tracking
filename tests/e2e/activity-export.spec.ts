import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eUnlinkedEmployee } from "./staff";

// Story 8.1: the Administrator downloads one employee's activity timeline from the profile. Uses the
// throwaway employee global-setup.ts creates (no real records are exported). Each export writes one
// append-only audit_events row, which needs supabase/migrations/20261013000000_activity_export_audit.sql.

const HEADER = '"employee_id","employee_name","date","type","title","details","status"';

test("the Administrator downloads a throwaway employee's All time activity CSV", async ({ page }) => {
  const employee = e2eUnlinkedEmployee();
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();
  await page.getByRole("textbox", { name: "Search employees" }).fill(employee.id);
  await page.getByRole("button", { name: `View ${employee.name}'s profile` }).click();

  await expect(page.getByRole("heading", { name: "Download activity" })).toBeVisible();
  await page.getByLabel("Period").selectOption("all");
  const panel = page.locator(".activity-export-panel");
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download activity" }).click();
  // Fail fast with the panel's message (e.g. the audit migration is not applied) instead of waiting for a download.
  // Both branches swallow their own rejection, so the losing one never surfaces as an unhandled rejection.
  const downloaded = downloading.then(download => ({ download })).catch(() => undefined);
  const alerted = panel.getByRole("alert").waitFor()
    .then(async () => ({ error: await panel.getByRole("alert").textContent() })).catch(() => undefined);
  const outcome = await Promise.race([downloaded, alerted]);
  expect(outcome).toBeDefined();
  expect(outcome).not.toHaveProperty("error");
  const { download } = outcome as { download: Awaited<typeof downloading> };

  const filename = download.suggestedFilename();
  expect(filename).toMatch(new RegExp(`^activity-${employee.id}-\\d{4}-\\d{2}-\\d{2}_to_\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  await expect(panel.getByRole("status").filter({ hasText: `Downloaded ${filename}.` })).toBeVisible();

  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  expect(lines[0]).toBe(HEADER);
  // Every data row belongs to this employee.
  for (const line of lines.slice(1)) expect(line.startsWith(`"${employee.id}",`)).toBe(true);
});

// Story 8.2: the Administrator bulk-exports every employee's activity from the directory. Needs both
// audit migrations (20261013000000_activity_export_audit.sql and 20261013010000_bulk_activity_export_audit.sql).
test("the Administrator downloads every employee's Last week activity CSV from the directory", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Employees" }).click();

  const panel = page.locator(".activity-export-panel").filter({ has: page.getByRole("heading", { name: "Download activity (all employees)" }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "Include archived" })).not.toBeChecked();
  await panel.getByLabel("Period").selectOption("last-week");
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download activity (all employees)" }).click();
  // Fail fast with the panel's message (e.g. the audit migrations are not applied) instead of waiting for a download.
  const downloaded = downloading.then(download => ({ download })).catch(() => undefined);
  const alerted = panel.getByRole("alert").waitFor()
    .then(async () => ({ error: await panel.getByRole("alert").textContent() })).catch(() => undefined);
  const outcome = await Promise.race([downloaded, alerted]);
  expect(outcome).toBeDefined();
  expect(outcome).not.toHaveProperty("error");
  const { download } = outcome as { download: Awaited<typeof downloading> };

  const filename = download.suggestedFilename();
  expect(filename).toMatch(/^activity-all-employees-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(panel.getByRole("status").filter({ hasText: `Downloaded ${filename}.` })).toBeVisible();

  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  expect(lines[0]).toBe(HEADER);
  // Rows are grouped by employee id, in order.
  const ids = lines.slice(1).map(line => line.slice(1, line.indexOf('","')));
  expect(ids).toEqual([...ids].sort());
});
