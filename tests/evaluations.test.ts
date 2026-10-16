import { describe, expect, it } from "vitest";
import { authorNames, authorshipText, isAmended, UNKNOWN_AUTHOR } from "@/domain/evaluations";

const departments = [
  { managerUserId: "u-mgr", managerEmployeeId: "BS-1002" },
  { managerUserId: "u-hidden", managerEmployeeId: "BS-1099" },
  { managerUserId: "u-admin", managerEmployeeId: null },
  { managerUserId: null, managerEmployeeId: null },
];
const employees = [{ id: "BS-1002", name: "Arif Hasan" }];
const written = { createdBy: "u-mgr", createdAt: "2026-10-16T04:00:00Z", authoredBy: "u-mgr", updatedAt: "2026-10-16T04:00:00Z" };

describe("authorNames (Story 4.6)", () => {
  const name = authorNames(departments, employees);
  it("names a department manager whose employee the viewer can see", () => expect(name("u-mgr")).toBe("Arif Hasan"));
  it("says 'a manager' for a manager whose employee is not visible", () => expect(name("u-hidden")).toBe("a manager"));
  it("says 'the Administrator' for a manager account with no employee row", () => expect(name("u-admin")).toBe("the Administrator"));
  it("falls back to role words, never the raw id, for an account it cannot place", () => {
    expect(name("u-unknown")).toBe(UNKNOWN_AUTHOR);
    expect(authorNames([], [])("u-mgr")).toBe(UNKNOWN_AUTHOR);
  });
});

describe("authorshipText (Story 4.6)", () => {
  const name = authorNames(departments, employees);
  it("says who wrote it and when (D MMM YYYY, Dhaka day)", () => {
    expect(authorshipText(written, name)).toBe("Written by Arif Hasan on 16 Oct 2026");
    // 20:00 UTC on 15 Oct is 16 Oct in Dhaka.
    expect(authorshipText({ ...written, createdAt: "2026-10-15T20:00:00Z", updatedAt: "2026-10-15T20:00:00Z" }, name)).toBe("Written by Arif Hasan on 16 Oct 2026");
  });
  it("adds the amendment, by whom and when", () => {
    const amended = { ...written, authoredBy: "u-admin", updatedAt: "2026-10-18T04:00:00Z" };
    expect(isAmended(amended)).toBe(true);
    expect(authorshipText(amended, name)).toBe("Written by Arif Hasan on 16 Oct 2026 · amended by the Administrator on 18 Oct 2026");
  });
  it("treats an untouched evaluation as not amended, and defaults to role words", () => {
    expect(isAmended(written)).toBe(false);
    expect(authorshipText(written)).toBe(`Written by ${UNKNOWN_AUTHOR} on 16 Oct 2026`);
  });
});
