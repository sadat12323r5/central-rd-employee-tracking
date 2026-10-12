// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("@/server/auth", () => ({ signOut: () => {} }));
vi.mock("@/server/attendance-actions", () => ({
  clockInAction: vi.fn(), clockOutAction: vi.fn(), saveLogAction: vi.fn(),
}));
const { addInterviewAction, updateInterviewAction, withdrawInterviewAction } = vi.hoisted(() => ({
  addInterviewAction: vi.fn(), updateInterviewAction: vi.fn(), withdrawInterviewAction: vi.fn(),
}));
vi.mock("@/server/interviews-actions", () => ({ addInterviewAction, updateInterviewAction, withdrawInterviewAction }));

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

describe("StaffAttendance external interviews", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    addInterviewAction.mockReset(); updateInterviewAction.mockReset(); withdrawInterviewAction.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  const reported = {
    ...employee,
    interviews: [
      { id: "i-2", company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "", feedback: "", withdrawn: false },
      { id: "i-1", company: "Northstar Labs (fictional)", role: "Software Engineer I", date: "2026-09-23", stage: "Technical interview", outcome: "Scheduled", feedback: "Prepare.", withdrawn: false },
    ],
  };

  it("lists the employee's own interviews with company, role, date, stage, a text outcome and feedback", async () => {
    const { container } = render(<StaffAttendance employee={reported} entries={[]} serverNow={now} />);
    const table = screen.getByRole("table", { name: "Your external interviews" });
    const rows = within(table).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell").slice(0, 6).map(c => c.textContent));
    expect(rows).toEqual([
      ["Orbit Analytics", "AI Engineer", "20 Oct 2026", "Recruiter screen", "No outcome yet", "—"],
      ["Northstar Labs (fictional)", "Software Engineer I", "23 Sep 2026", "Technical interview", "Scheduled", "Prepare."],
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when no interviews are recorded", () => {
    render(<StaffAttendance employee={{ ...employee, interviews: [] }} entries={[]} serverNow={now} />);
    expect(screen.getByText("You have not added any external interviews yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
  });

  it("offers a labelled add form with required company, role, date and stage, and an optional outcome", () => {
    render(<StaffAttendance employee={employee} entries={[]} serverNow={now} />);
    for (const label of ["Company", "Role", "Stage"]) expect(screen.getByRole("textbox", { name: label })).toBeRequired();
    expect(screen.getByLabelText("Interview date")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Interview date")).toBeRequired();
    expect(screen.getByRole("textbox", { name: "Outcome (optional)" })).not.toBeRequired();
    expect(screen.getByRole("button", { name: "Add interview" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /employee/i })).not.toBeInTheDocument();
  });

  it("submits the form to the add action and shows its message", async () => {
    vi.useRealTimers();
    addInterviewAction.mockResolvedValue({ error: "", message: "Interview added." });
    const user = userEvent.setup();
    render(<StaffAttendance employee={employee} entries={[]} serverNow={now} />);
    await user.type(screen.getByRole("textbox", { name: "Company" }), "Orbit Analytics");
    await user.type(screen.getByRole("textbox", { name: "Role" }), "AI Engineer");
    await user.type(screen.getByLabelText("Interview date"), "2026-10-20");
    await user.type(screen.getByRole("textbox", { name: "Stage" }), "Recruiter screen");
    await user.click(screen.getByRole("button", { name: "Add interview" }));
    expect(await screen.findByText("Interview added.")).toBeInTheDocument();
    const submitted = addInterviewAction.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(submitted)).toEqual({ company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "" });
  });

  it("shows the action's error as an alert", async () => {
    vi.useRealTimers();
    addInterviewAction.mockResolvedValue({ error: "External interviews could not be reached, so nothing was saved. Please try again in a moment.", message: "" });
    const user = userEvent.setup();
    render(<StaffAttendance employee={employee} entries={[]} serverNow={now} />);
    await user.type(screen.getByRole("textbox", { name: "Company" }), "Orbit");
    await user.type(screen.getByRole("textbox", { name: "Role" }), "AI Engineer");
    await user.type(screen.getByLabelText("Interview date"), "2026-10-20");
    await user.type(screen.getByRole("textbox", { name: "Stage" }), "Screen");
    await user.click(screen.getByRole("button", { name: "Add interview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was saved/);
  });
});

describe("StaffAttendance interview updates and withdrawal (Story 2.2)", () => {
  beforeEach(() => { updateInterviewAction.mockReset(); withdrawInterviewAction.mockReset(); });

  const active = { id: "i-1", company: "Northstar Labs (fictional)", role: "Software Engineer I", date: "2026-09-23", stage: "Technical interview", outcome: "Scheduled", feedback: "Prepare.", withdrawn: false };
  const gone = { id: "i-0", company: "Mistake Corp", role: "Wrong role", date: "2026-09-01", stage: "Recruiter screen", outcome: "", feedback: "", withdrawn: true };
  const both = { ...employee, interviews: [active, gone] };

  it("offers only stage, outcome and feedback for an active entry, prefilled, plus withdraw", async () => {
    const user = userEvent.setup();
    const { container } = render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    const stage = screen.getByRole("textbox", { name: "Stage · Northstar Labs (fictional)" });
    expect(stage).toHaveValue("Technical interview");
    expect(stage).toBeRequired();
    expect(screen.getByRole("textbox", { name: "Outcome (optional) · Northstar Labs (fictional)" })).toHaveValue("Scheduled");
    expect(screen.getByRole("textbox", { name: "Feedback (optional) · Northstar Labs (fictional)" })).toHaveValue("Prepare.");
    // Locked fields are never offered for editing after creation.
    const editor = container.querySelector("details.staff-interview-editor")!;
    for (const name of ["company", "role", "date"]) expect(editor.querySelector(`[name="${name}"]`)).toBeNull();
    expect(screen.getByRole("button", { name: /^Withdraw interview: Northstar Labs/ })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("submits only id, stage, outcome and feedback to the update action and shows its message", async () => {
    updateInterviewAction.mockResolvedValue({ error: "", message: "Interview updated." });
    const user = userEvent.setup();
    render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    const stage = screen.getByRole("textbox", { name: "Stage · Northstar Labs (fictional)" });
    await user.clear(stage);
    await user.type(stage, "Offer stage");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Interview updated.")).toBeInTheDocument();
    const submitted = Object.fromEntries(updateInterviewAction.mock.calls[0][1] as FormData);
    expect(submitted).toEqual({ id: "i-1", stage: "Offer stage", outcome: "Scheduled", feedback: "Prepare." });
  });

  it("shows an update refusal as an alert", async () => {
    updateInterviewAction.mockResolvedValue({ error: "That interview was not found, or it is not yours, so nothing was saved.", message: "" });
    const user = userEvent.setup();
    render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not yours/);
  });

  it("submits the entry id to the withdraw action and shows its message", async () => {
    withdrawInterviewAction.mockResolvedValue({ error: "", message: "Interview withdrawn." });
    const user = userEvent.setup();
    render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /^Withdraw interview: Northstar Labs/ }));
    expect(await screen.findByText("Interview withdrawn.")).toBeInTheDocument();
    expect(Object.fromEntries(withdrawInterviewAction.mock.calls[0][1] as FormData)).toEqual({ id: "i-1" });
  });

  it("keeps the withdraw message once the entry has moved to the Withdrawn history (its editor unmounts)", async () => {
    withdrawInterviewAction.mockResolvedValue({ error: "", message: "Interview withdrawn." });
    const user = userEvent.setup();
    const { rerender } = render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /^Withdraw interview: Northstar Labs/ }));
    expect(await screen.findByText("Interview withdrawn.")).toBeInTheDocument();
    // What revalidatePath delivers: the same entry, now withdrawn.
    rerender(<StaffAttendance employee={{ ...employee, interviews: [{ ...active, withdrawn: true }, gone] }} entries={[]} serverNow={now} />);
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
    expect(screen.getByText("Interview withdrawn.")).toBeInTheDocument();
  });

  it("keeps withdrawn entries out of the active table, in a Withdrawn history without controls", () => {
    render(<StaffAttendance employee={both} entries={[]} serverNow={now} />);
    const table = screen.getByRole("table", { name: "Your external interviews" });
    expect(within(table).queryByText("Mistake Corp")).not.toBeInTheDocument();
    const history = screen.getByRole("list", { name: "Withdrawn (history)" });
    const item = within(history).getByRole("listitem");
    expect(item).toHaveTextContent("Withdrawn");
    expect(item).toHaveTextContent("Mistake Corp");
    expect(within(item).queryByRole("button")).not.toBeInTheDocument();
    expect(within(item).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says there are no active interviews when every entry is withdrawn", () => {
    render(<StaffAttendance employee={{ ...employee, interviews: [gone] }} entries={[]} serverNow={now} />);
    expect(screen.getByText("You have no active external interviews.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Withdrawn (history)" })).toBeInTheDocument();
  });
});
