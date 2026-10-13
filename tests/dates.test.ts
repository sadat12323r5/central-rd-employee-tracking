import { describe, expect, it } from "vitest";
import { formatDisplayDate, formatDisplayDateTime, isCalendarDate } from "@/domain/dates";

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

describe("formatDisplayDateTime", () => {
  it("shows an instant as D MMM YYYY, HH:mm in Asia/Dhaka (GMT+6)", () => {
    expect(formatDisplayDateTime("2026-10-12T03:30:00.000Z")).toBe("12 Oct 2026, 09:30");
    expect(formatDisplayDateTime("2026-10-11T18:05:00Z")).toBe("12 Oct 2026, 00:05");
    expect(formatDisplayDateTime("2026-12-31T20:00:00+00:00")).toBe("1 Jan 2027, 02:00");
  });

  it("says Not recorded for anything that is not a timestamp", () => {
    expect(formatDisplayDateTime("")).toBe("Not recorded");
    expect(formatDisplayDateTime("yesterday")).toBe("Not recorded");
  });
});
