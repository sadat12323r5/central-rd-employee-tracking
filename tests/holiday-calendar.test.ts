import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCalendar, formatYears, HOLIDAY_CALENDAR_MAX_BYTES, HolidayCalendarInputError, parseHolidayCsv, toCalendarPolicy,
} from "@/domain/holiday-calendar";
import { countWorkingDays, LeaveValidationError } from "@/domain/leave";

const PROVISIONAL = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const HEADER = "date,name,kind";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const file = (name: string, text: string) => ({ name, text });

function inputError(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HolidayCalendarInputError);
    return (error as Error).message;
  }
  throw new Error("expected a HolidayCalendarInputError");
}

describe("parseHolidayCsv", () => {
  it("parses the provisional Bangladesh 2026 calendar", () => {
    const rows = parseHolidayCsv(PROVISIONAL, "bangladesh-2026.csv");
    expect(rows.length).toBeGreaterThanOrEqual(28);
    expect(rows[0]).toEqual({ date: "2026-02-04", name: "Shab-e-Barat", kind: "executive order", line: 2 });
    expect(rows.every(r => r.date.startsWith("2026-"))).toBe(true);
  });

  it("accepts quoted fields, escaped quotes, CRLF, a BOM and blank trailing lines", () => {
    const text = `\uFEFF${HEADER}\r\n"2026-03-26","Independence, and ""National"" Day",general\r\n2026-12-16,Victory Day,"special"\r\n\r\n\r\n`;
    expect(parseHolidayCsv(text, "a.csv")).toEqual([
      { date: "2026-03-26", name: 'Independence, and "National" Day', kind: "general", line: 2 },
      { date: "2026-12-16", name: "Victory Day", kind: "special", line: 3 },
    ]);
  });

  it("trims values and collapses whitespace in names", () => {
    expect(parseHolidayCsv(csv(" 2026-12-16 ,  Victory   Day , general "), "a.csv")[0])
      .toMatchObject({ date: "2026-12-16", name: "Victory Day", kind: "general" });
  });

  it.each([
    ["an empty file", "", "a.csv is empty"],
    ["only blank lines", "\n\n", "a.csv is empty"],
    ["a header only", `${HEADER}\n`, "a.csv has no holidays"],
    ["a wrong header", "date,holiday,kind\n2026-12-16,Victory Day,general", "a.csv line 1: the header must be exactly date,name,kind"],
    ["a two-field quoted header", 'date,"name,kind"\n2026-12-16,Victory Day,general', "a.csv line 1: the header must be exactly date,name,kind"],
    ["a year typo", csv("2026-12-16,Victory Day,general", "3026-12-25,Christmas Day,general"), "a.csv line 3: 3026-12-25 is outside the years 1900–2999"],
    ["a header with extra columns", "date,name,kind,notes\n2026-12-16,Victory Day,general,x", "a.csv line 1"],
    ["an invalid date", csv("2026-12-16,Victory Day,general", "2026-02-30,Bad,general"), 'a.csv line 3: "2026-02-30" is not a valid date'],
    ["a non-ISO date", csv("16/12/2026,Victory Day,general"), 'a.csv line 2: "16/12/2026" is not a valid date'],
    ["an unknown kind", csv("2026-12-16,Victory Day,national"), 'a.csv line 2: "national" is not a holiday kind'],
    ["an empty name", csv("2026-12-16,  ,general"), "a.csv line 2: the holiday name must be 1 to 200 characters"],
    ["a too-long name", csv(`2026-12-16,${"x".repeat(201)},general`), "a.csv line 2: the holiday name must be 1 to 200 characters"],
    ["too few values", csv("2026-12-16,Victory Day"), "a.csv line 2: expected 3 values (date, name, kind), found 2"],
    ["too many values", csv("2026-12-16,Victory,Day,general"), "a.csv line 2: expected 3 values (date, name, kind), found 4"],
    ["a duplicate date", csv("2026-12-16,Victory Day,general", "2026-12-25,Christmas Day,general", "2026-12-16,Again,general"),
      "a.csv line 4: 2026-12-16 is already listed on line 2"],
    ["a blank line in the middle", csv("2026-12-16,Victory Day,general", "", "2026-12-25,Christmas Day,general"), "a.csv line 3 is empty"],
    ["an unclosed quote", csv('2026-12-16,"Victory Day,general'), "a.csv line 2: a quoted field is never closed"],
    ["text after a closing quote", csv('2026-12-16,"Victory" Day,general'), "a.csv line 2: unexpected text after a closing quote"],
  ])("rejects %s, naming the problem", (_label, text, message) => {
    expect(inputError(() => parseHolidayCsv(text, "a.csv"))).toContain(message);
  });
});

describe("buildCalendar", () => {
  it("builds the provisional calendar: every holiday, sorted, years 2026–2026", () => {
    const calendar = buildCalendar([file("bangladesh-2026.csv", PROVISIONAL)]);
    expect(calendar.supportedYearStart).toBe(2026);
    expect(calendar.supportedYearEnd).toBe(2026);
    expect(calendar.holidays).toHaveLength(parseHolidayCsv(PROVISIONAL, "x.csv").length);
    expect(calendar.holidays.map(h => h.date)).toEqual([...calendar.holidays.map(h => h.date)].sort());
    expect(calendar.holidays[0]).toEqual({ date: "2026-02-04", name: "Shab-e-Barat", kind: "executive order" });
  });

  it("combines two consecutive years into one calendar, sorted by date", () => {
    const calendar = buildCalendar([
      file("bangladesh-2027.csv", csv("2027-12-16,Victory Day,general", "2027-02-21,Shaheed Day,general")),
      file("bangladesh-2026.csv", csv("2026-12-16,Victory Day,general")),
    ]);
    expect(calendar).toEqual({
      supportedYearStart: 2026, supportedYearEnd: 2027,
      holidays: [
        { date: "2026-12-16", name: "Victory Day", kind: "general" },
        { date: "2027-02-21", name: "Shaheed Day", kind: "general" },
        { date: "2027-12-16", name: "Victory Day", kind: "general" },
      ],
    });
  });

  it("rejects a gap in the years", () => {
    const files = [file("2026.csv", csv("2026-12-16,Victory Day,general")), file("2028.csv", csv("2028-12-16,Victory Day,general"))];
    expect(inputError(() => buildCalendar(files))).toBe("The calendar must cover consecutive years: add 2027 too.");
    const wide = [file("2026.csv", csv("2026-12-16,Victory Day,general")), file("2029.csv", csv("2029-12-16,Victory Day,general"))];
    expect(inputError(() => buildCalendar(wide))).toBe("The calendar must cover consecutive years: add 2027 and 2028 too.");
  });

  it("rejects no files", () => {
    expect(inputError(() => buildCalendar([]))).toBe("Choose at least one calendar file (.csv).");
  });

  it("rejects the same date in two files, naming both", () => {
    const files = [file("a.csv", csv("2026-12-16,Victory Day,general")), file("b.csv", csv("2026-12-25,Christmas,general", "2026-12-16,Again,general"))];
    expect(inputError(() => buildCalendar(files))).toBe("b.csv line 3: 2026-12-16 is already listed in a.csv.");
  });

  it("rejects files over 200 KB in total", () => {
    const big = csv(`2026-12-16,${"x".repeat(150)},general`) + "\n" + " ".repeat(HOLIDAY_CALENDAR_MAX_BYTES);
    expect(inputError(() => buildCalendar([file("big.csv", big)]))).toContain("too large");
  });

  it("rejects more than 1000 rows", () => {
    const rows: string[] = [];
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 1001; i++) rows.push(`${new Date(start + i * 86_400_000).toISOString().slice(0, 10)},Holiday ${i},general`);
    expect(inputError(() => buildCalendar([file("many.csv", csv(...rows))]))).toContain("1000 rows or fewer");
  });

  it("passes on a single file's error (with its line number)", () => {
    expect(inputError(() => buildCalendar([file("bad.csv", csv("2026-12-16,Victory Day,holiday"))]))).toContain("bad.csv line 2");
  });
});

describe("toCalendarPolicy with countWorkingDays", () => {
  const policy = toCalendarPolicy(buildCalendar([file("bangladesh-2026.csv", PROVISIONAL)]));

  it("is a CalendarPolicy of ISO date strings and the supported years", () => {
    expect(policy.supportedYearStart).toBe(2026);
    expect(policy.supportedYearEnd).toBe(2026);
    expect(policy.holidays.has("2026-12-16")).toBe(true);
    expect(policy.holidays.has("2026-12-17")).toBe(false);
  });

  it("excludes weekends and the February holidays", () => {
    // February 2026: 20 weekdays; holidays on weekdays: 4 (Wed), 11 (Wed), 12 (Thu). 21 Feb is a Saturday.
    expect(countWorkingDays("2026-02-01", "2026-02-28", policy)).toBe(17);
  });

  it("throws UNSUPPORTED_YEAR for a date outside the supported years, never guessing", () => {
    for (const [start, end] of [["2027-01-03", "2027-01-05"], ["2026-12-30", "2027-01-05"], ["2025-12-30", "2026-01-05"]]) {
      expect(() => countWorkingDays(start, end, policy)).toThrow(LeaveValidationError);
      expect(() => countWorkingDays(start, end, policy)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_YEAR" }));
    }
  });
});

describe("formatYears", () => {
  it("shows one year or a range", () => {
    expect(formatYears(2026, 2026)).toBe("2026");
    expect(formatYears(2026, 2027)).toBe("2026–2027");
  });
});
