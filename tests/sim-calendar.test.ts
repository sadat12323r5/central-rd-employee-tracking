import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCalendar, toCalendarPolicy } from "@/domain/holiday-calendar";
import { calendarFromActive, dhakaClock, dhakaInstant, NO_ACTIVE_CALENDAR, SIM_END, SIM_START, SimSetupError, simulatedCalendar } from "../sim/calendar";

const csv = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const policy = toCalendarPolicy(buildCalendar([{ name: "bangladesh-2026.csv", text: csv }]));

describe("simulated calendar (Story 9.1)", () => {
  it("covers Mon 2026-08-03 to Fri 2026-09-25: 40 weekdays, 3 holidays skipped, 37 working days", () => {
    expect([SIM_START, SIM_END]).toEqual(["2026-08-03", "2026-09-25"]);
    const calendar = simulatedCalendar(policy);
    expect(calendar.weekdays).toHaveLength(40);
    expect(calendar.weekdays[0]).toBe("2026-08-03");
    expect(calendar.weekdays.at(-1)).toBe("2026-09-25");
    expect(calendar.holidays).toEqual([{ date: "2026-08-05" }, { date: "2026-08-26" }, { date: "2026-09-04" }]);
    expect(calendar.workingDays).toHaveLength(37);
    expect(calendar.workingDays).not.toContain("2026-08-05");
    expect(calendar.workingDays.every(d => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);
  });

  it("names holidays when names are given", () => {
    const names = new Map([["2026-08-26", "Eid-e-Milad-un-Nabi"]]);
    expect(simulatedCalendar(policy, names).holidays[1]).toEqual({ date: "2026-08-26", name: "Eid-e-Milad-un-Nabi" });
  });

  it("stops with the calendar message when the policy does not cover the year", () => {
    const old = { holidays: new Set<string>(), supportedYearStart: 2025, supportedYearEnd: 2025 };
    expect(() => simulatedCalendar(old)).toThrow(SimSetupError);
    expect(() => simulatedCalendar(old)).toThrow(/covers 2025-2025, not the simulated period/);
  });

  it("refuses to start without an active calendar", () => {
    expect(() => calendarFromActive(null)).toThrow(NO_ACTIVE_CALENDAR);
    expect(NO_ACTIVE_CALENDAR).toMatch(/^No active holiday calendar/);
    expect(calendarFromActive({ policy }).workingDays).toHaveLength(37);
  });

  it("builds Asia/Dhaka instants", () => {
    expect(dhakaInstant("2026-08-03", "09:00").toISOString()).toBe("2026-08-03T03:00:00.000Z");
    expect(dhakaInstant("2026-08-03", "00:30").toISOString()).toBe("2026-08-02T18:30:00.000Z");
    expect(dhakaClock(dhakaInstant("2026-08-03", "18:05"))).toBe("18:05");
    expect(() => dhakaInstant("2026-8-3", "9:00")).toThrow();
  });
});
