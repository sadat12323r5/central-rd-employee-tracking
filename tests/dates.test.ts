import { describe, expect, it } from "vitest";
import { formatDisplayDate, isCalendarDate } from "@/domain/dates";

describe("isCalendarDate", () => {
  it.each(["2026-09-23", "2028-02-29", "2026-12-31", "0024-02-29"])("accepts %s", value => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each(["", "2026-9-23", "23/09/2026", "2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-01-00", "0000-01-01", "2026-09-23T00:00:00Z", " 2026-09-23"])(
    "rejects %j", value => {
      expect(isCalendarDate(value)).toBe(false);
    });
});

describe("formatDisplayDate", () => {
  it("formats as D MMM YYYY with three-letter months", () => {
    expect(formatDisplayDate("2026-09-23")).toBe("23 Sep 2026");
    expect(formatDisplayDate("2026-01-05")).toBe("5 Jan 2026");
    expect(formatDisplayDate("2026-12-31")).toBe("31 Dec 2026");
  });

  it("shows Not recorded for an empty or invalid date", () => {
    expect(formatDisplayDate("")).toBe("Not recorded");
    expect(formatDisplayDate("2026-02-30")).toBe("Not recorded");
  });
});
