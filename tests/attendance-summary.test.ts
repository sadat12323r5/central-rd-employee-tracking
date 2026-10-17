import { describe, expect, it } from "vitest";
import {
  AttendanceYearNotCoveredError, monthToDate, periodLabel, summariseAttendance, type SummaryLeave,
} from "@/domain/attendance-summary";
import { countWorkingDays, isWorkingDay, LeaveValidationError, type CalendarPolicy } from "@/domain/leave";

const policy = (holidays: string[] = []): CalendarPolicy => ({ holidays: new Set(holidays), supportedYearStart: 2026, supportedYearEnd: 2026 });
const leave = (startDate: string, endDate: string, cancelledAt: string | null = null): SummaryLeave & { id: string } =>
  ({ id: `${startDate}..${endDate}`, startDate, endDate, cancelledAt });
const summarise = (today: string, { entries = [] as string[], leaves = [] as ReturnType<typeof leave>[], holidays = [] as string[] } = {}) =>
  summariseAttendance({ period: monthToDate(today), policy: policy(holidays), entryDates: entries, leave: leaves });
const totals = ({ scheduled, worked, leave: onLeave, missing }: ReturnType<typeof summarise>) => ({ scheduled, worked, leave: onLeave, missing });

describe("monthToDate and periodLabel", () => {
  it("is the current month from the 1st to today", () => {
    expect(monthToDate("2026-10-17")).toEqual({ from: "2026-10-01", to: "2026-10-17" });
    expect(monthToDate("2026-03-05")).toEqual({ from: "2026-03-01", to: "2026-03-05" });
  });

  it("labels the period with an en dash and the full month", () => {
    expect(periodLabel(monthToDate("2026-10-17"))).toBe("1–17 October 2026");
    expect(periodLabel(monthToDate("2026-11-01"))).toBe("1 November 2026");
  });
});

describe("isWorkingDay", () => {
  it("is Monday to Friday, not a holiday, and never throws for a weekend or holiday", () => {
    expect(isWorkingDay("2026-03-02", policy())).toBe(true);
    expect(isWorkingDay("2026-03-07", policy())).toBe(false);
    expect(isWorkingDay("2026-03-26", policy(["2026-03-26"]))).toBe(false);
  });

  it("refuses a year outside the policy and an invalid date, like countWorkingDays", () => {
    expect(() => isWorkingDay("2027-01-04", policy())).toThrow(LeaveValidationError);
    expect(() => isWorkingDay("2026-02-30", policy())).toThrow(LeaveValidationError);
  });

  it("leaves countWorkingDays unchanged", () => {
    expect(countWorkingDays("2026-03-02", "2026-03-13", policy(["2026-03-10"]))).toBe(9);
    expect(() => countWorkingDays("2026-03-07", "2026-03-08", policy())).toThrow(LeaveValidationError);
  });
});

describe("summariseAttendance (Story 5.4)", () => {
  it("plain month: scheduled weekdays to today, worked from entries, missing the difference", () => {
    const summary = summarise("2026-03-05", { entries: ["2026-03-02", "2026-03-03"] });
    expect(totals(summary)).toEqual({ scheduled: 4, worked: 2, leave: 0, missing: 2 });
    expect(summary.exceptions).toEqual([{ date: "2026-03-04", kind: "missing" }, { date: "2026-03-05", kind: "missing" }]);
  });

  it("excludes calendar holidays and weekends from scheduled days", () => {
    const summary = summarise("2026-03-27", { holidays: ["2026-03-26"] });
    expect(summary.scheduled).toBe(19);
    expect(summary.exceptions.map(x => x.date)).not.toContain("2026-03-26");
    expect(summary.exceptions.map(x => x.date)).not.toContain("2026-03-07");
    expect(summary.missing).toBe(19);
  });

  it("counts scheduled days covered by active leave as leave, not missing", () => {
    const period = leave("2026-03-04", "2026-03-05");
    const summary = summarise("2026-03-05", { entries: ["2026-03-02", "2026-03-03"], leaves: [period] });
    expect(totals(summary)).toEqual({ scheduled: 4, worked: 2, leave: 2, missing: 0 });
    expect(summary.exceptions).toEqual([
      { date: "2026-03-04", kind: "leave", leave: period }, { date: "2026-03-05", kind: "leave", leave: period },
    ]);
  });

  it("never counts cancelled leave: those days are missing records", () => {
    const summary = summarise("2026-03-05", { entries: ["2026-03-02", "2026-03-03"], leaves: [leave("2026-03-04", "2026-03-05", "2026-03-01T00:00:00Z")] });
    expect(totals(summary)).toEqual({ scheduled: 4, worked: 2, leave: 0, missing: 2 });
    expect(summary.exceptions.every(x => x.kind === "missing")).toBe(true);
  });

  it("classifies a day with an entry as worked even when leave covers it", () => {
    const summary = summarise("2026-03-05", { entries: ["2026-03-04"], leaves: [leave("2026-03-04", "2026-03-05")] });
    expect(totals(summary)).toEqual({ scheduled: 4, worked: 1, leave: 1, missing: 2 });
    expect(summary.exceptions.find(x => x.date === "2026-03-04")).toBeUndefined();
  });

  it("counts a weekend entry as worked without changing scheduled days", () => {
    const summary = summarise("2026-03-09", { entries: ["2026-03-07"] });
    expect(totals(summary)).toEqual({ scheduled: 6, worked: 1, leave: 0, missing: 6 });
  });

  it("counts a holiday entry as worked, and ignores entries outside the period", () => {
    const summary = summarise("2026-03-27", { holidays: ["2026-03-26"], entries: ["2026-03-26", "2026-02-27", "2026-03-30"] });
    expect(summary.worked).toBe(1);
    expect(summary.scheduled).toBe(19);
  });

  it("only counts leave days within the period", () => {
    const summary = summarise("2026-03-03", { leaves: [leave("2026-02-23", "2026-03-02"), leave("2026-03-03", "2026-03-20")] });
    expect(totals(summary)).toEqual({ scheduled: 2, worked: 0, leave: 2, missing: 0 });
  });

  it("returns all zeros without throwing when the period has no scheduled day", () => {
    const summary = summariseAttendance({ period: monthToDate("2026-11-01"), policy: policy(), entryDates: [], leave: [] });
    expect(summary).toEqual({ scheduled: 0, worked: 0, leave: 0, missing: 0, exceptions: [] });
  });

  it("throws a typed error for a year the calendar does not cover", () => {
    const error = (() => {
      try { summarise("2027-01-05"); } catch (e) { return e; }
    })();
    expect(error).toBeInstanceOf(AttendanceYearNotCoveredError);
    expect(error).toMatchObject({ year: 2027, message: "The holiday calendar doesn't cover 2027 yet." });
  });
});
