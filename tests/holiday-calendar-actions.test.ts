import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarVersion, HolidayCalendarLoad } from "@/server/holiday-calendar-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, load, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  load: vi.fn<(session: SessionIdentity, input: HolidayCalendarLoad) => Promise<CalendarVersion>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by holiday-calendar-store.test.ts and, against the shared project, holiday-calendar-rls.test.ts.
vi.mock("../src/server/holiday-calendar-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/holiday-calendar-store")>()),
  holidayCalendarStore: { load, active: vi.fn(), versions: vi.fn() },
}));

const actions = await import("../src/server/holiday-calendar-actions");
const { loadHolidayCalendarAction } = actions;
const { HolidayCalendarForbiddenError, HolidayCalendarUnavailableError } = await import("../src/server/holiday-calendar-store");

const PROVISIONAL = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const blank = { error: "", message: "" };
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const STAFF = { role: "staff", employeeId: "BS-1001" } as const;
const FORBIDDEN = "Only an Administrator can load the holiday calendar.";
const csv = (...rows: string[]) => ["date,name,kind", ...rows].join("\n");

function form(files: File[], jurisdiction?: string) {
  const data = new FormData();
  for (const file of files) data.append("files", file);
  if (jurisdiction !== undefined) data.append("jurisdiction", jurisdiction);
  return data;
}
const csvFile = (name: string, text: string) => new File([text], name, { type: "text/csv" });

beforeEach(() => {
  getSession.mockResolvedValue(ADMIN);
  load.mockImplementation(async (_session, input) => ({
    id: "v", version: 4, jurisdiction: input.jurisdiction, timezone: "Asia/Dhaka", supportedYearStart: input.calendar.supportedYearStart,
    supportedYearEnd: input.calendar.supportedYearEnd, source: input.source, loadedBy: "u", loadedAt: "2026-10-17T04:00:00Z",
    holidayCount: input.calendar.holidays.length,
  }));
});
afterEach(() => vi.clearAllMocks());

describe("holiday calendar actions module", () => {
  it("exports only the load action (no edit or delete)", () => {
    expect(Object.keys(actions)).toEqual(["loadHolidayCalendarAction"]);
  });
});

describe("loadHolidayCalendarAction", () => {
  it("loads the provisional file as a new version and says so", async () => {
    const result = await loadHolidayCalendarAction(blank, form([csvFile("bangladesh-2026.csv", PROVISIONAL)], "Bangladesh"));
    const count = PROVISIONAL.trim().split("\n").length - 1;
    expect(result).toEqual({ error: "", message: `Holiday calendar version 4 loaded (${count} holidays, 2026).` });
    expect(load).toHaveBeenCalledTimes(1);
    const [session, input] = load.mock.calls[0];
    expect(session).toEqual(ADMIN);
    expect(input).toMatchObject({ jurisdiction: "Bangladesh", source: "bangladesh-2026.csv", calendar: { supportedYearStart: 2026, supportedYearEnd: 2026 } });
    expect(input.calendar.holidays).toHaveLength(count);
    // The app always loads a live calendar (the one that becomes active); only tests load 'test' ones.
    expect(input.purpose).toBe("live");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("loads two consecutive years as one version", async () => {
    const result = await loadHolidayCalendarAction(blank, form([
      csvFile("bangladesh-2026.csv", csv("2026-12-16,Victory Day,general")), csvFile("bangladesh-2027.csv", csv("2027-12-16,Victory Day,general")),
    ], "Bangladesh"));
    expect(result.message).toBe("Holiday calendar version 4 loaded (2 holidays, 2026–2027).");
    expect(load.mock.calls[0][1]).toMatchObject({ source: "bangladesh-2026.csv, bangladesh-2027.csv", calendar: { supportedYearStart: 2026, supportedYearEnd: 2027 } });
  });

  it("defaults a missing jurisdiction to Bangladesh and normalises whitespace", async () => {
    await loadHolidayCalendarAction(blank, form([csvFile("a.csv", csv("2026-12-16,Victory Day,general"))]));
    expect(load.mock.calls[0][1].jurisdiction).toBe("Bangladesh");
    await loadHolidayCalendarAction(blank, form([csvFile("a.csv", csv("2026-12-16,Victory Day,general"))], "  Dhaka   Division "));
    expect(load.mock.calls[1][1].jurisdiction).toBe("Dhaka Division");
  });

  it.each([["a staff session", STAFF], ["a manager session", MANAGER], ["no session", null]])("refuses %s, saving nothing", async (_label, session) => {
    getSession.mockResolvedValue(session);
    expect(await loadHolidayCalendarAction(blank, form([csvFile("a.csv", PROVISIONAL)], "Bangladesh"))).toEqual({ error: FORBIDDEN, message: "" });
    expect(load).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["no files", [], "Choose at least one calendar file (.csv)."],
    ["an empty file input", [new File([], "")], "Choose at least one calendar file (.csv)."],
    ["a non-CSV file", [csvFile("calendar.txt", csv("2026-12-16,Victory Day,general"))], "Choose calendar files ending in .csv."],
    ["files over 200 KB", [csvFile("big.csv", "x".repeat(200 * 1024 + 1))], "too large"],
    ["a gap in the years", [csvFile("a.csv", csv("2026-12-16,V,general")), csvFile("b.csv", csv("2028-12-16,V,general"))],
      "The calendar must cover consecutive years: add 2027 too."],
    ["a bad header", [csvFile("a.csv", "day,name,kind\n2026-12-16,V,general")], "a.csv line 1: the header must be exactly date,name,kind"],
    ["a bad kind", [csvFile("a.csv", csv("2026-12-16,V,national"))], "a.csv line 2"],
    ["a bad date", [csvFile("a.csv", csv("2026-13-01,V,general"))], "a.csv line 2"],
    ["a duplicate date", [csvFile("a.csv", csv("2026-12-16,V,general", "2026-12-16,W,general"))], "a.csv line 3"],
    ["an empty file", [csvFile("a.csv", "")], "a.csv is empty"],
  ])("rejects %s, saving nothing", async (_label, files, message) => {
    const result = await loadHolidayCalendarAction(blank, form(files as File[], "Bangladesh"));
    expect(result.error).toContain(message);
    expect(result.error).toContain("Nothing was saved.");
    expect(result.message).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a file that is not UTF-8, saving nothing", async () => {
    const latin1 = new File([new Uint8Array([...new TextEncoder().encode("date,name,kind\n2026-12-16,Caf"), 0xe9, 0x2c, 0x67])], "a.csv");
    const result = await loadHolidayCalendarAction(blank, form([latin1], "Bangladesh"));
    expect(result.error).toBe("a.csv is not UTF-8 text. Save it as CSV UTF-8 and load it again. Nothing was saved.");
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a files entry that is not a file", async () => {
    const data = form([], "Bangladesh");
    data.append("files", "not-a-file.csv");
    const result = await loadHolidayCalendarAction(blank, data);
    expect(result.error).toBe("Choose calendar files ending in .csv. Nothing was saved.");
    expect(load).not.toHaveBeenCalled();
  });

  it.each([["an empty", "   "], ["a too-long", "x".repeat(101)]])("rejects %s jurisdiction", async (_label, jurisdiction) => {
    const result = await loadHolidayCalendarAction(blank, form([csvFile("a.csv", PROVISIONAL)], jurisdiction));
    expect(result.error).toMatch(/jurisdiction/);
    expect(load).not.toHaveBeenCalled();
  });

  it("maps the store's refusals; unavailable is never success", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    load.mockRejectedValueOnce(new HolidayCalendarUnavailableError());
    expect(await loadHolidayCalendarAction(blank, form([csvFile("a.csv", PROVISIONAL)], "Bangladesh")))
      .toEqual({ error: "The holiday calendar is temporarily unavailable. Nothing was saved.", message: "" });
    load.mockRejectedValueOnce(new HolidayCalendarForbiddenError());
    expect(await loadHolidayCalendarAction(blank, form([csvFile("a.csv", PROVISIONAL)], "Bangladesh"))).toEqual({ error: FORBIDDEN, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("rethrows unexpected errors", async () => {
    load.mockRejectedValueOnce(new Error("boom"));
    await expect(loadHolidayCalendarAction(blank, form([csvFile("a.csv", PROVISIONAL)], "Bangladesh"))).rejects.toThrow("boom");
  });
});
