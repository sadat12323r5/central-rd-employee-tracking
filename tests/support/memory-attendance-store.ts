import type { TimesheetEntry } from "@/domain/timesheet";
import type { AttendanceStore } from "@/server/attendance-store";

// In-memory AttendanceStore for unit tests (the pre-Story 1.5 implementation). Only this test
// double supports clear(); the Supabase store never deletes.
const newestFirst = (a: TimesheetEntry, b: TimesheetEntry) => b.date.localeCompare(a.date) || b.clockIn.localeCompare(a.clockIn);

export function createMemoryAttendanceStore(): AttendanceStore {
  const records = new Map<string, TimesheetEntry>();
  const forEmployee = (employeeId: string) =>
    [...records.values()].filter(e => e.employeeId === employeeId).sort(newestFirst).map(e => structuredClone(e));
  return {
    // Admin and staff rules only; manager scoping is covered against the real store (attendance-store.test.ts).
    async listFor(session, employeeId) {
      if (session.role === "admin" || (session.role === "staff" && session.employeeId === employeeId)) return forEmployee(employeeId);
      return [];
    },
    async listInPeriod(session, { from, to }, employeeIds) {
      const mayRead = (id: string) => session.role === "admin" || (session.role === "staff" && session.employeeId === id);
      return [...records.values()]
        .filter(e => mayRead(e.employeeId) && (employeeIds === undefined || employeeIds.includes(e.employeeId)) && e.date >= from && e.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId))
        .map(e => structuredClone(e));
    },
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
