import { describe, expect, it } from "vitest";

import {
  LeaveValidationError,
  categoryForWorkingDays,
  countWorkingDays,
  rangesOverlap,
  type CalendarPolicy,
} from "../src/domain/leave";

const policy: CalendarPolicy = {
  holidays: new Set(["2026-01-01", "2026-01-03"]),
  supportedYearStart: 2024,
  supportedYearEnd: 2027,
};

describe("countWorkingDays", () => {
  it("counts an inclusive same-day working range", () => {
    expect(countWorkingDays("2026-09-21", "2026-09-21", policy)).toBe(1);
  });

  it("counts weekdays across an inclusive weekend boundary", () => {
    expect(countWorkingDays("2026-09-18", "2026-09-21", policy)).toBe(2);
  });

  it("excludes a weekday holiday without double-subtracting a weekend holiday", () => {
    expect(countWorkingDays("2026-01-01", "2026-01-05", policy)).toBe(2);
  });

  it("handles leap days and year boundaries using date-only UTC arithmetic", () => {
    expect(countWorkingDays("2024-02-28", "2024-03-01", policy)).toBe(3);
    expect(countWorkingDays("2026-12-31", "2027-01-01", policy)).toBe(2);
  });

  it.each(["2026-02-29", "2026-13-01", "21-09-2026", ""])(
    "rejects invalid date %j",
    (value) => {
      expect(() => countWorkingDays(value, "2026-09-21", policy)).toThrowError(
        expect.objectContaining({ code: "INVALID_DATE" }),
      );
    },
  );

  it("rejects reversed ranges", () => {
    expect(() => countWorkingDays("2026-09-22", "2026-09-21", policy)).toThrowError(
      expect.objectContaining({ code: "REVERSED_RANGE" }),
    );
  });

  it("rejects a weekend-only zero-working-day range", () => {
    expect(() => countWorkingDays("2026-09-19", "2026-09-20", policy)).toThrowError(
      expect.objectContaining({ code: "ZERO_WORKING_DAYS" }),
    );
  });

  it("rejects unsupported calendar years", () => {
    expect(() => countWorkingDays("2028-01-03", "2028-01-03", policy)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_YEAR" }),
    );
  });
});

describe("categoryForWorkingDays", () => {
  it.each([
    [1, "ONE_TO_THREE"],
    [3, "ONE_TO_THREE"],
    [4, "FOUR_TO_FOURTEEN"],
    [14, "FOUR_TO_FOURTEEN"],
    [15, "FIFTEEN_TO_THIRTY"],
    [30, "FIFTEEN_TO_THIRTY"],
    [31, "THIRTY_ONE_TO_NINETY"],
    [90, "THIRTY_ONE_TO_NINETY"],
    [91, "NINETY_ONE_PLUS"],
  ] as const)("maps %i days to %s", (days, expected) => {
    expect(categoryForWorkingDays(days).category).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid count %s", (days) => {
    expect(() => categoryForWorkingDays(days)).toThrow(RangeError);
  });
});

describe("rangesOverlap", () => {
  it("treats touching inclusive ranges as overlapping", () => {
    expect(
      rangesOverlap(
        { startDate: "2026-09-21", endDate: "2026-09-23" },
        { startDate: "2026-09-23", endDate: "2026-09-25" },
      ),
    ).toBe(true);
  });

  it("accepts disjoint ranges", () => {
    expect(
      rangesOverlap(
        { startDate: "2026-09-21", endDate: "2026-09-22" },
        { startDate: "2026-09-23", endDate: "2026-09-25" },
      ),
    ).toBe(false);
  });

  it("rejects a reversed input range", () => {
    expect(() =>
      rangesOverlap(
        { startDate: "2026-09-22", endDate: "2026-09-21" },
        { startDate: "2026-09-23", endDate: "2026-09-25" },
      ),
    ).toThrow(LeaveValidationError);
  });
});
