// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const loadMock = vi.fn();
vi.mock("@/server/holiday-calendar-actions", () => ({
  loadHolidayCalendarAction: (...args: unknown[]) => loadMock(...args),
}));

import HolidayCalendarPanel from "@/components/holiday-calendar-panel";
import type { CalendarVersion } from "@/server/holiday-calendar-store";

const version = (n: number, overrides: Partial<CalendarVersion> = {}): CalendarVersion => ({
  id: `v-${n}`, version: n, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
  source: "bangladesh-2026.csv", loadedBy: "u", loadedAt: "2026-10-17T04:30:00Z", holidayCount: 31, ...overrides,
});

describe("HolidayCalendarPanel", () => {
  beforeEach(() => loadMock.mockReset());

  it("shows the active version's details", () => {
    render(<HolidayCalendarPanel versions={[version(2, { supportedYearEnd: 2027, source: "a.csv, b.csv" }), version(1)]} />);
    const active = within(screen.getByLabelText("Active holiday calendar"));
    expect(active.getByText("Version 2 (active)")).toBeInTheDocument();
    expect(active.getByText("Bangladesh")).toBeInTheDocument();
    expect(active.getByText("Asia/Dhaka")).toBeInTheDocument();
    expect(active.getByText("2026–2027")).toBeInTheDocument();
    expect(active.getByText("31 holidays")).toBeInTheDocument();
    expect(active.getByText("17 Oct 2026, 10:30")).toBeInTheDocument();
    expect(active.getByText("a.csv, b.csv")).toBeInTheDocument();
  });

  it("lists earlier versions, unchanged", () => {
    render(<HolidayCalendarPanel versions={[version(3), version(2, { holidayCount: 30 }), version(1, { holidayCount: 28 })]} />);
    const rows = within(screen.getByRole("table", { name: "Earlier holiday calendar versions" })).getAllByRole("row").slice(1);
    expect(rows.map(r => within(r).getAllByRole("cell").slice(0, 4).map(c => c.textContent))).toEqual([
      ["Version 2", "Bangladesh", "2026", "30"],
      ["Version 1", "Bangladesh", "2026", "28"],
    ]);
  });

  it("says when no calendar has been loaded yet", () => {
    render(<HolidayCalendarPanel versions={[]} />);
    expect(screen.getByText("No holiday calendar has been loaded yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the calendar is unavailable (never 'none loaded') when versions are null", () => {
    render(<HolidayCalendarPanel versions={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
    expect(screen.queryByText("No holiday calendar has been loaded yet.")).not.toBeInTheDocument();
  });

  it("has a CSV file input (multiple) and a jurisdiction defaulting to Bangladesh, with no edit or delete control", () => {
    render(<HolidayCalendarPanel versions={[version(1)]} />);
    const files = screen.getByLabelText("Calendar files (.csv)");
    expect(files).toHaveAttribute("type", "file");
    expect(files).toHaveAttribute("multiple");
    expect(files).toHaveAttribute("accept", ".csv");
    expect(screen.getByLabelText("Jurisdiction")).toHaveValue("Bangladesh");
    expect(screen.queryByRole("button", { name: /delete|remove|edit/i })).not.toBeInTheDocument();
  });

  it("submits the chosen files and jurisdiction and shows the result", async () => {
    loadMock.mockResolvedValue({ error: "", message: "Holiday calendar version 2 loaded (31 holidays, 2026)." });
    const user = userEvent.setup();
    render(<HolidayCalendarPanel versions={[version(1)]} />);
    const file = new File(["date,name,kind\n2026-12-16,Victory Day,general\n"], "bangladesh-2026.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Calendar files (.csv)"), file);
    await user.click(screen.getByRole("button", { name: "Load calendar" }));
    expect(await screen.findByText("Holiday calendar version 2 loaded (31 holidays, 2026).")).toHaveAttribute("role", "status");
    const submitted = loadMock.mock.calls[0][1] as FormData;
    // jsdom does not copy user-event's uploaded files into FormData; the e2e spec covers the real upload.
    expect(submitted.has("files")).toBe(true);
    expect(submitted.get("jurisdiction")).toBe("Bangladesh");
  });

  it("shows a refusal as an alert", async () => {
    loadMock.mockResolvedValue({ error: "The calendar must cover consecutive years: add 2027 too. Nothing was saved.", message: "" });
    const user = userEvent.setup();
    render(<HolidayCalendarPanel versions={[]} />);
    await user.upload(screen.getByLabelText("Calendar files (.csv)"), new File(["x"], "a.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Load calendar" }));
    expect(loadMock).toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("add 2027 too. Nothing was saved.");
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<HolidayCalendarPanel versions={[version(2), version(1)]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
