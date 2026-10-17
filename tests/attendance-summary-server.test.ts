import { describe, expect, it, vi } from "vitest";
import type { TimesheetEntry } from "@/domain/timesheet";
import { AttendanceUnavailableError } from "@/server/attendance-store";
import { attendanceSummariesFor, type AttendanceSummaryDeps } from "@/server/attendance-summary";
import { HolidayCalendarUnavailableError, type CalendarVersion } from "@/server/holiday-calendar-store";
import type { SessionIdentity } from "@/server/session";

const version: CalendarVersion = {
  id: "cal-1", version: 1, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
  source: "bangladesh-2026.csv", loadedBy: null, loadedAt: "2026-10-01T00:00:00Z", holidayCount: 1,
};
const active = { version, policy: { holidays: new Set(["2026-03-26"]), supportedYearStart: 2026, supportedYearEnd: 2026 } };
const entry = (employeeId: string, date: string): TimesheetEntry => ({
  id: `${employeeId}-${date}`, employeeId, date, clockIn: `${date}T03:00:00.000Z`, clockOut: null, breakMinutes: 0, workMode: "Office", log: null,
});
const leave = (employeeId: string, startDate: string, endDate: string, cancelledAt: string | null = null) => ({
  id: `${employeeId}-${startDate}`, employeeId, startDate, endDate, workingDays: 2, category: "ONE_TO_THREE" as const,
  calendarVersionId: "cal-1", cancelledAt, createdAt: "2026-03-01T00:00:00Z",
});
const admin: SessionIdentity = { role: "admin" };
const manager: SessionIdentity = { role: "manager", employeeId: "BS-1099", userId: "aaaa0000-0000-4000-8000-000000000001" };

function deps(entries: TimesheetEntry[] = [], calendar: unknown = active) {
  return {
    calendar: { active: vi.fn(async () => { if (calendar instanceof Error) throw calendar; return calendar as typeof active | null; }) },
    attendance: { listInPeriod: vi.fn(async () => entries) },
  } satisfies AttendanceSummaryDeps;
}

describe("attendanceSummariesFor (Story 5.4)", () => {
  const people = [
    { id: "BS-1001", leave: [leave("BS-1001", "2026-03-04", "2026-03-05")] },
    { id: "BS-1002", leave: [leave("BS-1002", "2026-03-04", "2026-03-05", "2026-03-02T00:00:00Z")] },
  ];

  it("builds each listed employee's month-to-date summary from entries, non-cancelled leave and the calendar", async () => {
    const d = deps([entry("BS-1001", "2026-03-02"), entry("BS-1002", "2026-03-02"), entry("BS-1002", "2026-03-03")]);
    const result = await attendanceSummariesFor(admin, people, "2026-03-05", d);
    expect(d.calendar.active).toHaveBeenCalledWith(admin);
    expect(d.attendance.listInPeriod).toHaveBeenCalledWith(admin, { from: "2026-03-01", to: "2026-03-05" });
    if ("unavailable" in result) throw new Error("expected summaries");
    expect(result.period).toEqual({ from: "2026-03-01", to: "2026-03-05" });
    expect(result.byEmployee["BS-1001"]).toMatchObject({ scheduled: 4, worked: 1, leave: 2, missing: 1 });
    // Cancelled leave never counts.
    expect(result.byEmployee["BS-1002"]).toMatchObject({ scheduled: 4, worked: 2, leave: 0, missing: 2 });
    expect(result.byEmployee["BS-1001"].exceptions[1]).toEqual({ date: "2026-03-04", kind: "leave", leave: people[0].leave[0] });
  });

  it("uses the calendar's holidays for scheduled days", async () => {
    const result = await attendanceSummariesFor(admin, people.slice(0, 1), "2026-03-27", deps());
    if ("unavailable" in result) throw new Error("expected summaries");
    expect(result.byEmployee["BS-1001"].scheduled).toBe(19);
  });

  it("leaves out archived employees and ignores entries of employees not listed", async () => {
    const d = deps([entry("BS-1003", "2026-03-02")]);
    const result = await attendanceSummariesFor(manager, [...people, { id: "BS-1004", archived: true, leave: [] }], "2026-03-05", d);
    if ("unavailable" in result) throw new Error("expected summaries");
    expect(Object.keys(result.byEmployee)).toEqual(["BS-1001", "BS-1002"]);
    expect(d.attendance.listInPeriod).toHaveBeenCalledWith(manager, { from: "2026-03-01", to: "2026-03-05" });
  });

  it("does not read attendance when no employee is listed", async () => {
    const d = deps();
    expect(await attendanceSummariesFor(manager, [], "2026-03-05", d)).toEqual({ period: { from: "2026-03-01", to: "2026-03-05" }, byEmployee: {} });
    expect(d.attendance.listInPeriod).not.toHaveBeenCalled();
  });

  it("says no calendar is loaded, without reading attendance", async () => {
    const d = deps([], null);
    expect(await attendanceSummariesFor(admin, people, "2026-03-05", d)).toEqual({ unavailable: "no-calendar" });
    expect(d.attendance.listInPeriod).not.toHaveBeenCalled();
  });

  it("says which year the calendar does not cover, without reading attendance", async () => {
    const d = deps();
    expect(await attendanceSummariesFor(admin, people, "2027-01-05", d)).toEqual({ unavailable: "year", year: 2027 });
    expect(d.attendance.listInPeriod).not.toHaveBeenCalled();
  });

  it("reports a calendar read failure as a value (logged), never as numbers", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await attendanceSummariesFor(admin, people, "2026-03-05", deps([], new HolidayCalendarUnavailableError())))
      .toEqual({ unavailable: "calendar-error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("lets an attendance read failure propagate (the page's alert)", async () => {
    const d = deps();
    d.attendance.listInPeriod.mockRejectedValue(new AttendanceUnavailableError());
    await expect(attendanceSummariesFor(admin, people, "2026-03-05", d)).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });

  it("returns all zeros when the month so far has no scheduled day", async () => {
    const result = await attendanceSummariesFor(admin, people.slice(0, 1), "2026-11-01", deps());
    if ("unavailable" in result) throw new Error("expected summaries");
    expect(result.byEmployee["BS-1001"]).toEqual({ scheduled: 0, worked: 0, leave: 0, missing: 0, exceptions: [] });
  });
});
