// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("@/server/auth", () => ({ signOut: () => {} }));
vi.mock("@/server/attendance-actions", () => ({
  clockInAction: vi.fn(), clockOutAction: vi.fn(), saveLogAction: vi.fn(),
}));

import StaffAttendance from "@/components/staff-attendance";
import { employees } from "@/data/employees";
import type { TimesheetEntry } from "@/domain/timesheet";

const employee = employees[0];
const now = "2026-09-28T06:00:00.000Z"; // 12:00 in Dhaka
const open: TimesheetEntry = { id: "a", employeeId: employee.id, date: "2026-09-28", clockIn: "2026-09-28T03:00:00.000Z", clockOut: null, breakMinutes: 0, workMode: "Remote", log: null };
const stale: TimesheetEntry = { ...open, id: "b", date: "2026-09-25", clockIn: "2026-09-25T03:00:00.000Z" };

describe("StaffAttendance", () => {
  // The page ticks with the browser clock, so pin it to the same moment as the server.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  it("offers work modes and clock-in before the day starts", async () => {
    const { container } = render(<StaffAttendance employee={employee} entries={[]} serverNow={now} />);
    expect(screen.getByRole("radio", { name: "Office" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Clock in" })).toBeInTheDocument();
    expect(screen.getByText("Clock in to start today's log.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the running day, clock-out and the log once clocked in", async () => {
    const { container } = render(<StaffAttendance employee={employee} entries={[open, stale]} serverNow={now} />);
    expect(screen.getByText(/Clocked in at 09:00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clock out" })).toBeInTheDocument();
    expect(screen.getByText(/missing a clock-out/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "What did you work on today?" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("adds and removes task rows", async () => {
    const user = userEvent.setup();
    render(<StaffAttendance employee={employee} entries={[open]} serverNow={now} />);
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(screen.getByRole("textbox", { name: "Task 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove task 2" }));
    expect(screen.queryByRole("textbox", { name: "Task 2" })).not.toBeInTheDocument();
  });
});
