import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 5.1: the Administrator loads the provisional holiday calendar (docs/holiday-calendars/bangladesh-2026.csv)
// from Attendance & leave and sees it as the new active version. The version's jurisdiction carries this run's
// id; the teardown deletes it through the service role (dates first: version_id is ON DELETE RESTRICT; the app
// itself never deletes a version). Needs the holiday_calendars migration applied to the shared project.
const run = randomBytes(4).toString("hex");
const JURISDICTION = `E2E Calendar ${run}`;
// Playwright runs from the project root (see playwright.config.ts) and compiles specs as CommonJS (no import.meta).
const CSV = join(process.cwd(), "docs", "holiday-calendars", "bangladesh-2026.csv");

/** Postgres / PostgREST "table does not exist" codes, returned until the holiday_calendars migration is applied. */
const SCHEMA_MISSING = new Set(["42P01", "PGRST205"]);

test.afterAll(async () => {
  const service = serviceClient();
  const versions = await service.from("holiday_calendar_versions").select("id").like("jurisdiction", `${JURISDICTION}%`);
  if (versions.error) {
    if (SCHEMA_MISSING.has(versions.error.code)) return;
    throw new Error(`Could not read throwaway calendar versions: ${versions.error.message}`);
  }
  const ids = (versions.data ?? []).map(v => v.id as string);
  if (ids.length === 0) return;
  const dates = await service.from("holiday_calendar_dates").delete().in("version_id", ids);
  if (dates.error) throw new Error(`Could not delete throwaway calendar dates: ${dates.error.message}`);
  const deleted = await service.from("holiday_calendar_versions").delete().in("id", ids);
  if (deleted.error) throw new Error(`Could not delete throwaway calendar versions: ${deleted.error.message}`);
});

test("the Administrator loads the holiday calendar CSV and sees it as the active version", async ({ page }) => {
  await page.goto("/");
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("button", { name: "Attendance & leave" }).click();
  const panel = page.getByRole("region", { name: "Holiday calendar" });
  await expect(panel).toBeVisible();

  await panel.getByLabel("Calendar files (.csv)").setInputFiles(CSV);
  await panel.getByLabel("Jurisdiction").fill(JURISDICTION);
  await panel.getByRole("button", { name: "Load calendar" }).click();
  const status = panel.getByRole("status");
  await expect(status).toHaveText(/^Holiday calendar version \d+ loaded \(\d+ holidays, 2026\)\.$/);
  const version = /version (\d+)/.exec((await status.textContent()) ?? "")?.[1];

  // Persisted and active: after a reload the new version is the one shown as active.
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Attendance & leave" }).click();
  const active = page.getByRole("region", { name: "Holiday calendar" }).getByLabel("Active holiday calendar");
  await expect(active).toContainText(`Version ${version} (active)`);
  await expect(active).toContainText(JURISDICTION);
  await expect(active).toContainText("Asia/Dhaka");
  await expect(active).toContainText("bangladesh-2026.csv");
});
