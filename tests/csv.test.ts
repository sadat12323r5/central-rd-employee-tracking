import { describe, expect, it } from "vitest";

import { CSV_BOM, guardCell, toCsv } from "../src/domain/csv";

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

describe("CSV_BOM", () => {
  it("is the UTF-8 byte order mark", () => {
    expect(new TextEncoder().encode(CSV_BOM)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });
});

describe("guardCell", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", '=HYPERLINK("http://x","y")', "\t=1+1", "\r=1+1"])("prefixes %j with a quote", cell => {
    expect(guardCell(cell)).toBe(`'${cell}`);
  });

  it.each(["", "plain", "2026-09-01", " =not first", "'already"])("leaves %j unchanged", cell => {
    expect(guardCell(cell)).toBe(cell);
  });
});
