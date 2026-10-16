import { describe, expect, it } from "vitest";
import {
  hasPeriodYear, invalidEmploymentHistoryFields, normalizeEmploymentHistory, periodStartKey, sortNewestFirst,
  type EmploymentHistoryInput,
} from "@/domain/employment-history";

const valid: EmploymentHistoryInput = { role: "QA Engineer", employer: "Brain Station 23", period: "2024-01-08 – Present", detail: "Test automation." };

describe("normalizeEmploymentHistory", () => {
  it("trims every field and collapses inner whitespace in role, employer and period", () => {
    expect(normalizeEmploymentHistory({ role: "  Senior   QA\tEngineer ", employer: " Brain  Station 23 ", period: " Mar  2023 –  Present ", detail: "  Line one.\n\nLine  two.  " }))
      .toEqual({ role: "Senior QA Engineer", employer: "Brain Station 23", period: "Mar 2023 – Present", detail: "Line one.\n\nLine  two." });
  });
  it("stores line breaks as LF, whatever the browser submitted", () => {
    expect(normalizeEmploymentHistory({ role: "QA", employer: "BS23", period: "2021", detail: "One.\r\nTwo.\rThree." }).detail).toBe("One.\nTwo.\nThree.");
  });
});

describe("invalidEmploymentHistoryFields", () => {
  it("accepts a valid entry, with an empty detail", () => {
    expect(invalidEmploymentHistoryFields(valid)).toEqual([]);
    expect(invalidEmploymentHistoryFields({ ...valid, detail: "" })).toEqual([]);
  });

  it("rejects blank role, employer and period", () => {
    expect(invalidEmploymentHistoryFields(normalizeEmploymentHistory({ role: " ", employer: "", period: "  ", detail: "" })))
      .toEqual(["role", "employer", "period"]);
  });

  it("rejects values that are too long", () => {
    expect(invalidEmploymentHistoryFields({ ...valid, role: "r".repeat(201) })).toEqual(["role"]);
    expect(invalidEmploymentHistoryFields({ ...valid, employer: "e".repeat(201) })).toEqual(["employer"]);
    expect(invalidEmploymentHistoryFields({ ...valid, period: `2020 ${"p".repeat(56)}` })).toEqual(["period"]);
    expect(invalidEmploymentHistoryFields({ ...valid, detail: "d".repeat(2001) })).toEqual(["detail"]);
    expect(invalidEmploymentHistoryFields({ role: "r".repeat(200), employer: "e".repeat(200), period: `2020 ${"p".repeat(55)}`, detail: "d".repeat(2000) })).toEqual([]);
  });

  it("requires a four-digit year 1900-2099 in the period", () => {
    for (const period of ["Present", "Since last spring", "1899 – 1901x", "2100", "12023", "20230"]) {
      expect(invalidEmploymentHistoryFields({ ...valid, period }), period).toEqual(period === "1899 – 1901x" ? [] : ["period"]);
    }
    for (const period of ["2021 – 2022", "Mar 2023 – Present", "2022-02-06 – Present", "1999", "since 2099"]) {
      expect(hasPeriodYear(period), period).toBe(true);
    }
  });
});

describe("periodStartKey", () => {
  it("uses the first year, with missing month and day as 00", () => {
    expect(periodStartKey("2021 – 2022")).toBe("20210000");
    expect(periodStartKey("Since 2019")).toBe("20190000");
  });

  it("refines by an ISO month and day at that year", () => {
    expect(periodStartKey("2022-02-06 – Present")).toBe("20220206");
    expect(periodStartKey("2022-11 – 2023-01")).toBe("20221100");
    expect(periodStartKey("2022-13 – 2023")).toBe("20220000");
  });

  it("refines by a month name or abbreviation right before the year", () => {
    expect(periodStartKey("Mar 2023 – Present")).toBe("20230300");
    expect(periodStartKey("March 2023 – Present")).toBe("20230300");
    expect(periodStartKey("Sept. 2020 – Dec 2021")).toBe("20200900");
    expect(periodStartKey("Ma 2023")).toBe("20230000");
    expect(periodStartKey("Contract 2023")).toBe("20230000");
  });

  it("gives an empty key without a year", () => {
    expect(periodStartKey("Present")).toBe("");
  });
});

describe("sortNewestFirst", () => {
  const entry = (id: string, period: string, createdAt = "2026-10-15T00:00:00Z") => ({ id, period, createdAt });

  it("orders the matrix example: Mar 2023, then 2022-02-06, then 2021", () => {
    const sorted = sortNewestFirst([entry("a", "2021 – 2022"), entry("b", "Mar 2023 – Present"), entry("c", "2022-02-06 – Present")]);
    expect(sorted.map(e => e.period)).toEqual(["Mar 2023 – Present", "2022-02-06 – Present", "2021 – 2022"]);
  });

  it("keeps the fixture order (current role first)", () => {
    const sorted = sortNewestFirst([entry("old", "2021 – 2022"), entry("now", "2022-02-06 – Present")]);
    expect(sorted.map(e => e.id)).toEqual(["now", "old"]);
  });

  it("breaks ties by creation time, then id, both descending, without mutating the input", () => {
    const input = [entry("a", "2023", "2026-10-01T00:00:00Z"), entry("b", "2023", "2026-10-02T00:00:00Z"), entry("c", "2023", "2026-10-02T00:00:00Z")];
    const before = structuredClone(input);
    expect(sortNewestFirst(input).map(e => e.id)).toEqual(["c", "b", "a"]);
    expect(input).toEqual(before);
  });
});
