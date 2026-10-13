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
vi.mock("@/server/activity-actions", () => ({
  exportActivityAction: vi.fn(async () => ({ error: "", message: "" })),
}));

import Portal from "@/components/portal";
import { employees } from "@/data/employees";
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
      work: { project: "", role: "", allocation: 0, update: "", commits: 0, period: "" },
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
