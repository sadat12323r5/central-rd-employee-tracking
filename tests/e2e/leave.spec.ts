import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCalendar } from "../../src/domain/holiday-calendar";
import { STAFF_EMAIL_PREFIX } from "./global-setup";
import { signIn } from "./staff";
import { serviceClient } from "./supabase-admin";

// Story 5.2: a Staff member records their own leave in the staff portal and sees it in their leave list
// with its working days and category. Story 5.3: they then edit its dates (recounted) and cancel it; it stays
// in the list as "Cancelled".
// Leave rows can never be deleted (and they pin their employee: employees.employee_id is ON DELETE
// RESTRICT), so this spec cannot use the BS-98nn employees global-setup.ts creates and global-teardown.ts
// deletes. Like the backfill spec, it reuses a fixed throwaway employee (BS-8390, in the Story 5.2 block
// BS-8300..BS-8399; the live RLS test uses BS-8300..BS-8302) and links it to a Staff account of this run
// (its email carries the run's Staff prefix, so global-teardown.ts deletes it too). Before and after, every
// active leave of the employee is cancelled through the service role, so runs never overlap each other;
// afterwards the employee is unlinked and archived and the account deleted.
// Calendar: when no holiday calendar is active, the provisional docs/holiday-calendars/bangladesh-2026.csv
// is loaded through the service-role RPC (what db:seed does); an active calendar is never touched. A calendar
// loaded here stays once leave references it (calendar_version_id is ON DELETE RESTRICT).
// Needs the holiday_calendars, leave_records and (for the edit / cancel steps) leave_records_update migrations applied.
const run = randomBytes(4).toString("hex");
const SUBJECT = { id: "BS-8390", name: "E2E Leave Subject" };
const CSV = join(process.cwd(), "docs", "holiday-calendars", "bangladesh-2026.csv");

async function cancelLeave(service: SupabaseClient) {
  const { error } = await service.from("leave_records").update({ cancelled_at: new Date().toISOString() })
    .eq("employee_id", SUBJECT.id).is("cancelled_at", null);
  if (error) throw new Error(`Could not cancel the throwaway leave (${error.code}): ${error.message}`);
}

async function ensureCalendar(service: SupabaseClient) {
  const active = await service.from("holiday_calendar_versions").select("id,supported_year_start,supported_year_end")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error(`Could not read the active calendar (${active.error.code}): ${active.error.message}`);
  if (active.data) {
    if (active.data.supported_year_start > 2026 || active.data.supported_year_end < 2026) {
      throw new Error("The shared project's active holiday calendar does not cover 2026; this spec records 2026 leave.");
    }
    return;
  }
  const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: readFileSync(CSV, "utf8") }]);
  const loaded = await service.rpc("load_holiday_calendar", {
    p_jurisdiction: "Bangladesh", p_timezone: "Asia/Dhaka", p_year_start: calendar.supportedYearStart, p_year_end: calendar.supportedYearEnd,
    p_source: "bangladesh-2026.csv", p_holidays: calendar.holidays,
  });
  if (loaded.error) throw new Error(`Could not load the provisional calendar (${loaded.error.code}): ${loaded.error.message}`);
}

test("a Staff member records their own leave, sees it with its working days and category, then edits and cancels it", async ({ page }) => {
  const service = serviceClient();
  const email = `${STAFF_EMAIL_PREFIX}${process.env.E2E_STAFF_RUN ?? run}-leave@example.test`;
  const password = `E2e-${randomBytes(18).toString("base64url")}`;
  let userId: string | null = null;
  try {
    await ensureCalendar(service);
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "staff", employee_id: SUBJECT.id } });
    if (created.error || !created.data.user) throw new Error(`Could not create the throwaway Staff user: ${created.error?.message ?? "no user returned"}`);
    userId = created.data.user.id;
    // Upserted: an earlier run's archived copy of this employee is re-used (it can never be deleted).
    const subject = await service.from("employees").upsert({
      employee_id: SUBJECT.id, name: SUBJECT.name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent",
      email: "e2e-leave-subject@example.test", joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available",
      initials: "EL", avatar_color: "mint", summary: "Throwaway row reused by tests/e2e/leave.spec.ts.",
      department_id: null, auth_user_id: userId, archived_at: null,
    }, { onConflict: "employee_id", defaultToNull: false });
    if (subject.error) throw new Error(`Could not create the throwaway employee (${subject.error.code}): ${subject.error.message}`);
    await cancelLeave(service);

    await page.goto("/");
    await signIn(page, email, password);
    const section = page.getByRole("region", { name: "Leave" });
    await expect(section.getByText("You have not recorded any leave yet.")).toBeVisible();

    // 25–27 Mar 2026: 26 Mar is Independence Day, so 2 working days.
    const form = section.getByRole("form", { name: "Record leave" });
    await form.getByLabel("First day of leave").fill("2026-03-25");
    await form.getByLabel("Last day of leave").fill("2026-03-27");
    await form.getByRole("button", { name: "Record leave" }).click();
    // Several live regions share the section (record, edit, cancel), so the message is found by its text.
    await expect(section.getByText("Leave recorded: 2 working days (1–3 working days).")).toBeVisible();
    const row = section.getByRole("table", { name: "Your leave" }).getByRole("row").filter({ hasText: "25 Mar 2026" });
    await expect(row).toContainText("27 Mar 2026");
    await expect(row).toContainText("1–3 working days");

    // An overlapping period is refused with its own message.
    await form.getByLabel("First day of leave").fill("2026-03-27");
    await form.getByLabel("Last day of leave").fill("2026-03-30");
    await form.getByRole("button", { name: "Record leave" }).click();
    await expect(section.getByRole("alert")).toHaveText("This overlaps leave already recorded from 25 Mar 2026 to 27 Mar 2026.");

    // Persisted with the count, category and calendar version.
    const { data, error } = await service.from("leave_records").select("id,start_date,end_date,working_days,category,calendar_version_id,cancelled_at")
      .eq("employee_id", SUBJECT.id).is("cancelled_at", null);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ start_date: "2026-03-25", end_date: "2026-03-27", working_days: 2, category: "ONE_TO_THREE" });
    expect(data![0].calendar_version_id).toBeTruthy();

    // Story 5.3: edit the dates (recounted: 25–31 Mar has 26 Mar and the weekend off, so 4 working days, 4–14).
    await row.getByRole("button", { name: "Edit leave: 25 Mar 2026 to 27 Mar 2026" }).click();
    const edit = row.getByRole("form", { name: "Edit leave: 25 Mar 2026 to 27 Mar 2026" });
    await expect(edit.getByLabel("First day of leave")).toHaveValue("2026-03-25");
    await edit.getByLabel("Last day of leave").fill("2026-03-31");
    await edit.getByRole("button", { name: "Save dates" }).click();
    await expect(section.getByText("Leave updated: 4 working days (4–14 working days).")).toBeVisible();
    const edited = section.getByRole("table", { name: "Your leave" }).getByRole("row").filter({ hasText: "31 Mar 2026" });
    await expect(edited).toContainText("25 Mar 2026");
    await expect(edited).toContainText("4–14 working days");

    // Cancel it (confirm first): it stays in the list as Cancelled, without controls.
    await edited.getByRole("button", { name: "Cancel leave: 25 Mar 2026 to 31 Mar 2026" }).click();
    await edited.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(section.getByText("Leave cancelled. It stays in the leave history and no longer counts.")).toBeVisible();
    await expect(edited).toContainText("Cancelled");
    await expect(edited.getByRole("button")).toHaveCount(0);

    const after = await service.from("leave_records").select("start_date,end_date,working_days,category,cancelled_at").eq("id", data![0].id);
    expect(after.error).toBeNull();
    expect(after.data).toHaveLength(1);
    expect(after.data![0]).toMatchObject({ start_date: "2026-03-25", end_date: "2026-03-31", working_days: 4, category: "FOUR_TO_FOURTEEN" });
    expect(after.data![0].cancelled_at).not.toBeNull();
  } finally {
    await cancelLeave(service).catch(() => {});
    await service.from("employees").update({ archived_at: new Date().toISOString(), auth_user_id: null }).eq("employee_id", SUBJECT.id);
    if (userId) await service.auth.admin.deleteUser(userId);
  }
});
