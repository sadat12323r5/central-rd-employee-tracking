"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { buildLog, clockIn, clockOut, todaysEntry, TimesheetValidationError } from "@/domain/timesheet";
import { getSession } from "./auth";
import { attendanceStore, AttendanceUnavailableError } from "./attendance-store";
import { ownRecordIdentity } from "./session";

export type ActionState = { error: string; message: string };

// The employee is always taken from the signed session, never from the submitted form,
// so staff can only create or change their own records. Story 4.10: a manager, or an Administrator
// linked to an employee row, records their own attendance ("My record") under the same Staff rules.
const SIGNED_OUT = "Your session has ended. Sign in again to record attendance.";
const NOT_LINKED = "Your account isn't linked to an employee record, so there is nothing to record here.";

/** The session's own employee id, or the refusal: signed out, or signed in without a linked employee record. */
async function staffId(): Promise<{ employeeId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: SIGNED_OUT };
  const own = ownRecordIdentity(session);
  return own ? { employeeId: own.employeeId } : { error: NOT_LINKED };
}

async function run(work: (employeeId: string, now: Date) => Promise<string>): Promise<ActionState> {
  const own = await staffId();
  if ("error" in own) return { error: own.error, message: "" };
  const { employeeId } = own;
  try {
    const message = await work(employeeId, new Date());
    revalidatePath("/");
    return { error: "", message };
  } catch (error) {
    if (error instanceof TimesheetValidationError) return { error: error.message, message: "" };
    // Never report success when the database could not be reached or refused the write.
    if (error instanceof AttendanceUnavailableError) {
      console.error("Attendance unavailable.", error, { cause: error.cause });
      return { error: "Attendance could not be reached, so nothing was saved. Please try again in a moment.", message: "" };
    }
    throw error;
  }
}

export async function clockInAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(async (employeeId, now) => {
    const entries = await attendanceStore.listForEmployee(employeeId);
    const entry = clockIn(entries, { id: randomUUID(), employeeId, workMode: String(form.get("workMode") || ""), now });
    await attendanceStore.save(entry);
    return "Clocked in.";
  });
}

export async function clockOutAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(async (employeeId, now) => {
    const raw = String(form.get("breakMinutes") ?? "").trim();
    const breakMinutes = raw === "" ? 0 : Number(raw);
    const entry = todaysEntry(await attendanceStore.listForEmployee(employeeId), employeeId, now);
    await attendanceStore.save(clockOut(entry, { breakMinutes, now }));
    return "Clocked out.";
  });
}

export async function saveLogAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run(async (employeeId, now) => {
    const entry = todaysEntry(await attendanceStore.listForEmployee(employeeId), employeeId, now);
    if (!entry) throw new TimesheetValidationError("NOT_CLOCKED_IN", "Clock in before writing today's log.");
    const descriptions = form.getAll("taskDescription").map(String);
    const hours = form.getAll("taskHours").map(String);
    const links = form.getAll("taskLink").map(String);
    const log = buildLog(entry, {
      summary: String(form.get("summary") || ""),
      blockers: String(form.get("blockers") || ""),
      tasks: descriptions.map((description, i) => ({ description, hours: hours[i] ?? "", link: links[i] ?? "" })),
    }, now);
    await attendanceStore.save({ ...entry, log });
    return "Daily log saved.";
  });
}
