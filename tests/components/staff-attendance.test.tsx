// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within, type RenderResult } from "@testing-library/react";
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
const { addBackfillAction, editBackfillAction, withdrawBackfillAction } = vi.hoisted(() => ({
  addBackfillAction: vi.fn(), editBackfillAction: vi.fn(), withdrawBackfillAction: vi.fn(),
}));
vi.mock("@/server/backfill-actions", () => ({ addBackfillAction, editBackfillAction, withdrawBackfillAction }));

import StaffAttendance, { StaffSelfService } from "@/components/staff-attendance";
import { employees } from "@/data/employees";
import type { TimesheetEntry } from "@/domain/timesheet";
import type { CurrentTraining, TrainingEntry } from "@/server/training-store";

/** LMS answers as page.tsx passes them: a promise that always resolves. */
const ok = (extra: Partial<Extract<CurrentTraining, { status: "ok" }>> = {}): Promise<CurrentTraining> =>
  Promise.resolve({ status: "ok", asOf: "2026-09-28T05:00:00.000Z", stale: false, inProgress: [], lmsCompleted: [], freshness: {}, ...extra });
const none = () => ok();
const pending = (): Promise<CurrentTraining> => new Promise(() => {});

/** Renders inside an awaited act, so a Suspense boundary reading a resolved promise can reveal its content. */
async function show(ui: React.ReactElement): Promise<RenderResult> {
  let result!: RenderResult;
  await act(async () => { result = render(ui); });
  return result;
}

const employee = employees[0];
const now = "2026-09-28T06:00:00.000Z"; // 12:00 in Dhaka
const open: TimesheetEntry = { id: "a", employeeId: employee.id, date: "2026-09-28", clockIn: "2026-09-28T03:00:00.000Z", clockOut: null, breakMinutes: 0, workMode: "Remote", log: null };
const stale: TimesheetEntry = { ...open, id: "b", date: "2026-09-25", clockIn: "2026-09-25T03:00:00.000Z" };

describe("StaffAttendance", () => {
  // The page ticks with the browser clock, so pin it to the same moment as the server.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  it("offers work modes and clock-in before the day starts", async () => {
    const { container } = await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
    expect(screen.getByRole("radio", { name: "Office" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Clock in" })).toBeInTheDocument();
    expect(screen.getByText("Clock in to start today's log.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers no Edit employee details form on the Staff member's own record (Story 7.2)", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
    expect(screen.queryByRole("form", { name: "Edit employee details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument();
  });

  it("shows the running day, clock-out and the log once clocked in", async () => {
    const { container } = await show(<StaffAttendance employee={employee} entries={[open, stale]} serverNow={now} current={none()} />);
    expect(screen.getByText(/Clocked in at 09:00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clock out" })).toBeInTheDocument();
    expect(screen.getByText(/missing a clock-out/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "What did you work on today?" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("adds and removes task rows", async () => {
    const user = userEvent.setup();
    await show(<StaffAttendance employee={employee} entries={[open]} serverNow={now} current={none()} />);
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
    const { container } = await show(<StaffAttendance employee={reported} entries={[]} serverNow={now} current={none()} />);
    const table = screen.getByRole("table", { name: "Your external interviews" });
    const rows = within(table).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell").slice(0, 6).map(c => c.textContent));
    expect(rows).toEqual([
      ["Orbit Analytics", "AI Engineer", "20 Oct 2026", "Recruiter screen", "No outcome yet", "—"],
      ["Northstar Labs (fictional)", "Software Engineer I", "23 Sep 2026", "Technical interview", "Scheduled", "Prepare."],
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when no interviews are recorded", async () => {
    await show(<StaffAttendance employee={{ ...employee, interviews: [] }} entries={[]} serverNow={now} current={none()} />);
    expect(screen.getByText("You have not added any external interviews yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
  });

  it("offers a labelled add form with required company, role, date and stage, and an optional outcome", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
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
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
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
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
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
    const { container } = await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
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
    await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
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
    await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not yours/);
  });

  it("submits the entry id to the withdraw action and shows its message", async () => {
    withdrawInterviewAction.mockResolvedValue({ error: "", message: "Interview withdrawn." });
    const user = userEvent.setup();
    await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /^Withdraw interview: Northstar Labs/ }));
    expect(await screen.findByText("Interview withdrawn.")).toBeInTheDocument();
    expect(Object.fromEntries(withdrawInterviewAction.mock.calls[0][1] as FormData)).toEqual({ id: "i-1" });
  });

  it("keeps the withdraw message once the entry has moved to the Withdrawn history (its editor unmounts)", async () => {
    withdrawInterviewAction.mockResolvedValue({ error: "", message: "Interview withdrawn." });
    const user = userEvent.setup();
    const { rerender } = await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
    await user.click(screen.getByText("Update", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /^Withdraw interview: Northstar Labs/ }));
    expect(await screen.findByText("Interview withdrawn.")).toBeInTheDocument();
    // What revalidatePath delivers: the same entry, now withdrawn.
    await act(async () => rerender(<StaffAttendance employee={{ ...employee, interviews: [{ ...active, withdrawn: true }, gone] }} entries={[]} serverNow={now} current={none()} />));
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
    expect(screen.getByText("Interview withdrawn.")).toBeInTheDocument();
  });

  it("keeps withdrawn entries out of the active table, in a Withdrawn history without controls", async () => {
    await show(<StaffAttendance employee={both} entries={[]} serverNow={now} current={none()} />);
    const table = screen.getByRole("table", { name: "Your external interviews" });
    expect(within(table).queryByText("Mistake Corp")).not.toBeInTheDocument();
    const history = screen.getByRole("list", { name: "Withdrawn (history)" });
    const item = within(history).getByRole("listitem");
    expect(item).toHaveTextContent("Withdrawn");
    expect(item).toHaveTextContent("Mistake Corp");
    expect(within(item).queryByRole("button")).not.toBeInTheDocument();
    expect(within(item).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says there are no active interviews when every entry is withdrawn", async () => {
    await show(<StaffAttendance employee={{ ...employee, interviews: [gone] }} entries={[]} serverNow={now} current={none()} />);
    expect(screen.getByText("You have no active external interviews.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your external interviews" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Withdrawn (history)" })).toBeInTheDocument();
  });
});

describe("StaffAttendance completed training (Story 3.1)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  const older = { id: "t-old", name: "Secure coding basics", provider: "External Academy (fictional)", progress: 100, date: "2025-11-03", result: "Completed · certificate issued" };
  // As training-store returns them: stored completed entries, newest completion first.
  const trained = { ...employee, training: [employee.training[0], older] };

  it("lists every completed entry with programme, provider, completion date (D MMM YYYY) and result", async () => {
    const { container } = await show(<StaffAttendance employee={trained} entries={[]} serverNow={now} current={pending()} />);
    expect(screen.getByRole("heading", { name: "Completed training" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Your completed training" });
    expect(within(table).getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Programme", "Provider", "Completed", "Result"]);
    const rows = within(table).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell").map(c => c.textContent));
    expect(rows).toEqual([
      [employee.training[0].name, "BS23 Learning & Development", "20 Aug 2026", "Completed · assessment passed"],
      ["Secure coding basics", "External Academy (fictional)", "3 Nov 2025", "Completed · certificate issued"],
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when there is no completed training", async () => {
    const { container } = await show(<StaffAttendance employee={{ ...employee, training: [] }} entries={[]} serverNow={now} current={none()} />);
    expect(await screen.findByText("No current enrolments.")).toBeInTheDocument();
    expect(screen.getByText("You have no completed training on record yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your completed training" })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("StaffAttendance current enrolments (Story 3.2)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  const inProgress: TrainingEntry = { id: "lms-p", employeeId: employee.id, name: "Cloud fundamentals", provider: "BS23 Learning & Development", progress: 60, date: "2026-12-01", result: "In progress" };
  const lmsDone: TrainingEntry = { id: "lms-c", employeeId: employee.id, name: "Secure coding basics", provider: "External Academy (fictional)", progress: 100, date: "2026-09-15", result: "Passed" };
  const stored = { ...employee, training: [employee.training[0]] };
  const currentSection = () => screen.getByRole("region", { name: "Current enrolments" });
  const completedSection = () => screen.getByRole("region", { name: "Completed training" });

  it("lists in-progress enrolments with programme, provider, progress and target date (fresh: no stale label)", async () => {
    const { container } = await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={ok({ inProgress: [inProgress] })} />);
    const table = await screen.findByRole("table", { name: "Your current enrolments" });
    expect(within(table).getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Programme", "Provider", "Progress", "Target date"]);
    const rows = within(table).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell").map(c => c.textContent));
    expect(rows).toEqual([["Cloud fundamentals", "BS23 Learning & Development", "60%", "1 Dec 2026"]]);
    expect(within(table).getByRole("progressbar", { name: "Cloud fundamentals progress" })).toHaveAttribute("value", "60");
    expect(within(currentSection()).queryByText("Stale")).not.toBeInTheDocument();
    // Separate from history: not in the completed table.
    expect(within(screen.getByRole("table", { name: "Your completed training" })).queryByText("Cloud fundamentals")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows a loading status in Current while the LMS is pending, with history already rendered", async () => {
    const { container } = await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={pending()} />);
    expect(within(currentSection()).getByRole("status")).toHaveTextContent("Loading current enrolments…");
    expect(within(screen.getByRole("table", { name: "Your completed training" })).getByText(employee.training[0].name)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("marks stale data with a Stale label and the as-of time (Asia/Dhaka)", async () => {
    const { container } = await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={ok({ inProgress: [inProgress], stale: true, asOf: "2026-09-26T03:30:00.000Z" })} />);
    await screen.findByRole("table", { name: "Your current enrolments" });
    expect(within(currentSection()).getByText("Stale")).toBeVisible();
    expect(within(currentSection()).getByText("as of 26 Sep 2026, 09:30")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an unavailable alert in Current when the LMS is unreachable, and history still shows", async () => {
    const { container } = await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={Promise.resolve({ status: "unavailable" })} />);
    expect(await within(currentSection()).findByRole("alert")).toHaveTextContent(/^Current enrolments are unavailable right now/);
    expect(screen.queryByRole("table", { name: "Your current enrolments" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Your completed training" })).getByText(employee.training[0].name)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says there are no current enrolments when the LMS has none", async () => {
    await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={none()} />);
    expect(await within(currentSection()).findByText("No current enrolments.")).toBeInTheDocument();
    expect(within(currentSection()).queryByText("Stale")).not.toBeInTheDocument();
  });

  it("appends LMS-completed courses to history (not Current) when they arrive", async () => {
    const { container } = await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={ok({ inProgress: [inProgress], lmsCompleted: [lmsDone] })} />);
    const table = await within(completedSection()).findByText("Secure coding basics");
    expect(table).toBeInTheDocument();
    const rows = within(screen.getByRole("table", { name: "Your completed training" })).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell").map(c => c.textContent));
    expect(rows).toEqual([
      [employee.training[0].name, "BS23 Learning & Development", "20 Aug 2026", "Completed · assessment passed"],
      ["Secure coding basics", "External Academy (fictional)", "15 Sep 2026", "Passed"],
    ]);
    expect(within(currentSection()).queryByText("Secure coding basics")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows only the employee's own entries, even if handed someone else's", async () => {
    const other = { ...inProgress, id: "lms-x", employeeId: "BS-1002", name: "Someone else's course" };
    await show(<StaffAttendance employee={stored} entries={[]} serverNow={now} current={ok({ inProgress: [other], lmsCompleted: [{ ...lmsDone, employeeId: "BS-1002" }] })} />);
    expect(await within(currentSection()).findByText("No current enrolments.")).toBeInTheDocument();
    expect(screen.queryByText("Someone else's course")).not.toBeInTheDocument();
    expect(screen.queryByText("Secure coding basics")).not.toBeInTheDocument();
  });
});

describe("StaffAttendance My assignments (Story 4.6)", () => {
  type Assignment = (typeof employee)["assignments"][number];
  type Evaluation = (typeof employee)["evaluations"][number];
  const openOne: Assignment = {
    id: "5e000000-0000-4000-8000-000000000001", employeeId: employee.id, departmentId: "d-1", client: "Northwind (fictional)",
    projectName: "Portal rebuild", role: "Developer", allocation: 60, startDate: "2026-10-01", latestUpdate: "Sprint two under way.",
    status: "open", completionDate: null, createdAt: "2026-10-01T00:00:00Z", closedAt: null, provenance: "assignment",
  };
  const evaluated: Assignment = {
    ...openOne, id: "5e000000-0000-4000-8000-000000000002", projectName: "Legacy migration", client: "Harbour Systems (fictional)",
    status: "closed", startDate: "2026-03-01", completionDate: "2026-08-31", closedAt: "2026-09-01T00:00:00Z", latestUpdate: "",
  };
  const notEvaluated: Assignment = { ...evaluated, id: "5e000000-0000-4000-8000-000000000003", projectName: "Data audit", completionDate: "2026-02-28", startDate: "2026-01-10" };
  const evaluation: Evaluation = {
    id: "e-1", assignmentId: evaluated.id, employeeId: employee.id, departmentId: "d-1", evaluation: "Delivered the migration on time.",
    clientFeedback: "The client praised the hand-over.", createdBy: "u-mgr", createdByName: "Arif Hasan", createdByRole: "manager",
    createdAt: "2026-10-16T04:00:00Z", authoredBy: "u-admin", authoredByName: null, authoredByRole: "admin",
    updatedAt: "2026-10-17T04:00:00Z",
  };
  const withWork = { ...employee, assignments: [openOne, evaluated, notEvaluated], evaluations: [evaluation] };
  const section = () => screen.getByRole("heading", { name: "My assignments" }).closest("section")!;

  it("lists the open assignment and history with text labels and D MMM YYYY dates", async () => {
    await show(<StaffAttendance employee={withWork} entries={[]} serverNow={now} current={none()} />);
    const items = within(within(section()).getByRole("list", { name: "Your assignments" })).getAllByRole("listitem");
    expect(items.map(i => within(i).getByRole("heading", { level: 3 }).textContent)).toEqual(["Portal rebuild", "Legacy migration", "Data audit"]);
    expect(within(items[0]).getByText("Open")).toBeInTheDocument();
    expect(within(items[0]).getByText("Since 1 Oct 2026")).toBeInTheDocument();
    expect(within(items[1]).getByText("Closed")).toBeInTheDocument();
    expect(within(items[1]).getByText("1 Mar 2026 – 31 Aug 2026")).toBeInTheDocument();
    // The open assignment has no evaluation area.
    expect(within(items[0]).queryByText("Not evaluated yet.")).not.toBeInTheDocument();
  });

  it("shows each closed assignment's evaluation and client feedback, or that it is not evaluated yet", async () => {
    await show(<StaffAttendance employee={withWork} entries={[]} serverNow={now} current={none()} />);
    const items = within(section()).getAllByRole("listitem");
    // Each evaluation region is named after its project, so several in one history are distinguishable.
    expect(within(items[1]).getByRole("region", { name: "Evaluation of Legacy migration" })).toBeInTheDocument();
    expect(within(items[1]).getByText("Delivered the migration on time.")).toBeInTheDocument();
    expect(within(items[1]).getByText("The client praised the hand-over.")).toBeInTheDocument();
    // The same stored-snapshot text as the management portal.
    expect(within(items[1]).getByText("Written by Arif Hasan on 16 Oct 2026 · amended by the Administrator on 17 Oct 2026")).toBeInTheDocument();
    expect(within(items[1]).queryByText(/u-mgr/)).not.toBeInTheDocument();
    expect(within(items[2]).getByText("Not evaluated yet.")).toBeInTheDocument();
  });

  it("is read-only for assignments: no input, textarea, button or form on any assignment", async () => {
    // Story 4.7 adds the past-project form to the section; the assignments themselves stay read-only.
    const { container } = await show(<StaffAttendance employee={withWork} entries={[]} serverNow={now} current={none()} departmentOptions={[]} />);
    const area = within(section()).getByRole("list", { name: "Your assignments" });
    expect(area.querySelectorAll("input, textarea, button, select, form, details")).toHaveLength(0);
    expect(within(area).queryByRole("button")).not.toBeInTheDocument();
    expect(within(area).queryByRole("textbox")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("marks each assignment Manager-created", async () => {
    await show(<StaffAttendance employee={withWork} entries={[]} serverNow={now} current={none()} />);
    const items = within(within(section()).getByRole("list", { name: "Your assignments" })).getAllByRole("listitem");
    for (const item of items) expect(within(item).getByText("Manager-created")).toBeInTheDocument();
  });

  it("says when no assignment has been recorded", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
    expect(within(section()).getByText("No assignments have been recorded for you yet.")).toBeInTheDocument();
  });
});

describe("StaffAttendance past projects (Story 4.7)", () => {
  type Past = (typeof employee)["backfilledProjects"][number];
  const CRD = "de9a0000-0000-4000-8000-000000000002";
  const LND = "de9a0000-0000-4000-8000-000000000001";
  const options = [{ id: CRD, name: "Central R&D" }, { id: LND, name: "L&D" }];
  const active: Past = {
    id: "bf000000-0000-4000-8000-000000000001", employeeId: employee.id, departmentId: LND, departmentName: "L&D", client: "Old Bank (fictional)",
    projectName: "Core banking audit", completionDate: "2025-12-15", outcome: "Delivered the audit report.", status: "active",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", withdrawnAt: null, provenance: "backfilled",
  };
  const withdrawn: Past = {
    ...active, id: "bf000000-0000-4000-8000-000000000002", projectName: "Abandoned pilot", completionDate: "2024-05-01",
    status: "withdrawn", withdrawnAt: "2026-09-02T00:00:00Z",
  };
  const withPast = { ...employee, backfilledProjects: [active, withdrawn] };
  const section = () => screen.getByRole("heading", { name: "My assignments" }).closest("section")!;
  const pastList = () => within(section()).getByRole("list", { name: "Past projects you added" });
  const addForm = () => within(section()).getByRole("form", { name: "Add a past project" });

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("lists the employee's past projects under My assignments with the department name, Self-reported, and D MMM YYYY", async () => {
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const items = within(pastList()).getAllByRole("listitem");
    expect(items.map(i => within(i).getByRole("heading", { level: 4 }).textContent)).toEqual(["Core banking audit", "Abandoned pilot"]);
    expect(within(items[0]).getByText("Self-reported")).toBeInTheDocument();
    expect(within(items[0]).getByText("Old Bank (fictional) · L&D")).toBeInTheDocument();
    expect(within(items[0]).getByText("Completed 15 Dec 2025")).toBeInTheDocument();
    expect(within(items[0]).getByText("Delivered the audit report.", { selector: ".callout" })).toBeInTheDocument();
    expect(within(items[0]).queryByText("Withdrawn")).not.toBeInTheDocument();
  });

  it("keeps a withdrawn entry listed with a Withdrawn label and no controls; an active one has edit and withdraw", async () => {
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const [first, second] = within(pastList()).getAllByRole("listitem");
    expect(within(second).getByText("Withdrawn")).toBeInTheDocument();
    expect(within(second).getByText("Self-reported")).toBeInTheDocument();
    expect(second.querySelectorAll("input, textarea, button, select, form, details")).toHaveLength(0);
    expect(within(first).getByText("Edit")).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "Withdraw past project: Core banking audit, 15 Dec 2025" })).toBeInTheDocument();
  });

  it("adds a past project by keyboard: the department comes from the list, and the owner is never sent", async () => {
    addBackfillAction.mockResolvedValue({ error: "", message: "Past project added." });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const form = addForm();
    const select = within(form).getByLabelText("Department");
    expect(within(select).getAllByRole("option").map(o => o.textContent)).toEqual(["Choose a department", "Central R&D", "L&D"]);
    await user.selectOptions(select, CRD);
    await user.type(within(form).getByLabelText("Client"), "Old Bank (fictional)");
    await user.type(within(form).getByLabelText("Project name"), "Core banking audit");
    await user.type(within(form).getByLabelText("Completion date"), "2025-12-15");
    await user.type(within(form).getByLabelText("Outcome"), "Delivered the audit report.");
    expect(within(form).getByLabelText("Completion date")).toHaveAttribute("max", "2026-09-28");
    await user.click(within(form).getByRole("button", { name: "Add past project" }));
    expect(addBackfillAction).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries((addBackfillAction.mock.calls[0][1] as FormData).entries())).toEqual({
      departmentId: CRD, client: "Old Bank (fictional)", projectName: "Core banking audit", completionDate: "2025-12-15",
      outcome: "Delivered the audit report.",
    });
    expect(await within(section()).findByText("Past project added.")).toBeInTheDocument();
  });

  it("keeps what was typed when the add is refused", async () => {
    addBackfillAction.mockResolvedValue({ error: "The completion date can't be in the future.", message: "" });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    await user.selectOptions(within(addForm()).getByLabelText("Department"), LND);
    await user.type(within(addForm()).getByLabelText("Client"), "Kept client");
    await user.type(within(addForm()).getByLabelText("Project name"), "Kept project");
    await user.type(within(addForm()).getByLabelText("Completion date"), "2025-01-01");
    await user.type(within(addForm()).getByLabelText("Outcome"), "Kept outcome");
    await user.click(within(addForm()).getByRole("button", { name: "Add past project" }));
    expect(await within(addForm()).findByRole("alert")).toHaveTextContent("The completion date can't be in the future.");
    expect(within(addForm()).getByLabelText("Department")).toHaveValue(LND);
    expect(within(addForm()).getByLabelText("Client")).toHaveValue("Kept client");
    expect(within(addForm()).getByLabelText("Project name")).toHaveValue("Kept project");
    expect(within(addForm()).getByLabelText("Completion date")).toHaveValue("2025-01-01");
    expect(within(addForm()).getByLabelText("Outcome")).toHaveValue("Kept outcome");
  });

  it("edits an active entry, prefilled, and keeps the typed values on a refusal", async () => {
    editBackfillAction.mockResolvedValueOnce({ error: "Choose a department from the list.", message: "" });
    editBackfillAction.mockResolvedValueOnce({ error: "", message: "Past project updated." });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const [first] = within(pastList()).getAllByRole("listitem");
    await user.click(within(first).getByText("Edit"));
    const form = within(first).getByRole("form", { name: "Edit past project: Core banking audit, 15 Dec 2025" });
    expect(within(form).getByLabelText(/^Department/)).toHaveValue(LND);
    expect(within(form).getByLabelText(/^Client/)).toHaveValue("Old Bank (fictional)");
    expect(within(form).getByLabelText(/^Outcome/)).toHaveValue("Delivered the audit report.");
    const outcome = within(form).getByLabelText(/^Outcome/);
    await user.clear(outcome);
    await user.type(outcome, "Revised outcome.");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(Object.fromEntries((editBackfillAction.mock.calls[0][1] as FormData).entries())).toEqual({
      id: active.id, departmentId: LND, client: "Old Bank (fictional)", projectName: "Core banking audit", completionDate: "2025-12-15",
      outcome: "Revised outcome.",
    });
    expect(await within(first).findByRole("alert")).toHaveTextContent("Choose a department from the list.");
    expect(within(first).getByLabelText(/^Outcome/)).toHaveValue("Revised outcome.");
    await user.click(within(first).getByRole("button", { name: "Save changes" }));
    expect(await within(first).findByText("Past project updated.")).toBeInTheDocument();
  });

  it("withdraws an active entry through the withdraw action, naming only the entry; the message is next to it", async () => {
    withdrawBackfillAction.mockResolvedValue({ error: "", message: "Past project withdrawn." });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const [first] = within(pastList()).getAllByRole("listitem");
    // The withdraw control is shown on the entry, outside the Edit <details>.
    const withdraw = within(first).getByRole("button", { name: "Withdraw past project: Core banking audit, 15 Dec 2025" });
    expect(withdraw.closest("details")).toBeNull();
    await user.click(withdraw);
    expect(Object.fromEntries((withdrawBackfillAction.mock.calls[0][1] as FormData).entries())).toEqual({ id: active.id });
    expect(await within(first).findByText("Past project withdrawn.")).toBeInTheDocument();
  });

  it("withdrawing one entry leaves the other entries' controls enabled", async () => {
    withdrawBackfillAction.mockReturnValue(new Promise(() => {}));
    const second: Past = { ...active, id: "bf000000-0000-4000-8000-000000000003", projectName: "Mobile wallet", completionDate: "2025-11-01" };
    const user = userEvent.setup({ advanceTimers: () => {} });
    await show(<StaffAttendance employee={{ ...employee, backfilledProjects: [active, second] }} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    const [first, other] = within(pastList()).getAllByRole("listitem");
    await user.click(within(first).getByRole("button", { name: /^Withdraw past project: Core banking audit/ }));
    expect(await within(first).findByRole("button", { name: /^Withdraw past project: Core banking audit/ })).toBeDisabled();
    expect(within(other).getByRole("button", { name: /^Withdraw past project: Mobile wallet/ })).toBeEnabled();
    await user.click(within(other).getByText("Edit"));
    expect(within(other).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("shows the stored department name even when the department list is unavailable", async () => {
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={null} />);
    const [first] = within(pastList()).getAllByRole("listitem");
    expect(within(first).getByText("Old Bank (fictional) · L&D")).toBeInTheDocument();
  });

  it("says no departments are listed yet, with no add form or select, when the list is empty", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} departmentOptions={[]} />);
    expect(within(section()).getByText("No departments are listed yet, so past projects can't be added.")).toBeInTheDocument();
    expect(within(section()).queryByRole("form", { name: "Add a past project" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("says the department list is unavailable rather than offering an empty select", async () => {
    await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={null} />);
    expect(within(section()).queryByRole("form", { name: "Add a past project" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(section()).getAllByText(/department list is unavailable/).length).toBeGreaterThan(0);
    // The entries themselves are still listed.
    expect(within(pastList()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says when no past project has been added", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    expect(within(section()).getByText("You have not added any past projects yet.")).toBeInTheDocument();
  });

  it("has no detectable accessibility violations with past projects and the add form", async () => {
    const { container } = await show(<StaffAttendance employee={withPast} entries={[]} serverNow={now} current={none()} departmentOptions={options} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("StaffAttendance skills and evaluation (Story 7.4: read-only)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });
  const section = () => screen.getByRole("region", { name: "Skills & evaluation" });

  it("shows the employee's own skills and evaluation, with the reviewer and D MMM YYYY date", async () => {
    const { container } = await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
    const view = within(section());
    for (const skill of employee.skills) expect(view.getByText(skill.name)).toBeInTheDocument();
    expect(view.getAllByRole("img", { name: /out of 5$/ })).toHaveLength(employee.skills.length);
    expect(view.getByText(`14 Sep 2026 · ${employee.review.reviewer}`)).toBeInTheDocument();
    expect(view.getByText(employee.review.strengths)).toBeInTheDocument();
    expect(view.getByText(employee.review.next)).toBeInTheDocument();
    expect(view.getByText(employee.review.readiness)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers no form to change skills or the evaluation", async () => {
    await show(<StaffAttendance employee={employee} entries={[]} serverNow={now} current={none()} />);
    expect(screen.queryByRole("form", { name: "Rate a skill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit evaluation" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the empty states when nothing is recorded yet", async () => {
    const bare = { ...employee, skills: [], review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" } };
    await show(<StaffAttendance employee={bare} entries={[]} serverNow={now} current={none()} />);
    expect(within(section()).getByText("No skills assessed yet.")).toBeInTheDocument();
    expect(within(section()).getByText("No evaluation recorded yet.")).toBeInTheDocument();
    expect(within(section()).queryByText(/Not recorded/)).not.toBeInTheDocument();
  });
});

describe("StaffSelfService (Story 4.10)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders the self-service body without the page shell: no brand header and no Sign out button", async () => {
    const { container } = await show(<StaffSelfService employee={employee} entries={[]} serverNow={now} current={none()} departmentOptions={[]} />);
    expect(screen.getByRole("button", { name: "Clock in" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today's work log" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My assignments" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current enrolments" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "External interviews" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add interview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(container.querySelector(".staff-header")).toBeNull();
    expect(container.querySelector("main")).toBeNull();
  });

  it("is exactly what the staff portal renders inside its shell", async () => {
    const shell = await show(<StaffAttendance employee={employee} entries={[open]} serverNow={now} current={none()} />);
    const inner = shell.container.querySelector(".staff-content")!.outerHTML;
    shell.unmount();
    const body = await show(<StaffSelfService employee={employee} entries={[open]} serverNow={now} current={none()} />);
    expect(body.container.innerHTML).toBe(inner);
  });
});
