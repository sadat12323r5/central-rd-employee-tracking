import { describe, expect, it } from "vitest";

import { toCsv } from "../src/domain/csv";

describe("toCsv", () => {
  it("quotes every field and joins rows with CRLF", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe('"a","b"\r\n"c","d"');
  });

  it("escapes an embedded double quote by doubling it", () => {
    expect(toCsv([['Say "hi"', "plain"]])).toBe('"Say ""hi""","plain"');
  });

  it("preserves commas inside a quoted field", () => {
    expect(toCsv([["Doe, Jane", "Engineer"]])).toBe('"Doe, Jane","Engineer"');
  });

  it("returns an empty string for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("handles a header-only export with empty cells", () => {
    expect(toCsv([["Employee ID", ""]])).toBe('"Employee ID",""');
  });
});
