// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { LeaveRecord } from "@/data/employees";

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock("@/server/leave-actions", () => ({ recordLeaveAction: (...args: unknown[]) => recordMock(...args) }));

import LeavePanel, { categoryDisplay } from "@/components/leave-panel";

const leave = (id: string, startDate: string, endDate: string, workingDays: number, category: LeaveRecord["category"], cancelledAt: string | null = null): LeaveRecord => ({
  id, employeeId: "BS-1001", startDate, endDate, workingDays, category, calendarVersionId: "cal-v3", cancelledAt, createdAt: "2026-10-17T00:00:00Z",
});
const records = [
  leave("b", "2026-06-01", "2026-06-19", 15, "FIFTEEN_TO_THIRTY"),
  leave("x", "2026-04-06", "2026-04-07", 2, "ONE_TO_THREE", "2026-10-10T00:00:00Z"),
  leave("a", "2026-03-02", "2026-03-05", 4, "FOUR_TO_FOURTEEN"),
];
const recordForm = () => within(screen.getByRole("form", { name: "Record leave" }));
const setDate = (label: string, value: string) => fireEvent.change(recordForm().getByLabelText(label), { target: { value } });

describe("categoryDisplay", () => {
  it("gives every stored category its label and colour from the domain", () => {
    expect(categoryDisplay("ONE_TO_THREE")).toEqual({ category: "ONE_TO_THREE", label: "1–3 working days", colour: "#22C55E" });
    expect(categoryDisplay("FOUR_TO_FOURTEEN").label).toBe("4–14 working days");
    expect(categoryDisplay("FIFTEEN_TO_THIRTY").label).toBe("15–30 working days");
    expect(categoryDisplay("THIRTY_ONE_TO_NINETY").label).toBe("31–90 working days");
    expect(categoryDisplay("NINETY_ONE_PLUS")).toMatchObject({ label: "91+ working days", colour: "#A855F7" });
  });
});

describe("LeavePanel (Story 5.2)", () => {
  beforeEach(() => recordMock.mockReset());

  it("lists periods in the given order with D MMM YYYY dates, working days, category label and colour, and Cancelled", async () => {
    const { container } = render(<LeavePanel employeeId="BS-1001" records={records} canEdit={false} />);
    const rows = within(screen.getByRole("table", { name: "Recorded leave" })).getAllByRole("row").slice(1);
    expect(rows.map(r => [...r.querySelectorAll("td")].map(td => td.textContent))).toEqual([
      ["1 Jun 2026", "19 Jun 2026", "15", "15–30 working days", "Recorded"],
      ["6 Apr 2026", "7 Apr 2026", "2", "1–3 working days", "Cancelled"],
      ["2 Mar 2026", "5 Mar 2026", "4", "4–14 working days", "Recorded"],
    ]);
    const swatch = rows[2].querySelector<HTMLElement>(".leave-swatch")!;
    expect(swatch.style.background).toBe("rgb(59, 130, 246)"); // #3B82F6
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state (own wording on the employee's own record)", () => {
    const { unmount } = render(<LeavePanel employeeId="BS-1001" records={[]} canEdit={false} />);
    expect(screen.getByText("No leave has been recorded.")).toBeInTheDocument();
    unmount();
    render(<LeavePanel employeeId="BS-1001" records={[]} canEdit own />);
    expect(screen.getByText("You have not recorded any leave yet.")).toBeInTheDocument();
  });

  it("offers a labelled form with required start and end dates when it can edit", async () => {
    const { container } = render(<LeavePanel employeeId="BS-1001" records={records} canEdit />);
    expect(recordForm().getByLabelText("First day of leave")).toBeRequired();
    expect(recordForm().getByLabelText("Last day of leave")).toBeRequired();
    expect(recordForm().getByLabelText("First day of leave")).toHaveAttribute("type", "date");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("submits the dates with the employee id, clears the form on success and shows the message", async () => {
    recordMock.mockResolvedValue({ error: "", message: "Leave recorded: 4 working days (4–14 working days)." });
    const user = userEvent.setup();
    render(<LeavePanel employeeId="BS-1001" records={[]} canEdit />);
    setDate("First day of leave", "2026-03-02");
    setDate("Last day of leave", "2026-03-05");
    await user.click(recordForm().getByRole("button", { name: "Record leave" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Leave recorded: 4 working days (4–14 working days).");
    expect(Object.fromEntries(recordMock.mock.calls[0][1] as FormData)).toEqual({ employeeId: "BS-1001", startDate: "2026-03-02", endDate: "2026-03-05" });
    expect(recordForm().getByLabelText("First day of leave")).toHaveValue("");
  });

  it("keeps the dates after a refusal and shows the error as an alert", async () => {
    recordMock.mockResolvedValue({ error: "This overlaps leave already recorded from 2 Mar 2026 to 5 Mar 2026.", message: "" });
    const user = userEvent.setup();
    render(<LeavePanel employeeId="BS-1001" records={records} canEdit />);
    setDate("First day of leave", "2026-03-05");
    setDate("Last day of leave", "2026-03-10");
    await user.click(recordForm().getByRole("button", { name: "Record leave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This overlaps leave already recorded from 2 Mar 2026 to 5 Mar 2026.");
    expect(recordForm().getByLabelText("First day of leave")).toHaveValue("2026-03-05");
    expect(recordForm().getByLabelText("Last day of leave")).toHaveValue("2026-03-10");
  });
});
