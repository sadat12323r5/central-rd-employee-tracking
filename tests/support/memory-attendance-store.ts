import type { TimesheetEntry } from "@/domain/timesheet";
import type { AttendanceStore } from "@/server/attendance-store";

// In-memory AttendanceStore for unit tests (the pre-Story 1.5 implementation). Only this test
// double supports clear(); the Supabase store never deletes.
const newestFirst = (a: TimesheetEntry, b: TimesheetEntry) => b.date.localeCompare(a.date) || b.clockIn.localeCompare(a.clockIn);

export function createMemoryAttendanceStore(): AttendanceStore {
  const records = new Map<string, TimesheetEntry>();
  return {
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
}
