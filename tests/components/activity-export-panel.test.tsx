// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const exportMock = vi.fn();
const exportAllMock = vi.fn();
vi.mock("@/server/activity-actions", () => ({
  exportActivityAction: (...args: unknown[]) => exportMock(...args),
  exportAllActivityAction: (...args: unknown[]) => exportAllMock(...args),
}));

import ActivityExportPanel from "@/components/activity-export-panel";

const CSV = '﻿"employee_id","employee_name","date","type","title","details","status"';

describe("ActivityExportPanel", () => {
  let click: ReturnType<typeof vi.spyOn>;
  let saved: { blob?: Blob; filename?: string };

  beforeEach(() => {
    exportMock.mockReset();
    exportAllMock.mockReset();
    saved = {};
    URL.createObjectURL = vi.fn((blob: Blob) => { saved.blob = blob; return "blob:activity"; });
    URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.filename = this.download;
    });
  });
  afterEach(() => click.mockRestore());

  it("downloads the CSV for the chosen month and says so", async () => {
    exportMock.mockResolvedValue({ error: "", message: "", csv: CSV, filename: "activity-BS-1001-2026-09-01_to_2026-09-30.csv" });
    const user = userEvent.setup();
    render(<ActivityExportPanel employeeId="BS-1001" />);
    await user.selectOptions(screen.getByLabelText("Period"), "month");
    await user.selectOptions(screen.getByLabelText("Month"), "9");
    await user.clear(screen.getByLabelText("Year"));
    await user.type(screen.getByLabelText("Year"), "2026");
    await user.click(screen.getByRole("button", { name: "Download activity" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Downloaded activity-BS-1001-2026-09-01_to_2026-09-30.csv.");
    expect(saved.filename).toBe("activity-BS-1001-2026-09-01_to_2026-09-30.csv");
    expect(saved.blob?.type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(saved.blob!);
    }));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const submitted = exportMock.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(submitted)).toEqual({ employeeId: "BS-1001", period: "month", month: "9", year: "2026" });
  });

  it("sends a custom range's dates", async () => {
    exportMock.mockResolvedValue({ error: "", message: "", csv: CSV, filename: "activity-BS-1001-2026-09-01_to_2026-09-05.csv" });
    const user = userEvent.setup();
    render(<ActivityExportPanel employeeId="BS-1001" />);
    await user.selectOptions(screen.getByLabelText("Period"), "custom");
    await user.type(screen.getByLabelText("From"), "2026-09-01");
    await user.type(screen.getByLabelText("To"), "2026-09-05");
    await user.click(screen.getByRole("button", { name: "Download activity" }));
    await screen.findByRole("status");
    const submitted = exportMock.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(submitted)).toEqual({ employeeId: "BS-1001", period: "custom", from: "2026-09-01", to: "2026-09-05" });
  });

  it("offers every period", () => {
    render(<ActivityExportPanel employeeId="BS-1001" />);
    expect([...(screen.getByLabelText("Period") as HTMLSelectElement).options].map(o => o.text))
      .toEqual(["This week", "Last week", "Month", "Year", "Custom range", "All time"]);
  });

  it("shows a server error as an alert and downloads nothing", async () => {
    exportMock.mockResolvedValue({ error: "Activity could not be exported because a record source is unavailable. Nothing was downloaded. Please try again.", message: "" });
    const user = userEvent.setup();
    render(<ActivityExportPanel employeeId="BS-1001" />);
    await user.selectOptions(screen.getByLabelText("Period"), "all");
    await user.click(screen.getByRole("button", { name: "Download activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was downloaded. Please try again.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("has no detectable accessibility violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<ActivityExportPanel employeeId="BS-1001" />);
    expect(await axe(container)).toHaveNoViolations();
    await user.selectOptions(screen.getByLabelText("Period"), "custom");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("ActivityExportPanel bulk mode (Story 8.2)", () => {
  let click: ReturnType<typeof vi.spyOn>;
  let saved: { filename?: string };

  beforeEach(() => {
    exportMock.mockReset();
    exportAllMock.mockReset();
    saved = {};
    URL.createObjectURL = vi.fn(() => "blob:activity");
    URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.filename = this.download;
    });
  });
  afterEach(() => click.mockRestore());

  it("is titled for all employees and offers every period and an unticked Include archived checkbox", () => {
    render(<ActivityExportPanel />);
    expect(screen.getByRole("heading", { name: "Download activity (all employees)" })).toBeInTheDocument();
    expect([...(screen.getByLabelText("Period") as HTMLSelectElement).options].map(o => o.text))
      .toEqual(["This week", "Last week", "Month", "Year", "Custom range", "All time"]);
    expect(screen.getByRole("checkbox", { name: "Include archived" })).not.toBeChecked();
  });

  it("sends the bulk action the period only (no Employee ID) and downloads the file", async () => {
    exportAllMock.mockResolvedValue({ error: "", message: "", csv: CSV, filename: "activity-all-employees-2026-10-05_to_2026-10-11.csv" });
    const user = userEvent.setup();
    render(<ActivityExportPanel />);
    await user.selectOptions(screen.getByLabelText("Period"), "last-week");
    await user.click(screen.getByRole("button", { name: "Download activity (all employees)" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Downloaded activity-all-employees-2026-10-05_to_2026-10-11.csv.");
    expect(saved.filename).toBe("activity-all-employees-2026-10-05_to_2026-10-11.csv");
    expect(exportMock).not.toHaveBeenCalled();
    expect(Object.fromEntries(exportAllMock.mock.calls[0][1] as FormData)).toEqual({ period: "last-week" });
  });

  it("sends includeArchived=on when Include archived is ticked", async () => {
    exportAllMock.mockResolvedValue({ error: "", message: "", csv: CSV, filename: "activity-all-employees-2025-01-03_to_2026-10-10.csv" });
    const user = userEvent.setup();
    render(<ActivityExportPanel />);
    await user.selectOptions(screen.getByLabelText("Period"), "all");
    await user.click(screen.getByRole("checkbox", { name: "Include archived" }));
    await user.click(screen.getByRole("button", { name: "Download activity (all employees)" }));
    await screen.findByRole("status");
    expect(Object.fromEntries(exportAllMock.mock.calls[0][1] as FormData)).toEqual({ period: "all", includeArchived: "on" });
  });

  it("keeps Include archived ticked after a download, so the next one includes archived employees too", async () => {
    exportAllMock.mockResolvedValue({ error: "", message: "", csv: CSV, filename: "activity-all-employees-2025-01-03_to_2026-10-10.csv" });
    const user = userEvent.setup();
    render(<ActivityExportPanel />);
    await user.click(screen.getByRole("checkbox", { name: "Include archived" }));
    await user.click(screen.getByRole("button", { name: "Download activity (all employees)" }));
    await screen.findByRole("status");
    expect(screen.getByRole("checkbox", { name: "Include archived" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Download activity (all employees)" }));
    await vi.waitFor(() => expect(exportAllMock).toHaveBeenCalledTimes(2));
    expect((exportAllMock.mock.calls[1][1] as FormData).get("includeArchived")).toBe("on");
  });

  it("shows a server error as an alert and downloads nothing", async () => {
    exportAllMock.mockResolvedValue({ error: "The end date cannot be before the start date.", message: "" });
    const user = userEvent.setup();
    render(<ActivityExportPanel />);
    await user.click(screen.getByRole("button", { name: "Download activity (all employees)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The end date cannot be before the start date.");
    expect(click).not.toHaveBeenCalled();
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<ActivityExportPanel />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
