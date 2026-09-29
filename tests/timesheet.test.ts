import { describe, expect, it } from "vitest";
import {
  buildLog, clockIn, clockOut, dhakaDate, entryStatus, summariseEntries, todaysEntry, workedMinutes,
  TimesheetValidationError, type TimesheetEntry,
} from "../src/domain/timesheet";

// 09:00 in Dhaka on 28 Sep 2026 is 03:00 UTC.
const at = (dhakaTime: string, day = "2026-09-28") => new Date(`${day}T${dhakaTime}:00+06:00`);
const employeeId = "BS-1001";

function expectCode(fn: () => unknown, code: TimesheetValidationError["code"]) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(TimesheetValidationError);
    expect((error as TimesheetValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

function clockedIn(time = "09:00", day?: string): TimesheetEntry {
  return clockIn([], { id: "e1", employeeId, workMode: "Office", now: at(time, day) });
}

describe("dhakaDate", () => {
  it("uses the Dhaka calendar day, not UTC or the machine's zone", () => {
    expect(dhakaDate(new Date("2026-09-27T17:59:00Z"))).toBe("2026-09-27");
    expect(dhakaDate(new Date("2026-09-27T18:00:00Z"))).toBe("2026-09-28");
  });
});

describe("clockIn", () => {
  it("creates an open entry for today's Dhaka date", () => {
    const entry = clockedIn("00:30");
    expect(entry).toMatchObject({ date: "2026-09-28", clockOut: null, breakMinutes: 0, workMode: "Office", log: null });
    expect(entry.clockIn).toBe("2026-09-27T18:30:00.000Z");
  });
  it("rejects an unknown work mode", () => {
    expectCode(() => clockIn([], { id: "x", employeeId, workMode: "Beach", now: at("09:00") }), "INVALID_WORK_MODE");
  });
  it("rejects a second clock-in while clocked in", () => {
    expectCode(() => clockIn([clockedIn()], { id: "x", employeeId, workMode: "Remote", now: at("10:00") }), "ALREADY_CLOCKED_IN");
  });
  it("rejects clocking in again after clocking out the same day", () => {
    const done = clockOut(clockedIn(), { breakMinutes: 0, now: at("17:00") });
    expectCode(() => clockIn([done], { id: "x", employeeId, workMode: "Remote", now: at("18:00") }), "ALREADY_RECORDED");
  });
  it("allows today even if an earlier day was never clocked out", () => {
    const stale = clockedIn("09:00", "2026-09-27");
    expect(clockIn([stale], { id: "e2", employeeId, workMode: "Remote", now: at("09:00") }).date).toBe("2026-09-28");
  });
  it("does not confuse employees", () => {
    const other = { ...clockedIn(), employeeId: "BS-1002" };
    expect(() => clockIn([other], { id: "e2", employeeId, workMode: "Office", now: at("09:30") })).not.toThrow();
  });
});

describe("clockOut and worked time", () => {
  it("records clock-out and subtracts the break", () => {
    const done = clockOut(clockedIn(), { breakMinutes: 45, now: at("17:30") });
    expect(done.clockOut).toBe(at("17:30").toISOString());
    expect(workedMinutes(done, at("23:00"))).toBe(8 * 60 + 30 - 45);
  });
  it("rejects clocking out when not clocked in or already out", () => {
    expectCode(() => clockOut(undefined, { breakMinutes: 0, now: at("17:00") }), "NOT_CLOCKED_IN");
    const done = clockOut(clockedIn(), { breakMinutes: 0, now: at("17:00") });
    expectCode(() => clockOut(done, { breakMinutes: 0, now: at("18:00") }), "NOT_CLOCKED_IN");
  });
  it("rejects a clock-out earlier than clock-in", () => {
    expectCode(() => clockOut(clockedIn("10:00"), { breakMinutes: 0, now: at("09:00") }), "CLOCK_OUT_BEFORE_IN");
  });
  it.each([-5, 1.5, Number.NaN, 480, 600])("rejects break of %s minutes on an 8h day", breakMinutes => {
    expectCode(() => clockOut(clockedIn(), { breakMinutes, now: at("17:00") }), "INVALID_BREAK");
  });
  it("counts open entries up to now", () => {
    expect(workedMinutes(clockedIn(), at("11:15"))).toBe(135);
  });
});

describe("entryStatus and summaries", () => {
  it("distinguishes clocked in, completed and missing clock-out", () => {
    const open = clockedIn();
    expect(entryStatus(open, at("12:00"))).toBe("Clocked in");
    expect(entryStatus(open, at("08:00", "2026-09-29"))).toBe("Missing clock-out");
    expect(entryStatus(clockOut(open, { breakMinutes: 0, now: at("17:00") }), at("08:00", "2026-09-29"))).toBe("Completed");
  });
  it("finds today's entry and summarises", () => {
    const stale = { ...clockedIn("09:00", "2026-09-27"), id: "old" };
    const done = clockOut(clockedIn(), { breakMinutes: 60, now: at("17:00") });
    expect(todaysEntry([stale, done], employeeId, at("20:00"))?.id).toBe("e1");
    expect(summariseEntries([stale, done], at("20:00"))).toEqual({ daysRecorded: 2, minutesWorked: 7 * 60, missingClockOuts: 1, missingLogs: 1 });
  });
});

describe("buildLog", () => {
  const done = clockOut(clockedIn(), { breakMinutes: 60, now: at("17:00") }); // 7h worked
  const task = (description: string, hours: string, link = "") => ({ description, hours, link });
  const valid = { summary: "  Built the attendance page ", blockers: "", tasks: [task("Clock-in form", "3", "https://github.com/x/y/pull/1"), task("", "", "")] };

  it("trims text, drops empty rows and keeps links", () => {
    const log = buildLog(done, valid, at("17:05"));
    expect(log.summary).toBe("Built the attendance page");
    expect(log.tasks).toEqual([{ description: "Clock-in form", hours: 3, link: "https://github.com/x/y/pull/1" }]);
  });
  it.each([
    ["an empty summary", { ...valid, summary: "   " }],
    ["no tasks", { ...valid, tasks: [task("", "", "")] }],
    ["a task without a description", { ...valid, tasks: [task("", "2")] }],
    ["non-quarter hours", { ...valid, tasks: [task("Tests", "1.1")] }],
    ["zero hours", { ...valid, tasks: [task("Tests", "0")] }],
    ["a non-http link", { ...valid, tasks: [task("Tests", "1", "javascript:alert(1)")] }],
    ["more hours than worked", { ...valid, tasks: [task("A", "4"), task("B", "3.5")] }],
    ["too many tasks", { ...valid, tasks: Array.from({ length: 9 }, (_, i) => task(`T${i}`, "0.25")) }],
  ])("rejects %s", (_label, input) => {
    expectCode(() => buildLog(done, input, at("17:05")), "INVALID_LOG");
  });
  it("allows up to a quarter hour of rounding over time worked", () => {
    expect(() => buildLog(done, { ...valid, tasks: [task("A", "7.25")] }, at("17:05"))).not.toThrow();
  });
});
