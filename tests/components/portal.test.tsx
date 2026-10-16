// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("@/server/auth", () => ({
  signOut: () => {},
}));
vi.mock("@/server/account-actions", () => ({
  provisionStaffAccountAction: vi.fn(async () => ({ error: "", message: "" })),
  archiveEmployeeAction: vi.fn(async () => ({ error: "", message: "" })),
  restoreEmployeeAction: vi.fn(async () => ({ error: "", message: "" })),
}));
vi.mock("@/server/department-actions", () => ({
  createDepartmentAction: vi.fn(async () => ({ error: "", message: "" })),
  updateDepartmentAction: vi.fn(async () => ({ error: "", message: "" })),
  setDepartmentManagerAction: vi.fn(async () => ({ error: "", message: "" })),
}));
vi.mock("@/server/assignment-actions", () => ({
  createAssignmentAction: vi.fn(async () => ({ error: "", message: "Assignment created." })),
  updateAssignmentNoteAction: vi.fn(async () => ({ error: "", message: "Latest update saved." })),
  closeAssignmentAction: vi.fn(async () => ({ error: "", message: "Assignment closed." })),
}));
vi.mock("@/server/assignment-evaluation-actions", () => ({
  createEvaluationAction: vi.fn(async () => ({ error: "", message: "Evaluation saved." })),
  amendEvaluationAction: vi.fn(async () => ({ error: "", message: "Evaluation updated." })),
}));
vi.mock("@/server/activity-actions", () => ({
  exportActivityAction: vi.fn(async () => ({ error: "", message: "" })),
  exportAllActivityAction: vi.fn(async () => ({ error: "", message: "" })),
}));

import Portal from "@/components/portal";
import { employees, type Assignment, type AssignmentEvaluation, type BackfilledProject } from "@/data/employees";
import { closeAssignmentAction, createAssignmentAction, updateAssignmentNoteAction } from "@/server/assignment-actions";
import { amendEvaluationAction, createEvaluationAction } from "@/server/assignment-evaluation-actions";
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

describe("Portal directory", () => {
  it("shows every employee by default", async () => {
    await show(<Portal employees={employees} current={none()} />);
    expect(screen.getAllByRole("row")).toHaveLength(employees.length + 1);
  });

  it("filters by a skill in the search box", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.type(screen.getByRole("textbox", { name: "Search employees" }), "TypeScript");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Nadia Rahman")).toBeInTheDocument();
  });

  it("shows an empty state when no employee matches the filters", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.type(screen.getByRole("textbox", { name: "Search employees" }), "no such employee");
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.selectOptions(screen.getByLabelText("Filter by status"), "In training");
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("shows Reset only once a filter is active, and Reset clears it", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by status"), "Available");
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(employees.length + 1);
  });

  it("has no detectable accessibility violations in the directory view", async () => {
    const { container } = await show(<Portal employees={employees} current={none()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Portal directory export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("exports only the currently visible rows and reports the count", async () => {
    // jsdom's Blob lacks .text()/createObjectURL; capture the CSV text at construction time instead.
    let csvText: string | undefined;
    class InspectableBlob extends Blob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        csvText = parts.join("");
      }
    }
    vi.stubGlobal("Blob", InspectableBlob);
    const createObjectURL = vi.fn(() => "blob:mock-url");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.type(screen.getByRole("textbox", { name: "Search employees" }), "TypeScript");
    await user.click(screen.getByRole("button", { name: /export directory/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(csvText).toContain("Nadia Rahman");
    expect(csvText).not.toContain("Arif Hasan");
    expect(await screen.findByRole("status")).toHaveTextContent("Exported 1 demo employee records.");
  });
});

describe("Portal employee profile", () => {
  it("opens a profile and renders every tab, including an employee with no interviews", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Meera Das" })).toBeInTheDocument();

    for (const tab of ["Employment", "Training", "Skills & evaluation", "Current work", "Interviews", "Attendance", "Overview"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tabpanel")).toBeVisible();
    }

    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("has no detectable accessibility violations on an open profile", async () => {
    const user = userEvent.setup();
    const { container } = await show(<Portal employees={employees} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("returns to the directory from a profile", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("button", { name: /back to/i }));
    expect(screen.queryByRole("heading", { name: "Nadia Rahman" })).not.toBeInTheDocument();
  });

  it("shows the Staff account form on the Overview tab for an employee without an account", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees.map(e => ({ ...e, hasAccount: false }))} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Sign-in account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Initial password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Create Staff account" })).toBeInTheDocument();
  });

  it("offers Download activity on the Overview tab of an employee's profile", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Download activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download activity" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Period" })).toBeInTheDocument();
  });

  it("offers Download activity (all employees) on the directory, below the directory panel", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    expect(screen.queryByRole("heading", { name: "Download activity (all employees)" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("button", { name: /Employees/ }));
    const heading = screen.getByRole("heading", { name: "Download activity (all employees)" });
    expect(screen.getByRole("heading", { name: /Employee directory/ }).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Include archived" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download activity (all employees)" })).toBeInTheDocument();
  });

  it("shows that an employee already has an account, with no form", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees.map(e => ({ ...e, hasAccount: e.id === "BS-1003" }))} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByText("Has a sign-in account")).toBeInTheDocument();
    expect(screen.queryByLabelText("Initial password")).not.toBeInTheDocument();
  });

  it("opens the profile of an employee with no fixture profile data (empty dates) without crashing", async () => {
    const user = userEvent.setup();
    const bare = {
      ...employees[0], id: "BS-9801", name: "Bare Employee", skills: [], history: [], training: [], interviews: [],
      assignments: [],
      attendance: { scheduled: 0, worked: 0, leave: 0, unrecorded: 0, records: [] },
      review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" }, hasAccount: false,
    };
    await show(<Portal employees={[...employees, bare]} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Bare Employee's profile" }));
    expect(screen.getByRole("heading", { name: "Bare Employee" })).toBeInTheDocument();
    expect(screen.getByText(/Reviewed Not recorded/)).toBeInTheDocument();
    expect(screen.getByLabelText("Initial password")).toBeInTheDocument();
  });
});

describe("Portal departments (Story 4.1)", () => {
  const LND = "de9a0000-0000-4000-8000-000000000001";
  const CRD = "de9a0000-0000-4000-8000-000000000002";
  const departments = [{ id: CRD, name: "Central R&D", parentId: LND, managerUserId: null, managerEmployeeId: null }, { id: LND, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null }];
  const placed = employees.map(e => ({ ...e, hasAccount: false, archived: false, departmentId: e.id === "BS-1008" ? null : CRD }));

  it("shows each employee's department in the directory, and \"No department\" when unset", async () => {
    await show(<Portal employees={placed} departments={departments} current={none()} />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Department" })).toBeInTheDocument();
    const nadia = within(table).getByText("Nadia Rahman").closest("tr")!;
    expect(nadia).toHaveTextContent("Central R&D");
    const fahim = within(table).getByText("Fahim Noor").closest("tr")!;
    expect(fahim).toHaveTextContent("No department");
  });

  it("shows \"No department\" when the department id is not in the list", async () => {
    await show(<Portal employees={placed.map(e => ({ ...e, departmentId: "de9a0000-0000-4000-8000-0000000000ff" }))} departments={departments} current={none()} />);
    expect(within(screen.getByRole("table")).getAllByText("No department")).toHaveLength(employees.length);
  });

  it("has a Departments section listing the departments with no delete control", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={placed} departments={departments} current={none()} />);
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Departments" }));
    expect(screen.getByRole("heading", { name: "Departments", level: 1 })).toBeInTheDocument();
    const list = screen.getByRole("table", { name: "Departments" });
    const cells = within(list).getAllByRole("row").slice(1).map(r => [...(r as HTMLTableRowElement).cells].slice(0, 2).map(c => c.textContent));
    expect(cells).toEqual([["Central R&D", "L&D"], ["L&D", "Top level"]]);
    expect(screen.getByRole("button", { name: "Add department" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("does not add a Department column to the CSV export", async () => {
    let csvText = "";
    class InspectableBlob extends Blob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        csvText = parts.join("");
      }
    }
    vi.stubGlobal("Blob", InspectableBlob);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    await show(<Portal employees={placed} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: /Export directory/ }));
    expect(csvText.split(/\r?\n/)[0]).toBe('"Employee ID","Name","Designation","Team","Status","Email"');
    expect(csvText).not.toContain("Central R&D");
    vi.restoreAllMocks();
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    vi.unstubAllGlobals();
  });
});

describe("Portal archived employees (Story 1.4)", () => {
  // Meera Das (In training) and Tanvir Alam (In training) are archived.
  const withArchived = employees.map(e => ({ ...e, hasAccount: false, archived: e.id === "BS-1003" || e.id === "BS-1006" }));
  const active = withArchived.filter(e => !e.archived);

  it("hides archived employees from the default directory, the counts and the Overview stats", async () => {
    await show(<Portal employees={withArchived} current={none()} />);
    expect(screen.getAllByRole("row")).toHaveLength(active.length + 1);
    expect(screen.queryByText("Meera Das")).not.toBeInTheDocument();
    expect(screen.getByText(`Showing ${active.length} of ${active.length} employees`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: `Employee directory ${active.length}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Employees ${active.length}` })).toBeInTheDocument();
    const total = screen.getByText("Total employees").closest("article")!;
    expect(total).toHaveTextContent(String(active.length).padStart(2, "0"));
  });

  it("lists only archived employees under \"Archived employees\", and Reset returns to active ones", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withArchived} current={none()} />);
    await user.selectOptions(screen.getByLabelText("Show employees"), "Archived employees");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Meera Das")).toBeInTheDocument();
    expect(screen.getByText("Tanvir Alam")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2 archived employees", { exact: false })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by status"), "In training");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Show employees")).toHaveValue("Active employees");
    expect(screen.getAllByRole("row")).toHaveLength(active.length + 1);
  });

  it("labels an archived employee's profile \"Archived\" in text and offers Restore", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withArchived} current={none()} />);
    await user.selectOptions(screen.getByLabelText("Show employees"), "Archived employees");
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Meera Das" })).toBeInTheDocument();
    expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(2); // header and Account access panel
    expect(screen.getByRole("heading", { name: "Account access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore employee" })).toBeInTheDocument();
  });

  it("leaves archived employees out of the Learning, Attendance and radar views", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withArchived} current={none()} />);
    const learning = screen.getByText("Learning in progress").closest("article")!;
    const activeLearning = active.flatMap(e => e.training).filter(t => t.progress < 100).length;
    expect(learning).toHaveTextContent(String(activeLearning).padStart(2, "0"));
    expect(screen.queryByRole("button", { name: /Meera's learning check-in/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nadia's technical interview/ })).toBeInTheDocument();
    for (const section of ["Learning & development", "Attendance & leave"]) {
      await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: section }));
      expect(screen.queryByText("Meera Das")).not.toBeInTheDocument();
      expect(screen.queryByText("Tanvir Alam")).not.toBeInTheDocument();
    }
  });

  it("offers Archive on an active employee's profile, with no Archived label", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withArchived} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    expect(screen.getByRole("button", { name: "Archive employee" })).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });
});

describe("Portal external interviews", () => {
  const added = { id: "7d2f3c1a-0000-4000-8000-000000000001", company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "", feedback: "", withdrawn: false };
  // Two interviews at the same company would have collided on the old company-based keys.
  const withNew = employees.map(e => (e.id === "BS-1003" ? { ...e, interviews: [added, { ...added, id: "7d2f3c1a-0000-4000-8000-000000000002", date: "2026-10-01" }] } : e));

  it("shows a staff-added interview in the profile Interviews tab, with a text label for an empty outcome", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const user = userEvent.setup();
    await show(<Portal employees={withNew} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("heading", { name: "Orbit Analytics" })).toHaveLength(2);
    expect(within(panel).getAllByText("No outcome yet")).toHaveLength(2);
    expect(within(panel).getByText("20 Oct 2026 · Recruiter screen")).toBeInTheDocument();
    expect(errorSpy.mock.calls.map(args => args.map(String).join(" ")).filter(m => m.includes("same key"))).toEqual([]);
    errorSpy.mockRestore();
  });

  it("lists it in Interviews & placements next to the existing interviews", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withNew} current={none()} />);
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Interviews & placements" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(employees.flatMap(e => e.interviews).length + 2);
    const meera = rows.filter(r => within(r).queryByText("Meera Das"));
    expect(meera).toHaveLength(2);
    expect(within(meera[0]).getByText("Orbit Analytics")).toBeInTheDocument();
    expect(within(meera[0]).getByText("20 Oct 2026")).toBeInTheDocument();
    expect(within(meera[0]).getByText("No outcome yet")).toBeInTheDocument();
  });

  it("shows interview dates as D MMM YYYY", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={employees} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    expect(screen.getByText("23 Sep 2026 · Technical interview")).toBeInTheDocument();
  });
});

describe("Portal withdrawn interviews (Story 2.2)", () => {
  // Nadia's fixture interview (Northstar, "Scheduled") is withdrawn; a corrected entry was added afterwards.
  const nadia = employees[0];
  const withdrawnOne = { ...nadia.interviews[0], withdrawn: true };
  const corrected = { ...nadia.interviews[0], id: "7d2f3c1a-0000-4000-8000-0000000000aa", company: "Northstar Labs Ltd (fictional)", outcome: "Awaiting feedback", withdrawn: false };
  const withWithdrawn = employees.map(e => (e.id === nadia.id ? { ...e, interviews: [corrected, withdrawnOne] } : e));
  const onlyWithdrawn = employees.map(e => (e.id === nadia.id ? { ...e, interviews: [withdrawnOne] } : e));

  const upcoming = () => screen.getByText("Upcoming interviews").closest("article")!.querySelector("strong")!.textContent;

  it("leaves a withdrawn entry out of the Upcoming interviews stat", async () => {
    const { unmount } = await show(<Portal employees={employees} current={none()} />);
    expect(upcoming()).toBe("01");
    unmount();
    await show(<Portal employees={onlyWithdrawn} current={none()} />);
    expect(upcoming()).toBe("00");
  });

  it("leaves a withdrawn entry out of Interviews & placements", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={withWithdrawn} current={none()} />);
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Interviews & placements" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(employees.flatMap(e => e.interviews).length);
    expect(screen.queryByText("Northstar Labs (fictional)")).not.toBeInTheDocument();
    expect(screen.getByText("Northstar Labs Ltd (fictional)")).toBeInTheDocument();
  });

  it("shows the withdrawn entry only in the profile's Withdrawn history, labelled, with no edit controls", async () => {
    const user = userEvent.setup();
    const { container } = await show(<Portal employees={withWithdrawn} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    const panel = screen.getByRole("tabpanel");
    const history = within(panel).getByRole("region", { name: "Withdrawn (history)" });
    expect(within(history).getByRole("heading", { name: "Northstar Labs (fictional)" })).toBeInTheDocument();
    expect(within(history).getByText("Withdrawn")).toBeInTheDocument();
    // The active list holds only the corrected entry.
    const headings = within(panel).getAllByRole("heading", { level: 3 }).map(h => h.textContent);
    expect(headings.filter(h => h === "Northstar Labs Ltd (fictional)")).toHaveLength(1);
    expect(headings.filter(h => h === "Northstar Labs (fictional)")).toHaveLength(1);
    // Administrator is read-only: nothing to edit or withdraw.
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /withdraw|update|edit|save/i })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says there are no active interviews when every entry is withdrawn, and still shows the history", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={onlyWithdrawn} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    expect(screen.getByText("This employee has no active external interviews.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Withdrawn (history)" })).toBeInTheDocument();
  });
});

describe("Portal training views (Stories 3.1 and 3.2: stored history at once, LMS enrolments streamed)", () => {
  // As the app now serves them: stored completed training on the employee, in-progress entries from the LMS.
  const stored = employees.map(e => ({ ...e, training: e.training.filter(t => t.progress === 100) }));
  const lmsInProgress: TrainingEntry[] = employees.flatMap(e => e.training.filter(t => t.progress < 100).map(t => ({ ...t, id: `lms-${t.id}`, employeeId: e.id })));
  const nadia = employees[0];
  const nadiaDone = nadia.training[0];
  const nadiaNow = nadia.training[1];
  const lmsDone: TrainingEntry = { id: "lms-done", employeeId: nadia.id, name: "Secure coding basics", provider: "External Academy (fictional)", progress: 100, date: "2026-09-15", result: "Passed" };
  const fresh = () => ok({ inProgress: lmsInProgress });
  const stat = (label: string) => screen.getByText(label).closest("article")!.querySelector("strong")!.textContent;

  async function openTraining(current: Promise<CurrentTraining>) {
    const user = userEvent.setup();
    const result = await show(<Portal employees={stored} current={current} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Training" }));
    return { ...result, user, panel: screen.getByRole("tabpanel") };
  }
  const region = (panel: HTMLElement, name: string) => within(panel).getByRole("region", { name });

  it("shows the Training tab as before: completed, then the Current block with in-progress entries", async () => {
    const { panel, container } = await openTraining(fresh());
    expect(within(panel).getByRole("heading", { name: "Training & development" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual([nadiaDone.name, nadiaNow.name]);
    const completed = region(panel, "Completed training");
    expect(within(completed).getByText("Completed: 20 Aug 2026")).toBeInTheDocument();
    expect(within(completed).getByText("Completed · assessment passed")).toBeInTheDocument();
    expect(within(completed).getByRole("progressbar", { name: `${nadiaDone.name} completion` })).toHaveAttribute("value", "100");
    const current = region(panel, "Current enrolments");
    expect(within(current).getByText("Target completion: 28 Sep 2026")).toBeInTheDocument();
    expect(within(current).getByText("In progress")).toBeInTheDocument();
    expect(within(current).getByRole("progressbar", { name: `${nadiaNow.name} completion` })).toHaveAttribute("value", String(nadiaNow.progress));
    // Filtered to that employee: no one else's enrolment.
    expect(within(current).getAllByRole("heading", { level: 4 })).toHaveLength(1);
    expect(within(current).queryByText("Stale")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("uses the selected employee's own freshness: no Stale label when only another employee is stale", async () => {
    const { panel } = await openTraining(ok({
      inProgress: lmsInProgress, stale: true, asOf: "2026-09-20T03:30:00.000Z",
      freshness: { [nadia.id]: { asOf: "2026-09-28T05:00:00.000Z", stale: false }, "BS-1002": { asOf: "2026-09-20T03:30:00.000Z", stale: true } },
    }));
    const current = region(panel, "Current enrolments");
    expect(within(current).getByRole("heading", { name: nadiaNow.name })).toBeInTheDocument();
    expect(within(current).queryByText("Stale")).not.toBeInTheDocument();
  });

  it("shows the in-progress programme and its progress in the Overview's Learning journey when the LMS answers", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={stored} current={fresh()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    const journey = screen.getByRole("heading", { name: "Learning journey" }).closest("article")!;
    expect(within(journey).getByText(nadiaDone.name)).toBeInTheDocument();
    expect(within(journey).getByText(nadiaNow.name)).toBeInTheDocument();
    expect(within(journey).getByRole("progressbar", { name: `${nadiaNow.name} completion` })).toHaveAttribute("value", String(nadiaNow.progress));
    expect(within(journey).getByText(`${nadiaNow.progress}%`)).toBeInTheDocument();
  });

  it("shows stored history immediately and a loading status in Current while the LMS is pending", async () => {
    const { panel, container } = await openTraining(pending());
    expect(within(region(panel, "Completed training")).getByRole("heading", { name: nadiaDone.name })).toBeInTheDocument();
    expect(within(region(panel, "Current enrolments")).getByRole("status")).toHaveTextContent("Loading current enrolments…");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("marks stale LMS data with a Stale label and the as-of time", async () => {
    const { panel } = await openTraining(ok({ inProgress: lmsInProgress, stale: true, asOf: "2026-09-26T03:30:00.000Z" }));
    const current = region(panel, "Current enrolments");
    expect(within(current).getByText("Stale")).toBeVisible();
    expect(within(current).getByText("as of 26 Sep 2026, 09:30")).toBeInTheDocument();
    expect(within(current).getByRole("heading", { name: nadiaNow.name })).toBeInTheDocument();
  });

  it("shows an unavailable alert in Current when the LMS is unreachable, and history still shows", async () => {
    const { panel, container } = await openTraining(Promise.resolve({ status: "unavailable" }));
    expect(within(region(panel, "Current enrolments")).getByRole("alert")).toHaveTextContent(/^Current enrolments are unavailable right now/);
    expect(within(region(panel, "Completed training")).getByRole("heading", { name: nadiaDone.name })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says there are no current enrolments when the LMS has none for that employee", async () => {
    const { panel } = await openTraining(none());
    expect(within(region(panel, "Current enrolments")).getByText("No current enrolments.")).toBeInTheDocument();
  });

  it("adds LMS-completed courses to history, not to Current", async () => {
    const { panel } = await openTraining(ok({ inProgress: lmsInProgress, lmsCompleted: [lmsDone] }));
    expect(within(region(panel, "Completed training")).getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual([nadiaDone.name, "Secure coding basics"]);
    expect(within(region(panel, "Current enrolments")).queryByText("Secure coding basics")).not.toBeInTheDocument();
  });

  it("lists every enrolment in Learning & development, with the in-progress figure on the Overview", async () => {
    const user = userEvent.setup();
    const all = employees.flatMap(e => e.training);
    const { container } = await show(<Portal employees={stored} current={fresh()} />);
    expect(stat("Learning in progress")).toBe(String(lmsInProgress.length).padStart(2, "0"));
    expect(screen.getByText(`${all.filter(t => t.progress === 100).length} completed training records`)).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.getByText(`${all.length} enrolments`)).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(all.length);
    const first = rows.filter(r => within(r).queryByText("Nadia Rahman"));
    expect(first.map(r => within(r).getAllByRole("cell")[3].textContent)).toEqual(["20 Aug 2026", "28 Sep 2026"]);
    expect(screen.getByRole("progressbar", { name: `Nadia Rahman: ${nadiaNow.name}` })).toHaveAttribute("value", String(nadiaNow.progress));
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows stored rows at once in Learning & development and the Overview stat as … while the LMS is pending", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={stored} current={pending()} />);
    expect(stat("Learning in progress")).toBe("…");
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading current enrolments…");
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(stored.flatMap(e => e.training).length);
    expect(screen.queryByText(nadiaNow.name)).not.toBeInTheDocument();
  });

  it("says Unavailable on the Overview and alerts in Learning & development when the LMS is unreachable", async () => {
    const user = userEvent.setup();
    const { container } = await show(<Portal employees={stored} current={Promise.resolve({ status: "unavailable" })} />);
    expect(stat("Learning in progress")).toBe("Unavailable");
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/^Current enrolments are unavailable right now/);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(stored.flatMap(e => e.training).length);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("marks stale data in Learning & development and adds LMS-completed rows", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={stored} current={ok({ inProgress: lmsInProgress, lmsCompleted: [lmsDone], stale: true, asOf: "2026-09-26T03:30:00.000Z" })} />);
    expect(screen.getByText("Stale · as of 26 Sep 2026, 09:30")).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.getByText("Stale")).toBeVisible();
    expect(screen.getByText("as of 26 Sep 2026, 09:30")).toBeInTheDocument();
    const nadiaRows = screen.getAllByRole("row").filter(r => within(r).queryByText("Nadia Rahman"));
    expect(nadiaRows.map(r => within(r).getAllByRole("cell")[1].querySelector("strong")!.textContent)).toEqual([nadiaDone.name, "Secure coding basics", nadiaNow.name]);
  });

  it("keys training by id, so two entries with the same programme name render without a key clash", async () => {
    const errorSpy = vi.spyOn(console, "error");
    try {
      const user = userEvent.setup();
      const repeat = { ...nadiaDone, id: "7a1a0000-0000-4000-8000-0000ffff0001", date: "2025-02-10" };
      await show(<Portal employees={stored.map(e => (e.id === nadia.id ? { ...e, training: [...e.training, repeat] } : e))} current={fresh()} />);
      await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
      await user.click(screen.getByRole("tab", { name: "Training" }));
      expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { name: nadiaDone.name })).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: /back to/i }));
      await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
      expect(errorSpy.mock.calls.map(args => args.map(String).join(" ")).filter(m => m.includes("same key"))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("Portal for a department manager (Story 4.2)", () => {
  const own = employees.filter(e => e.id === "BS-1001");

  it("leaves Departments and Interviews & placements out of the navigation", async () => {
    await show(<Portal role="manager" employees={own} current={none()} />);
    const nav = within(screen.getByRole("navigation"));
    expect(nav.queryByRole("button", { name: "Departments" })).not.toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /Interviews & placements/ })).not.toBeInTheDocument();
    for (const name of ["Overview", "Employees", "Learning & development", "Attendance & leave"]) {
      expect(nav.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it("says Department manager in the sidebar identity", async () => {
    await show(<Portal role="manager" employees={own} current={none()} />);
    expect(screen.getByText("Department manager")).toBeInTheDocument();
    expect(screen.queryByText(/L&D administrator/)).not.toBeInTheDocument();
    // Neither the sidebar nor the topbar avatar shows the Administrator's initials.
    expect(screen.queryByText("AK")).not.toBeInTheDocument();
    expect(screen.getAllByText("DM")).toHaveLength(2);
  });

  it("hides the Upcoming interviews stat and the interview radar row on the Overview", async () => {
    await show(<Portal role="manager" employees={own} current={none()} />);
    expect(screen.queryByText("Upcoming interviews")).not.toBeInTheDocument();
    expect(screen.queryByText(/technical interview/)).not.toBeInTheDocument();
    expect(screen.getByText("Total employees")).toBeInTheDocument();
  });

  it("opens a profile without the Interviews tab or the account controls", async () => {
    const user = userEvent.setup();
    await show(<Portal role="manager" employees={own} current={none()} />);
    await user.click(screen.getByRole("button", { name: /View Nadia Rahman's profile/ }));
    const tabs = within(screen.getByRole("tablist", { name: "Employee details" }));
    expect(tabs.queryByRole("tab", { name: "Interviews" })).not.toBeInTheDocument();
    expect(tabs.getByRole("tab", { name: "Training" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign-in account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Account access" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Northstar Labs/)).not.toBeInTheDocument();
  });

  it("keeps everything for the Administrator portal (the default role)", async () => {
    const user = userEvent.setup();
    await show(<Portal employees={own} current={none()} />);
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByRole("button", { name: "Departments" })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: /Interviews & placements/ })).toBeInTheDocument();
    expect(screen.getByText("Upcoming interviews")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /View Nadia Rahman's profile/ }));
    expect(screen.getByRole("tab", { name: "Interviews" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign-in account" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Account access" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = await show(<Portal role="manager" employees={own} current={none()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Portal scoped to a manager's departments (Story 4.3)", () => {
  const PARENT = "de9a0000-0000-4000-8000-0000000000a1";
  const CHILD = "de9a0000-0000-4000-8000-0000000000a2";
  const departments = [
    { id: CHILD, name: "Child Team", parentId: PARENT, managerUserId: null, managerEmployeeId: null },
    { id: PARENT, name: "Parent Team", parentId: null, managerUserId: "u-1", managerEmployeeId: "BS-1001" },
  ];
  // What employees-store returns for a manager: archived and departmentId, never hasAccount.
  const scoped = employees.filter(e => e.id === "BS-1001" || e.id === "BS-1002")
    .map(e => ({ ...e, archived: false, departmentId: e.id === "BS-1001" ? PARENT : CHILD }));

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("lists only the scoped employees in the directory, each with their department name", async () => {
    await show(<Portal role="manager" employees={scoped} departments={departments} current={none()} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(scoped.length + 1);
    expect(within(table).getByText(scoped[0].name).closest("tr")).toHaveTextContent("Parent Team");
    expect(within(table).getByText(scoped[1].name).closest("tr")).toHaveTextContent("Child Team");
    expect(within(table).queryByText("Meera Das")).not.toBeInTheDocument();
  });

  it("replaces the org-wide team note with a neutral department count", async () => {
    await show(<Portal role="manager" employees={scoped} departments={departments} current={none()} />);
    expect(screen.queryByText("Across 5 specialist teams")).not.toBeInTheDocument();
    expect(screen.getByText("Across 2 departments")).toBeInTheDocument();
  });

  it("uses the singular for a manager with a single department", async () => {
    await show(<Portal role="manager" employees={scoped.slice(1)} departments={departments.slice(0, 1)} current={none()} />);
    expect(screen.getByText("Across 1 department")).toBeInTheDocument();
  });

  it("keeps the Administrator's team note", async () => {
    await show(<Portal employees={scoped} departments={departments} current={none()} />);
    expect(screen.getByText("Across 5 specialist teams")).toBeInTheDocument();
  });

  it("shows only scoped employees in Attendance & leave and Learning & development", async () => {
    const user = userEvent.setup();
    await show(<Portal role="manager" employees={scoped} departments={departments} current={none()} />);
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Attendance & leave" }));
    const attendance = screen.getByRole("table");
    expect(within(attendance).getAllByRole("row")).toHaveLength(scoped.length + 1);
    expect(within(attendance).queryByText("Meera Das")).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.queryByText("Meera Das")).not.toBeInTheDocument();
  });

  it("exports only the scoped employees", async () => {
    let csvText = "";
    class InspectableBlob extends Blob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        csvText = parts.join("");
      }
    }
    vi.stubGlobal("Blob", InspectableBlob);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    await show(<Portal role="manager" employees={scoped} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: /Export directory/ }));
    const lines = csvText.trim().split(/\r?\n/);
    expect(lines).toHaveLength(scoped.length + 1);
    for (const e of scoped) expect(csvText).toContain(e.id);
    expect(csvText).not.toContain("Meera Das");
  });
});

describe("Portal Current work tab (Story 4.5)", () => {
  const CRD = "de9a0000-0000-4000-8000-000000000002";
  const departments = [{ id: CRD, name: "Central R&D", parentId: null, managerUserId: null, managerEmployeeId: null }];
  const assignment = (extra: Partial<Assignment> = {}): Assignment => ({
    id: "5e000000-0000-4000-8000-000000000001", employeeId: "BS-1001", departmentId: CRD, client: "Not recorded",
    projectName: "Customer experience platform", role: "Software Engineer I", allocation: 80, startDate: "2026-09-14",
    latestUpdate: "Reviewed this week's deliverables.", status: "open", completionDate: null, createdAt: "2026-10-14T00:00:00Z",
    closedAt: null, provenance: "assignment", ...extra,
  });
  const closedOne = assignment({
    id: "5e000000-0000-4000-8000-000000000002", projectName: "Legacy migration", client: "Harbour Systems (fictional)", status: "closed",
    startDate: "2026-03-01", completionDate: "2026-08-31", closedAt: "2026-09-01T00:00:00Z", latestUpdate: "Handed over.",
  });
  const withAssignments = (list: Assignment[]) => employees.map(e => ({ ...e, departmentId: CRD, assignments: e.id === "BS-1001" ? list : [] }));

  async function openWork(list: Assignment[], role: "admin" | "manager" = "admin") {
    const user = userEvent.setup();
    const result = await show(<Portal role={role} employees={withAssignments(list)} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Current work" }));
    return { user, ...result };
  }

  afterEach(() => vi.clearAllMocks());

  it("shows the open assignment with its client, role, allocation, start date, department and latest update, and no Git panel", async () => {
    await openWork([assignment()]);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "Customer experience platform" })).toBeInTheDocument();
    expect(within(panel).getByText("Open")).toBeInTheDocument();
    for (const text of ["Not recorded", "Software Engineer I", "80%", "14 Sep 2026", "Central R&D"]) expect(within(panel).getByText(text)).toBeInTheDocument();
    expect(within(panel).getAllByText("Reviewed this week's deliverables.").length).toBeGreaterThan(0);
    expect(within(panel).queryByText(/Recorded Git activity/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/commits/)).not.toBeInTheDocument();
    // Nothing open is offered to create while an assignment is open.
    expect(within(panel).queryByRole("form", { name: "Create an assignment" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("form", { name: "Edit the latest update" })).toBeInTheDocument();
    expect(within(panel).getByRole("form", { name: "Close the assignment" })).toBeInTheDocument();
  });

  it("offers the create form only when nothing is open, with no department field", async () => {
    const { user } = await openWork([closedOne]);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "No open assignment" })).toBeInTheDocument();
    const form = within(panel).getByRole("form", { name: "Create an assignment" });
    expect(within(form).queryByLabelText(/Department/)).not.toBeInTheDocument();
    expect(form.querySelector("[name=departmentId]")).toBeNull();
    await user.type(within(form).getByLabelText("Client"), "Northwind (fictional)");
    await user.type(within(form).getByLabelText("Project name"), "Portal rebuild");
    await user.type(within(form).getByLabelText("Role"), "Developer");
    await user.type(within(form).getByLabelText("Allocation (%)"), "60");
    await user.type(within(form).getByLabelText("Start date"), "2026-10-01");
    // Keyboard-operable: Enter submits the form.
    await user.keyboard("{Enter}");
    expect(createAssignmentAction).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(createAssignmentAction).mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({
      employeeId: "BS-1001", client: "Northwind (fictional)", projectName: "Portal rebuild", role: "Developer", allocation: "60", startDate: "2026-10-01",
    });
    expect(await within(panel).findByRole("status")).toHaveTextContent("Assignment created.");
  });

  it("shows the server's refusal and keeps what was entered", async () => {
    vi.mocked(createAssignmentAction).mockResolvedValueOnce({ error: "This employee already has an open assignment. Close it first.", message: "" });
    const { user } = await openWork([]);
    const panel = screen.getByRole("tabpanel");
    const form = within(panel).getByRole("form", { name: "Create an assignment" });
    await user.type(within(form).getByLabelText("Client"), "Northwind (fictional)");
    await user.type(within(form).getByLabelText("Project name"), "Portal rebuild");
    await user.type(within(form).getByLabelText("Role"), "Developer");
    await user.type(within(form).getByLabelText("Allocation (%)"), "60");
    await user.type(within(form).getByLabelText("Start date"), "2026-10-01");
    await user.click(within(form).getByRole("button", { name: "Create assignment" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("This employee already has an open assignment. Close it first.");
    expect(within(panel).getByLabelText("Client")).toHaveValue("Northwind (fictional)");
  });

  it("keeps a refused latest update and completion date in their fields", async () => {
    vi.mocked(updateAssignmentNoteAction).mockResolvedValueOnce({ error: "This assignment is closed and can't be changed.", message: "" });
    vi.mocked(closeAssignmentAction).mockResolvedValueOnce({ error: "The completion date can't be before the start date.", message: "" });
    const { user } = await openWork([assignment()]);
    const panel = screen.getByRole("tabpanel");
    const note = within(panel).getByLabelText("Latest update");
    await user.clear(note);
    await user.type(note, "Unsaved words.");
    await user.click(within(panel).getByRole("button", { name: "Save update" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("This assignment is closed and can't be changed.");
    expect(within(panel).getByLabelText("Latest update")).toHaveValue("Unsaved words.");

    await user.type(within(panel).getByLabelText("Completion date"), "2026-10-10");
    await user.click(within(panel).getByRole("button", { name: "Close assignment" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("The completion date can't be before the start date.");
    expect(within(panel).getByLabelText("Completion date")).toHaveValue("2026-10-10");
  });

  it("saves the latest update and closes the assignment by its id only", async () => {
    const { user } = await openWork([assignment()]);
    const panel = screen.getByRole("tabpanel");
    const note = within(panel).getByLabelText("Latest update");
    await user.clear(note);
    await user.type(note, "Demo delivered.");
    await user.click(within(panel).getByRole("button", { name: "Save update" }));
    expect(Object.fromEntries((vi.mocked(updateAssignmentNoteAction).mock.calls[0][1] as FormData).entries()))
      .toEqual({ id: "5e000000-0000-4000-8000-000000000001", note: "Demo delivered." });
    expect(await within(panel).findByRole("status")).toHaveTextContent("Latest update saved.");

    await user.type(within(panel).getByLabelText("Completion date"), "2026-10-10");
    await user.click(within(panel).getByRole("button", { name: "Close assignment" }));
    expect(Object.fromEntries((vi.mocked(closeAssignmentAction).mock.calls[0][1] as FormData).entries()))
      .toEqual({ id: "5e000000-0000-4000-8000-000000000001", completionDate: "2026-10-10" });
    expect(await within(panel).findByRole("status")).toHaveTextContent("Assignment closed.");
  });

  it("lists closed assignments in history with a Closed label and D MMM YYYY dates, with no edit or close control", async () => {
    await openWork([assignment(), closedOne]);
    const history = screen.getByRole("list", { name: "Work history" });
    const item = within(history).getByRole("listitem");
    expect(within(item).getByRole("heading", { name: "Legacy migration" })).toBeInTheDocument();
    expect(within(item).getByText("Closed")).toBeInTheDocument();
    expect(within(item).getByText(/1 Mar 2026 – 31 Aug 2026/)).toBeInTheDocument();
    // No note edit or close control on a closed one (Story 4.6 adds only its evaluation form).
    expect(within(item).queryByRole("button", { name: /Save update|Close assignment/ })).not.toBeInTheDocument();
    expect(within(item).queryByLabelText("Latest update")).not.toBeInTheDocument();
    expect(within(item).queryByLabelText("Completion date")).not.toBeInTheDocument();
    // The only edit and close controls belong to the open assignment.
    expect(screen.getAllByRole("button", { name: "Close assignment" })).toHaveLength(1);
  });

  it("works the same for a manager session", async () => {
    await openWork([assignment()], "manager");
    expect(screen.getByRole("form", { name: "Close the assignment" })).toBeInTheDocument();
  });

  it("shows the open assignment on the Overview's Current focus, or that none is open", async () => {
    const user = userEvent.setup();
    const { unmount } = await show(<Portal employees={withAssignments([assignment()])} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    const focus = screen.getByRole("heading", { name: "Current focus" }).closest("article")!;
    expect(within(focus).getByRole("heading", { name: "Customer experience platform" })).toBeInTheDocument();
    expect(within(focus).getByText("Reviewed this week's deliverables.")).toBeInTheDocument();
    unmount();

    await show(<Portal employees={withAssignments([closedOne])} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    const empty = screen.getByRole("heading", { name: "Current focus" }).closest("article")!;
    expect(within(empty).getByText("No open assignment")).toBeInTheDocument();
  });

  it("has no detectable accessibility violations on the Current work tab", async () => {
    const { container } = await openWork([assignment(), closedOne]);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Portal assignment evaluations (Story 4.6)", () => {
  const CRD = "de9a0000-0000-4000-8000-000000000002";
  const LND = "de9a0000-0000-4000-8000-000000000001";
  const MANAGER_USER = "aaaa0000-0000-4000-8000-0000000000a2";
  const ADMIN_USER = "aaaa0000-0000-4000-8000-0000000000ad";
  const departments = [
    // Who manages what now never changes the label: it comes from the stored snapshot.
    { id: CRD, name: "Central R&D", parentId: LND, managerUserId: null, managerEmployeeId: null },
    { id: LND, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
  ];
  const open: Assignment = {
    id: "5e000000-0000-4000-8000-000000000001", employeeId: "BS-1001", departmentId: CRD, client: "Not recorded",
    projectName: "Customer experience platform", role: "Software Engineer I", allocation: 80, startDate: "2026-09-14",
    latestUpdate: "", status: "open", completionDate: null, createdAt: "2026-10-14T00:00:00Z", closedAt: null, provenance: "assignment",
  };
  const closed: Assignment = {
    ...open, id: "5e000000-0000-4000-8000-000000000002", projectName: "Legacy migration", client: "Harbour Systems (fictional)", status: "closed",
    startDate: "2026-03-01", completionDate: "2026-08-31", closedAt: "2026-09-01T00:00:00Z",
  };
  const evaluation = (extra: Partial<AssignmentEvaluation> = {}): AssignmentEvaluation => ({
    id: "e0000000-0000-4000-8000-000000000001", assignmentId: closed.id, employeeId: "BS-1001", departmentId: CRD,
    evaluation: "Delivered the migration on time.", clientFeedback: "The client praised the hand-over.",
    createdBy: MANAGER_USER, createdByName: "Arif Hasan", createdByRole: "manager", createdAt: "2026-10-16T04:00:00Z",
    authoredBy: MANAGER_USER, authoredByName: "Arif Hasan", authoredByRole: "manager", updatedAt: "2026-10-16T04:00:00Z", ...extra,
  });
  const list = (evaluations: AssignmentEvaluation[]) => employees.map(e => ({
    ...e, departmentId: CRD, assignments: e.id === "BS-1001" ? [open, closed] : [], evaluations: e.id === "BS-1001" ? evaluations : [],
  }));

  async function openWork(evaluations: AssignmentEvaluation[], role: "admin" | "manager" = "admin") {
    const user = userEvent.setup();
    const result = await show(<Portal role={role} employees={list(evaluations)} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Current work" }));
    const item = within(screen.getByRole("list", { name: "Work history" })).getByRole("listitem");
    return { user, item, ...result };
  }

  afterEach(() => vi.clearAllMocks());

  it("offers the write form on a closed assignment only, never on the open one", async () => {
    const { item } = await openWork([]);
    expect(within(item).getByText("Not evaluated yet.")).toBeInTheDocument();
    expect(within(item).getByText("Write evaluation")).toBeInTheDocument();
    expect(within(item).getByRole("form", { name: "Write evaluation for Legacy migration" })).toBeInTheDocument();
    // Exactly one evaluation form on the tab: the open assignment gets none.
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("form", { name: /evaluation/i })).toHaveLength(1);
    const current = within(panel).getByRole("heading", { name: "Customer experience platform" }).closest("article")!;
    expect(within(current).queryByLabelText("Evaluation")).not.toBeInTheDocument();
  });

  it("writes an evaluation with client feedback by keyboard, naming only the assignment", async () => {
    const { user, item } = await openWork([]);
    await user.click(within(item).getByText("Write evaluation"));
    await user.type(within(item).getByLabelText("Evaluation"), "Delivered the migration on time.");
    await user.type(within(item).getByLabelText("Client feedback (optional)"), "The client praised the hand-over.");
    await user.click(within(item).getByRole("button", { name: "Save evaluation" }));
    expect(createEvaluationAction).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries((vi.mocked(createEvaluationAction).mock.calls[0][1] as FormData).entries())).toEqual({
      assignmentId: closed.id, mode: "create", evaluation: "Delivered the migration on time.", clientFeedback: "The client praised the hand-over.",
    });
    expect(await within(item).findByRole("status")).toHaveTextContent("Evaluation saved.");
    expect(amendEvaluationAction).not.toHaveBeenCalled();
  });

  it("shows the saved evaluation with its authorship, and the form becomes Amend evaluation", async () => {
    const { item, rerender } = await openWork([]);
    await act(async () => { rerender(<Portal employees={list([evaluation()])} departments={departments} current={none()} />); });
    const shown = within(item).getByRole("region", { name: "Evaluation of Legacy migration" });
    expect(within(shown).getByText("Delivered the migration on time.")).toBeInTheDocument();
    expect(within(shown).getByText("The client praised the hand-over.")).toBeInTheDocument();
    expect(within(item).getByText("Written by Arif Hasan on 16 Oct 2026")).toBeInTheDocument();
    expect(within(item).getByText("Amend evaluation")).toBeInTheDocument();
    expect(within(item).queryByText("Write evaluation")).not.toBeInTheDocument();
    expect(within(item).getByLabelText("Evaluation")).toHaveValue("Delivered the migration on time.");
    expect(within(item).queryByText(MANAGER_USER)).not.toBeInTheDocument();
  });

  it("amends through the amend action and shows who amended it", async () => {
    const amended = evaluation({ authoredBy: ADMIN_USER, authoredByName: null, authoredByRole: "admin", updatedAt: "2026-10-17T05:00:00Z", clientFeedback: "" });
    const { user, item } = await openWork([amended]);
    expect(within(item).getByText("Written by Arif Hasan on 16 Oct 2026 · amended by the Administrator on 17 Oct 2026")).toBeInTheDocument();
    expect(within(item).getByText("No client feedback recorded.")).toBeInTheDocument();
    await user.click(within(item).getByText("Amend evaluation"));
    const text = within(item).getByLabelText("Evaluation");
    await user.clear(text);
    await user.type(text, "Revised after the client call.");
    await user.click(within(item).getByRole("button", { name: "Save amendment" }));
    expect(Object.fromEntries((vi.mocked(amendEvaluationAction).mock.calls[0][1] as FormData).entries())).toMatchObject({
      assignmentId: closed.id, mode: "amend", evaluation: "Revised after the client call.",
    });
    expect(await within(item).findByRole("status")).toHaveTextContent("Evaluation updated.");
    expect(createEvaluationAction).not.toHaveBeenCalled();
  });

  it("falls back to the stored role's words when no name was stored, never a raw id", async () => {
    const { item } = await openWork([evaluation({
      createdBy: "bbbb0000-0000-4000-8000-000000000001", createdByName: null, authoredBy: "bbbb0000-0000-4000-8000-000000000001", authoredByName: null,
    })]);
    expect(within(item).getByText("Written by a manager on 16 Oct 2026")).toBeInTheDocument();
    expect(within(item).queryByText(/bbbb0000/)).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps what was typed", async () => {
    vi.mocked(createEvaluationAction).mockResolvedValueOnce({ error: "Close the assignment before evaluating it.", message: "" });
    const { user, item } = await openWork([], "manager");
    await user.click(within(item).getByText("Write evaluation"));
    await user.type(within(item).getByLabelText("Evaluation"), "Unsaved words.");
    await user.type(within(item).getByLabelText("Client feedback (optional)"), "Unsaved feedback.");
    await user.click(within(item).getByRole("button", { name: "Save evaluation" }));
    expect(await within(item).findByRole("alert")).toHaveTextContent("Close the assignment before evaluating it.");
    expect(within(item).getByLabelText("Evaluation")).toHaveValue("Unsaved words.");
    expect(within(item).getByLabelText("Client feedback (optional)")).toHaveValue("Unsaved feedback.");
  });

  it("has no detectable accessibility violations with an evaluation shown", async () => {
    const { container } = await openWork([evaluation()]);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Portal mixed work history (Story 4.7)", () => {
  const CRD = "de9a0000-0000-4000-8000-000000000002";
  const LND = "de9a0000-0000-4000-8000-000000000001";
  const departments = [
    { id: CRD, name: "Central R&D", parentId: LND, managerUserId: null, managerEmployeeId: null },
    { id: LND, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
  ];
  const open: Assignment = {
    id: "5e000000-0000-4000-8000-000000000001", employeeId: "BS-1001", departmentId: CRD, client: "Not recorded",
    projectName: "Customer experience platform", role: "Software Engineer I", allocation: 80, startDate: "2026-09-14",
    latestUpdate: "", status: "open", completionDate: null, createdAt: "2026-10-14T00:00:00Z", closedAt: null, provenance: "assignment",
  };
  const closed: Assignment = {
    ...open, id: "5e000000-0000-4000-8000-000000000002", projectName: "Legacy migration", client: "Harbour Systems (fictional)", status: "closed",
    startDate: "2026-03-01", completionDate: "2026-08-31", closedAt: "2026-09-01T00:00:00Z",
  };
  const past = (extra: Partial<BackfilledProject> = {}): BackfilledProject => ({
    id: "bf000000-0000-4000-8000-000000000001", employeeId: "BS-1001", departmentId: LND, departmentName: "L&D", client: "Old Bank (fictional)",
    projectName: "Core banking audit", completionDate: "2025-12-15", outcome: "Delivered the audit report.", status: "active",
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", withdrawnAt: null, provenance: "backfilled", ...extra,
  });
  const newer = past({ id: "bf000000-0000-4000-8000-000000000002", projectName: "Mobile wallet", completionDate: "2026-09-30" });
  const withdrawn = past({
    id: "bf000000-0000-4000-8000-000000000003", projectName: "Abandoned pilot", completionDate: "2024-05-01", status: "withdrawn",
    withdrawnAt: "2026-10-16T02:00:00Z",
  });
  const list = () => employees.map(e => ({
    ...e, departmentId: CRD, assignments: e.id === "BS-1001" ? [open, closed] : [], evaluations: [],
    backfilledProjects: e.id === "BS-1001" ? [newer, past(), withdrawn] : [],
  }));

  async function openWork(role: "admin" | "manager" = "admin") {
    const user = userEvent.setup();
    const result = await show(<Portal role={role} employees={list()} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Current work" }));
    const items = within(screen.getByRole("list", { name: "Work history" })).getAllByRole("listitem");
    return { items, ...result };
  }

  for (const role of ["admin", "manager"] as const) {
    it(`lists closed assignments and backfilled entries together, newest completion first, each marked (${role})`, async () => {
      const { items } = await openWork(role);
      expect(items.map(i => within(i).getByRole("heading", { level: 3 }).textContent))
        .toEqual(["Mobile wallet", "Legacy migration", "Core banking audit", "Abandoned pilot"]);
      expect(within(items[0]).getByText("Self-reported")).toBeInTheDocument();
      expect(within(items[1]).getByText("Manager-created")).toBeInTheDocument();
      expect(within(items[1]).queryByText("Self-reported")).not.toBeInTheDocument();
      expect(within(items[2]).getByText("Self-reported")).toBeInTheDocument();
      expect(within(items[3]).getByText("Self-reported")).toBeInTheDocument();
      expect(within(items[3]).getByText("Withdrawn")).toBeInTheDocument();
      expect(within(items[2]).queryByText("Withdrawn")).not.toBeInTheDocument();
      // Department names and D MMM YYYY dates.
      expect(within(items[2]).getByText("Completed 15 Dec 2025 · L&D")).toBeInTheDocument();
      expect(within(items[2]).getByText("Delivered the audit report.")).toBeInTheDocument();
    });
  }

  it("titles the history Work history and shows the stored department name, even outside the viewer's departments", async () => {
    const user = userEvent.setup();
    const elsewhere = past({ id: "bf000000-0000-4000-8000-000000000009", departmentId: "de9a0000-0000-4000-8000-0000000000ee", departmentName: "Far Away Dept" });
    const one = { ...list()[0], backfilledProjects: [elsewhere] };
    await show(<Portal role="manager" employees={[one]} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Current work" }));
    expect(screen.getByRole("heading", { name: "Work history" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Assignment history" })).not.toBeInTheDocument();
    const item = within(screen.getByRole("list", { name: "Work history" })).getAllByRole("listitem")
      .find(i => within(i).queryByRole("heading", { name: "Core banking audit" }))!;
    expect(within(item).getByText("Completed 15 Dec 2025 · Far Away Dept")).toBeInTheDocument();
  });

  it("shows Edited D MMM YYYY on a backfilled row changed after it was added, not on an unchanged or just-withdrawn one", async () => {
    const user = userEvent.setup();
    const edited = past({ updatedAt: "2026-10-18T04:00:00Z" });
    const justWithdrawn = past({
      id: "bf000000-0000-4000-8000-000000000008", projectName: "Withdrawn only", status: "withdrawn",
      updatedAt: "2026-10-19T04:00:00Z", withdrawnAt: "2026-10-19T04:00:00Z",
    });
    const one = { ...list()[0], assignments: [], backfilledProjects: [edited, newer, justWithdrawn] };
    await show(<Portal employees={[one]} departments={departments} current={none()} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Current work" }));
    const items = within(screen.getByRole("list", { name: "Work history" })).getAllByRole("listitem");
    const byName = (n: string) => items.find(i => within(i).queryByRole("heading", { name: n }))!;
    expect(within(byName("Core banking audit")).getByText("Edited 18 Oct 2026")).toBeInTheDocument();
    expect(within(byName("Mobile wallet")).queryByText(/^Edited/)).not.toBeInTheDocument();
    expect(within(byName("Withdrawn only")).queryByText(/^Edited/)).not.toBeInTheDocument();
  });

  it("offers no edit, withdraw or evaluation control on backfilled rows", async () => {
    const { items } = await openWork();
    for (const item of [items[0], items[2], items[3]]) {
      expect(item.querySelectorAll("input, textarea, button, select, form, details")).toHaveLength(0);
      expect(within(item).queryByText(/evaluation/i)).not.toBeInTheDocument();
    }
    // The closed assignment keeps its evaluation form.
    expect(within(items[1]).getByRole("form", { name: "Write evaluation for Legacy migration" })).toBeInTheDocument();
  });

  it("has no detectable accessibility violations with the mixed history", async () => {
    const { container } = await openWork();
    expect(await axe(container)).toHaveNoViolations();
  });
});
