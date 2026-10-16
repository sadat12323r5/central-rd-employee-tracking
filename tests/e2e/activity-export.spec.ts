import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { e2eManagerStaff, e2eUnlinkedEmployee, signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

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

// Story 8.3: a department manager exports within their department. A throwaway department (this run's
// id) gets the e2e manager Staff account as its manager and the throwaway unlinked employee as its only
// member, through the service role; both are undone in `finally`. Needs the 4.1-4.3 migrations (departments
// and manager scope) and the three activity export audit migrations, including
// 20261015050000_department_activity_export_audit.sql for the bulk export.

/** Clicks the panel's download button; fails fast with the panel's message instead of waiting for a download. */
async function download(page: Page, panel: Locator, button: string) {
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: button }).click();
  const downloaded = downloading.then(d => ({ download: d })).catch(() => undefined);
  const alerted = panel.getByRole("alert").waitFor()
    .then(async () => ({ error: await panel.getByRole("alert").textContent() })).catch(() => undefined);
  const outcome = await Promise.race([downloaded, alerted]);
  expect(outcome).toBeDefined();
  expect(outcome).not.toHaveProperty("error");
  const file = (outcome as { download: Awaited<typeof downloading> }).download;
  const bytes = await readFile((await file.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  expect(lines[0]).toBe(HEADER);
  return { filename: file.suggestedFilename(), rows: lines.slice(1) };
}

test("a department manager downloads an in-department employee's activity and the department's bulk activity, without interviews", async ({ page }) => {
  const manager = e2eManagerStaff();
  const member = e2eUnlinkedEmployee();
  const department = `E2E Export ${randomBytes(4).toString("hex")}`;
  const service = serviceClient();
  const account = await service.from("employees").select("auth_user_id").eq("employee_id", manager.id).single();
  if (account.error || !account.data?.auth_user_id) throw new Error(`Could not read the e2e manager's account: ${account.error?.message ?? "not linked"}`);
  const created = await service.from("departments").insert({ name: department, manager_user_id: account.data.auth_user_id }).select("id").single();
  if (created.error) throw new Error(`Could not create the throwaway department (${created.error.code}): ${created.error.message}`);
  const departmentId = created.data.id as string;
  const managerUserId = account.data.auth_user_id as string;
  // One attendance row and one external interview for the member, inside the exported period ("All time").
  const attendanceId = randomUUID();
  const interviewId = randomUUID();
  try {
    const placed = await service.from("employees").update({ department_id: departmentId }).eq("employee_id", member.id);
    if (placed.error) throw new Error(`Could not place the throwaway employee: ${placed.error.message}`);
    const attended = await service.from("attendance_entries").insert([{
      id: attendanceId, employee_id: member.id, work_date: "2026-01-05", clock_in: "2026-01-05T03:00:00Z",
      clock_out: "2026-01-05T11:00:00Z", break_minutes: 0, work_mode: "Office", log: null,
    }], { defaultToNull: false });
    if (attended.error) throw new Error(`Could not seed attendance (${attended.error.code}): ${attended.error.message}`);
    const interviewed = await service.from("external_interviews").insert([{
      id: interviewId, employee_id: member.id, company: "E2E Export Co", role: "QA", stage: "Screening", interview_date: "2026-01-06",
    }], { defaultToNull: false });
    if (interviewed.error) throw new Error(`Could not seed the interview (${interviewed.error.code}): ${interviewed.error.message}`);

    await page.goto("/");
    await signIn(page, manager.email, manager.password);
    await expect(page.getByText("Department manager")).toBeVisible();
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Employees/ }).click();

    // Bulk: the department only, no interview rows.
    const bulk = page.locator(".activity-export-panel").filter({ has: page.getByRole("heading", { name: "Download activity (your departments)" }) });
    await expect(bulk.getByText("Interviews are not included in a department manager's export.")).toBeVisible();
    await bulk.getByLabel("Period").selectOption("all");
    const all = await download(page, bulk, "Download activity (your departments)");
    expect(all.filename).toMatch(/^activity-all-employees-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(bulk.getByRole("status").filter({ hasText: `Downloaded ${all.filename}.` })).toBeVisible();
    expect(all.rows.length).toBeGreaterThan(0);
    for (const row of all.rows) {
      expect(row.startsWith(`"${member.id}",`)).toBe(true);
      expect(row).not.toContain('","interview","');
    }

    // Single: the in-department employee's profile.
    await page.getByRole("button", { name: `View ${member.name}'s profile` }).click();
    const single = page.locator(".activity-export-panel").filter({ has: page.getByRole("heading", { name: "Download activity", exact: true }) });
    await single.getByLabel("Period").selectOption("all");
    const one = await download(page, single, "Download activity");
    expect(one.filename).toMatch(new RegExp(`^activity-${member.id}-\\d{4}-\\d{2}-\\d{2}_to_\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    expect(one.rows.length).toBeGreaterThan(0);
    for (const row of one.rows) {
      expect(row.startsWith(`"${member.id}",`)).toBe(true);
      expect(row).not.toContain('","interview","');
    }

    // Exactly one audit row for the bulk export, scoped to the throwaway department.
    const audited = await service.from("audit_events").select("id").eq("actor", managerUserId).eq("target", `departments:${departmentId}`);
    expect(audited.error).toBeNull();
    expect(audited.data).toHaveLength(1);
  } finally {
    await service.from("attendance_entries").delete().eq("id", attendanceId);
    await service.from("external_interviews").delete().eq("id", interviewId);
    await service.from("employees").update({ department_id: null }).eq("employee_id", member.id);
    await service.from("departments").delete().eq("id", departmentId);
  }
});
