import type { TimesheetEntry } from "@/domain/timesheet";

// Demo storage only. Records live in server memory: they reset when the server restarts and
// are not shared between Vercel serverless instances. Replace with a Supabase-backed
// implementation of this interface for production.
export interface AttendanceStore {
  listForEmployee(employeeId: string): Promise<TimesheetEntry[]>;
  listAll(): Promise<TimesheetEntry[]>;
  save(entry: TimesheetEntry): Promise<void>;
  clear(): Promise<void>;
}

const newestFirst = (a: TimesheetEntry, b: TimesheetEntry) => b.date.localeCompare(a.date) || b.clockIn.localeCompare(a.clockIn);

// Kept on globalThis so records survive Next.js dev hot reloads.
const holder = globalThis as typeof globalThis & { __bs23Timesheets?: Map<string, TimesheetEntry> };
const records = (holder.__bs23Timesheets ??= new Map<string, TimesheetEntry>());

export const attendanceStore: AttendanceStore = {
  async listForEmployee(employeeId) {
    return [...records.values()].filter(e => e.employeeId === employeeId).sort(newestFirst).map(e => structuredClone(e));
  },
  async listAll() {
    return [...records.values()].sort(newestFirst).map(e => structuredClone(e));
  },
  async save(entry) {
    records.set(entry.id, structuredClone(entry));
  },
  async clear() {
    records.clear();
  },
};
