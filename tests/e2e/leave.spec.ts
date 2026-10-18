import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
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
// Calendar: the spec counts against whatever LIVE calendar is active in the shared project (the provisional
// Bangladesh calendar, docs/holiday-calendars/bangladesh-2026.csv, loaded by db:seed) and never loads one;
// it fails with a clear message when none is active or it does not cover 2026.
// Needs the holiday_calendars, leave_records, holiday_calendar_purpose and (for the edit / cancel steps) leave_records_update migrations applied.
const run = randomBytes(4).toString("hex");
const SUBJECT = { id: "BS-8390", name: "E2E Leave Subject" };

async function cancelLeave(service: SupabaseClient) {
  const { error } = await service.from("leave_records").update({ cancelled_at: new Date().toISOString() })
    .eq("employee_id", SUBJECT.id).is("cancelled_at", null);
  if (error) throw new Error(`Could not cancel the throwaway leave (${error.code}): ${error.message}`);
}

/** The spec counts against whatever LIVE calendar is active (Bangladesh); it never loads one of its own. */
async function requireActiveCalendar(service: SupabaseClient) {
  const active = await service.from("holiday_calendar_versions").select("id,supported_year_start,supported_year_end")
    .eq("purpose", "live").order("version", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error(`Could not read the active calendar (${active.error.code}): ${active.error.message}`);
  if (!active.data) throw new Error("The shared project has no active (live) holiday calendar; load the provisional Bangladesh calendar (npm run db:seed).");
  if (active.data.supported_year_start > 2026 || active.data.supported_year_end < 2026) {
    throw new Error("The shared project's active holiday calendar does not cover 2026; this spec records 2026 leave.");
  }
}

test("a Staff member records their own leave, sees it with its working days and category, then edits and cancels it", async ({ page }) => {
  const service = serviceClient();
  const email = `${STAFF_EMAIL_PREFIX}${process.env.E2E_STAFF_RUN ?? run}-leave@example.test`;
  const password = `E2e-${randomBytes(18).toString("base64url")}`;
  let userId: string | null = null;
  try {
    await requireActiveCalendar(service);
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
    // Earlier runs' periods stay listed as Cancelled (leave is never deleted), so only "no active leave" is checked:
    // active periods are the only rows with an Edit control.
    await expect(section.getByRole("heading", { name: "Record leave" })).toBeVisible();
    await expect(section.getByRole("button", { name: /^Edit leave/ })).toHaveCount(0);

    // 25–27 Mar 2026: 26 Mar is Independence Day, so 2 working days.
    const form = section.getByRole("form", { name: "Record leave" });
    await form.getByLabel("First day of leave").fill("2026-03-25");
    await form.getByLabel("Last day of leave").fill("2026-03-27");
    await form.getByRole("button", { name: "Record leave" }).click();
    // Several live regions share the section (record, edit, cancel), so the message is found by its text.
    await expect(section.getByText("Leave recorded: 2 working days (1–3 working days).")).toBeVisible();
    // The active row (the one with controls): cancelled rows with the same dates may remain from earlier runs.
    const row = section.getByRole("table", { name: "Your leave" }).getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Edit leave: 25 Mar 2026 to 27 Mar 2026" }) });
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
    // The row's controls are replaced by the form while editing, so the form is found in the section.
    const edit = section.getByRole("form", { name: "Edit leave: 25 Mar 2026 to 27 Mar 2026" });
    await expect(edit.getByLabel("First day of leave")).toHaveValue("2026-03-25");
    await edit.getByLabel("Last day of leave").fill("2026-03-31");
    await edit.getByRole("button", { name: "Save dates" }).click();
    await expect(section.getByText("Leave updated: 4 working days (4–14 working days).")).toBeVisible();
    const edited = section.getByRole("table", { name: "Your leave" }).getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Cancel leave: 25 Mar 2026 to 31 Mar 2026" }) });
    await expect(edited).toContainText("4–14 working days");

    // Cancel it (confirm first): it stays in the list as Cancelled, without controls (checked in the database
    // below); no active period remains.
    await edited.getByRole("button", { name: "Cancel leave: 25 Mar 2026 to 31 Mar 2026" }).click();
    await section.getByRole("form", { name: "Cancel leave: 25 Mar 2026 to 31 Mar 2026" }).getByRole("button", { name: "Confirm cancel" }).click();
    await expect(section.getByText("Leave cancelled. It stays in the leave history and no longer counts.")).toBeVisible();
    await expect(section.getByRole("button", { name: /^(Edit|Cancel) leave/ })).toHaveCount(0);
    await expect(section.getByRole("table", { name: "Your leave" }).getByRole("row").filter({ hasText: "31 Mar 2026" }).first()).toContainText("Cancelled");

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
