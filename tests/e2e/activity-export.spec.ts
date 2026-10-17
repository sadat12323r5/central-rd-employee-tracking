import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCalendar } from "../../src/domain/holiday-calendar";
import { categoryForWorkingDays } from "../../src/domain/leave";
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

// Story 8.4: the same manager export carries assignment, evaluation and leave rows. Those records can never
// be deleted and pin their employee and department (ON DELETE RESTRICT), so they cannot belong to the BS-98nn
// employee or the throwaway department above (both are deleted afterwards). Like the assignment and leave
// specs, this reuses a fixed throwaway employee (BS-9193, beside the BS-9190..BS-9192 assignment-spec
// subjects) in a fixed department ("E2E Activity Export") that the manager manages for the test only. Each
// run adds one closed assignment (its own project name), its evaluation (service role, so the author
// snapshot is the one sent) and one leave period; afterwards the leave is cancelled through the service role
// (leave is never deleted; earlier runs' periods stay, cancelled), the department's manager is cleared and
// the employee archived. Needs the assignments, assignment_evaluations, holiday_calendars and leave_records
// migrations; when no holiday calendar is active the provisional bangladesh-2026.csv is loaded (as leave.spec does).
const EXPORT_DEPARTMENT = "E2E Activity Export";
const EXPORT_SUBJECT = { id: "BS-9193", name: "E2E Export Subject" };
const LEAVE = { start: "2026-09-29", end: "2026-10-02" };

/** The active holiday calendar version's id, loading the provisional calendar when none is active. */
async function activeCalendar(service: SupabaseClient): Promise<string> {
  const read = () => service.from("holiday_calendar_versions").select("id,supported_year_start,supported_year_end")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  let active = await read();
  if (active.error) throw new Error(`Could not read the active calendar (${active.error.code}): ${active.error.message}`);
  if (!active.data) {
    const csv = join(process.cwd(), "docs", "holiday-calendars", "bangladesh-2026.csv");
    const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: readFileSync(csv, "utf8") }]);
    const loaded = await service.rpc("load_holiday_calendar", {
      p_jurisdiction: "Bangladesh", p_timezone: "Asia/Dhaka", p_year_start: calendar.supportedYearStart, p_year_end: calendar.supportedYearEnd,
      p_source: "bangladesh-2026.csv", p_holidays: calendar.holidays,
    });
    if (loaded.error) throw new Error(`Could not load the provisional calendar (${loaded.error.code}): ${loaded.error.message}`);
    active = await read();
    if (active.error || !active.data) throw new Error("The provisional calendar did not become active.");
  }
  if (active.data.supported_year_start > 2026 || active.data.supported_year_end < 2026) {
    throw new Error("The shared project's active holiday calendar does not cover 2026; this spec records 2026 leave.");
  }
  return active.data.id as string;
}

/** Monday-to-Friday days of the leave period minus the calendar's holidays (what the leave guard checks). */
async function leaveWorkingDays(service: SupabaseClient, versionId: string): Promise<number> {
  const holidays = await service.from("holiday_calendar_dates").select("holiday_date").eq("version_id", versionId)
    .gte("holiday_date", LEAVE.start).lte("holiday_date", LEAVE.end);
  if (holidays.error) throw new Error(`Could not read the calendar's holidays (${holidays.error.code}): ${holidays.error.message}`);
  const off = new Set((holidays.data ?? []).map(h => h.holiday_date as string));
  let days = 0;
  for (let t = Date.parse(`${LEAVE.start}T00:00:00Z`); t <= Date.parse(`${LEAVE.end}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !off.has(day.toISOString().slice(0, 10))) days++;
  }
  return days;
}

/** Cancels every active leave period of the fixed subject (service role: leave is never deleted). */
async function cancelSubjectLeave(service: SupabaseClient) {
  const { error } = await service.from("leave_records").update({ cancelled_at: new Date().toISOString() })
    .eq("employee_id", EXPORT_SUBJECT.id).is("cancelled_at", null);
  if (error) throw new Error(`Could not cancel the throwaway leave (${error.code}): ${error.message}`);
}

/**
 * Points the fixed department at the manager, places the fixed subject in it and adds this run's closed
 * assignment, its evaluation and one leave period. Returns what the export rows must show.
 */
async function seedExportRecords(service: SupabaseClient, managerUserId: string, run: string) {
  const found = await service.from("departments").select("id").eq("name", EXPORT_DEPARTMENT).maybeSingle();
  if (found.error) throw new Error(`Could not read the fixed department (${found.error.code}): ${found.error.message}`);
  let departmentId = found.data?.id as string | undefined;
  if (departmentId) {
    const updated = await service.from("departments").update({ manager_user_id: managerUserId, parent_department_id: null }).eq("id", departmentId);
    if (updated.error) throw new Error(`Could not update the fixed department (${updated.error.code}): ${updated.error.message}`);
  } else {
    const created = await service.from("departments").insert({ name: EXPORT_DEPARTMENT, manager_user_id: managerUserId }).select("id").single();
    if (created.error) throw new Error(`Could not create the fixed department (${created.error.code}): ${created.error.message}`);
    departmentId = created.data.id as string;
  }
  const subject = await service.from("employees").upsert({
    employee_id: EXPORT_SUBJECT.id, name: EXPORT_SUBJECT.name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent",
    email: "e2e-export-subject@example.test", joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available",
    initials: "EX", avatar_color: "mint", summary: "Throwaway row reused by tests/e2e/activity-export.spec.ts.",
    department_id: departmentId, auth_user_id: null, archived_at: null,
  }, { onConflict: "employee_id", defaultToNull: false });
  if (subject.error) throw new Error(`Could not upsert the fixed subject (${subject.error.code}): ${subject.error.message}`);

  // An aborted earlier run may have left an open assignment (at most one is allowed) or active leave.
  const leftover = await service.from("assignments").update({ status: "closed", completion_date: "2026-10-05" })
    .eq("employee_id", EXPORT_SUBJECT.id).eq("status", "open");
  if (leftover.error) throw new Error(`Could not close leftover assignments (${leftover.error.code}): ${leftover.error.message}`);
  await cancelSubjectLeave(service);

  const project = `E2E exported project ${run}`;
  const opened = await service.from("assignments").insert({
    employee_id: EXPORT_SUBJECT.id, client: "E2E Export Client", project_name: project, role: "Developer", allocation: 50, start_date: "2026-09-01",
  }).select("id").single();
  if (opened.error) throw new Error(`Could not add the assignment (${opened.error.code}): ${opened.error.message}`);
  const assignmentId = opened.data.id as string;
  const closed = await service.from("assignments").update({ status: "closed", completion_date: "2026-10-05" }).eq("id", assignmentId);
  if (closed.error) throw new Error(`Could not close the assignment (${closed.error.code}): ${closed.error.message}`);
  const outcome = `Delivered the export ${run}`;
  const feedback = `Client happy ${run}`;
  const evaluated = await service.from("assignment_evaluations").insert({
    assignment_id: assignmentId, employee_id: EXPORT_SUBJECT.id, department_id: departmentId, evaluation: outcome, client_feedback: feedback,
    created_by: managerUserId, created_by_name: "E2E Export Evaluator", created_by_role: "manager",
    authored_by: managerUserId, authored_by_name: "E2E Export Evaluator", authored_by_role: "manager",
  });
  if (evaluated.error) throw new Error(`Could not add the evaluation (${evaluated.error.code}): ${evaluated.error.message}`);

  const versionId = await activeCalendar(service);
  const workingDays = await leaveWorkingDays(service, versionId);
  const category = categoryForWorkingDays(workingDays);
  const recorded = await service.from("leave_records").insert([{
    employee_id: EXPORT_SUBJECT.id, start_date: LEAVE.start, end_date: LEAVE.end, working_days: workingDays, category: category.category,
    calendar_version_id: versionId,
  }], { defaultToNull: false });
  if (recorded.error) throw new Error(`Could not add the leave (${recorded.error.code}): ${recorded.error.message}`);

  return {
    assignment: `"2026-09-01","assignment","${project} — E2E Export Client","Role: Developer; start: 2026-09-01; end: 2026-10-05; provenance: assignment","Closed"`,
    evaluation: `"evaluation","Evaluation — ${project} (E2E Export Client)","Evaluator: E2E Export Evaluator; outcome: ${outcome}; client feedback: ${feedback}","Written"`,
    leave: `"${LEAVE.start}","leave","${category.label}","From ${LEAVE.start} to ${LEAVE.end}; ${workingDays} working day${workingDays === 1 ? "" : "s"}","Recorded"`,
  };
}

/** Asserts the subject's rows of this run: the assignment, its evaluation and the leave period. */
function expectExportRecords(rows: string[], expected: Awaited<ReturnType<typeof seedExportRecords>>) {
  const own = rows.filter(row => row.startsWith(`"${EXPORT_SUBJECT.id}","${EXPORT_SUBJECT.name}",`));
  for (const fragment of Object.values(expected)) expect(own.some(row => row.includes(fragment))).toBe(true);
}

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
  const run = randomBytes(4).toString("hex");
  try {
    const expected = await seedExportRecords(service, managerUserId, run);
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

    // Bulk: the managed departments only (the throwaway one and the fixed Story 8.4 one), no interview rows.
    const bulk = page.locator(".activity-export-panel").filter({ has: page.getByRole("heading", { name: "Download activity (your departments)" }) });
    await expect(bulk.getByText("Interviews are not included in a department manager's export.")).toBeVisible();
    await bulk.getByLabel("Period").selectOption("all");
    const all = await download(page, bulk, "Download activity (your departments)");
    expect(all.filename).toMatch(/^activity-all-employees-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(bulk.getByRole("status").filter({ hasText: `Downloaded ${all.filename}.` })).toBeVisible();
    expect(all.rows.length).toBeGreaterThan(0);
    for (const row of all.rows) {
      expect(row.startsWith(`"${member.id}",`) || row.startsWith(`"${EXPORT_SUBJECT.id}",`)).toBe(true);
      expect(row).not.toContain('","interview","');
    }
    expect(all.rows.some(row => row.startsWith(`"${member.id}",`))).toBe(true);
    expectExportRecords(all.rows, expected);

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

    // Single: the fixed Story 8.4 subject, with its assignment, evaluation (client feedback for a manager) and leave.
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Employees/ }).click();
    await page.getByRole("textbox", { name: "Search employees" }).fill(EXPORT_SUBJECT.id);
    await page.getByRole("button", { name: `View ${EXPORT_SUBJECT.name}'s profile` }).click();
    const subjectPanel = page.locator(".activity-export-panel").filter({ has: page.getByRole("heading", { name: "Download activity", exact: true }) });
    await subjectPanel.getByLabel("Period").selectOption("all");
    const subjectExport = await download(page, subjectPanel, "Download activity");
    expect(subjectExport.filename).toMatch(new RegExp(`^activity-${EXPORT_SUBJECT.id}-\\d{4}-\\d{2}-\\d{2}_to_\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    for (const row of subjectExport.rows) expect(row.startsWith(`"${EXPORT_SUBJECT.id}",`)).toBe(true);
    expectExportRecords(subjectExport.rows, expected);

    // Exactly one audit row for the bulk export, scoped to both managed departments (sorted ids).
    const fixed = await service.from("departments").select("id").eq("name", EXPORT_DEPARTMENT).single();
    expect(fixed.error).toBeNull();
    const target = `departments:${[departmentId, fixed.data!.id as string].sort().join(",")}`;
    const audited = await service.from("audit_events").select("id").eq("actor", managerUserId).eq("target", target);
    expect(audited.error).toBeNull();
    expect(audited.data).toHaveLength(1);
  } finally {
    // Story 8.4 records stay (never deleted): cancel the leave, clear the manager, archive the subject.
    await cancelSubjectLeave(service).catch(error => console.error(error instanceof Error ? error.message : error));
    await service.from("departments").update({ manager_user_id: null }).eq("name", EXPORT_DEPARTMENT);
    await service.from("employees").update({ archived_at: new Date().toISOString() }).eq("employee_id", EXPORT_SUBJECT.id);
    await service.from("attendance_entries").delete().eq("id", attendanceId);
    await service.from("external_interviews").delete().eq("id", interviewId);
    await service.from("employees").update({ department_id: null }).eq("employee_id", member.id);
    await service.from("departments").delete().eq("id", departmentId);
  }
});
