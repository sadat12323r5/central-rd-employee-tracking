import { randomUUID } from "node:crypto";
import { buildLog, clockIn, clockOut, todaysEntry, TimesheetValidationError } from "@/domain/timesheet";
import type { AttendanceStore } from "./attendance-store";

// Story 9.1: the clock-in, clock-out and daily-log commands, shared by the web app's server actions
// (attendance-actions.ts, which always pass the server's `new Date()`) and the developer-only simulator
// (which passes a simulated instant). `now` is injected here and only here: no HTTP route or server action
// takes a time from the request. The employee id is the caller's own, taken from its session; the store
// carries that caller's JWT, so the attendance RLS policies apply. Each command returns the success message
// and throws TimesheetValidationError (a refused action) or AttendanceUnavailableError.

export type LogTaskInput = { description: string; hours: string; link: string };
export type SaveLogInput = { summary: string; blockers: string; tasks: LogTaskInput[] };

export interface AttendanceCommands {
  clockIn(employeeId: string, input: { workMode: string }, now: Date): Promise<string>;
  clockOut(employeeId: string, input: { breakMinutes: number }, now: Date): Promise<string>;
  saveLog(employeeId: string, input: SaveLogInput, now: Date): Promise<string>;
}

export function createAttendanceCommands(store: Pick<AttendanceStore, "listForEmployee" | "save">): AttendanceCommands {
  return {
    async clockIn(employeeId, { workMode }, now) {
      const entries = await store.listForEmployee(employeeId);
      const entry = clockIn(entries, { id: randomUUID(), employeeId, workMode, now });
      await store.save(entry);
      return "Clocked in.";
    },
    async clockOut(employeeId, { breakMinutes }, now) {
      const entry = todaysEntry(await store.listForEmployee(employeeId), employeeId, now);
      await store.save(clockOut(entry, { breakMinutes, now }));
      return "Clocked out.";
    },
    async saveLog(employeeId, input, now) {
      const entry = todaysEntry(await store.listForEmployee(employeeId), employeeId, now);
      if (!entry) throw new TimesheetValidationError("NOT_CLOCKED_IN", "Clock in before writing today's log.");
      const log = buildLog(entry, input, now);
      await store.save({ ...entry, log });
      return "Daily log saved.";
    },
  };
}
