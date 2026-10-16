import { describe, expect, it } from "vitest";
import { authorLabel, authorshipText, isAmended } from "@/domain/evaluations";

const written = {
  createdBy: "u-mgr", createdByName: "Arif Hasan", createdByRole: "manager" as const, createdAt: "2026-10-16T04:00:00Z",
  authoredBy: "u-mgr", authoredByName: "Arif Hasan", authoredByRole: "manager" as const, updatedAt: "2026-10-16T04:00:00Z",
};

describe("authorLabel (Story 4.6: the stored snapshot only)", () => {
  it("uses the stored name", () => expect(authorLabel("Arif Hasan", "manager")).toBe("Arif Hasan"));
  it("falls back to the stored role's words, never a raw id", () => {
    expect(authorLabel(null, "admin")).toBe("the Administrator");
    expect(authorLabel(null, "manager")).toBe("a manager");
    expect(authorLabel("  ", "manager")).toBe("a manager");
  });
});

describe("authorshipText (Story 4.6)", () => {
  it("says who wrote it and when (D MMM YYYY, Dhaka day)", () => {
    expect(authorshipText(written)).toBe("Written by Arif Hasan on 16 Oct 2026");
    // 20:00 UTC on 15 Oct is 16 Oct in Dhaka.
    expect(authorshipText({ ...written, createdAt: "2026-10-15T20:00:00Z", updatedAt: "2026-10-15T20:00:00Z" })).toBe("Written by Arif Hasan on 16 Oct 2026");
  });
  it("adds the amendment, by whom and when", () => {
    const amended = { ...written, authoredBy: "u-admin", authoredByName: null, authoredByRole: "admin" as const, updatedAt: "2026-10-18T04:00:00Z" };
    expect(isAmended(amended)).toBe(true);
    expect(authorshipText(amended)).toBe("Written by Arif Hasan on 16 Oct 2026 · amended by the Administrator on 18 Oct 2026");
  });
  it("treats an untouched evaluation as not amended; a manager with no name is 'a manager'", () => {
    expect(isAmended(written)).toBe(false);
    expect(authorshipText({ ...written, createdByName: null })).toBe("Written by a manager on 16 Oct 2026");
  });
});
