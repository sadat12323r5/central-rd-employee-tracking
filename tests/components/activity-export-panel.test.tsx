// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const exportMock = vi.fn();
vi.mock("@/server/activity-actions", () => ({
  exportActivityAction: (...args: unknown[]) => exportMock(...args),
}));

import ActivityExportPanel from "@/components/activity-export-panel";

const CSV = '﻿"employee_id","employee_name","date","type","title","details","status"';

describe("ActivityExportPanel", () => {
  let click: ReturnType<typeof vi.spyOn>;
  let saved: { blob?: Blob; filename?: string };

  beforeEach(() => {
    exportMock.mockReset();
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
