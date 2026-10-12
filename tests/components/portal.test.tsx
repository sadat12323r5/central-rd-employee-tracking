// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("@/server/auth", () => ({
  signOut: () => {},
}));
vi.mock("@/server/account-actions", () => ({
  provisionStaffAccountAction: vi.fn(async () => ({ error: "", message: "" })),
}));

import Portal from "@/components/portal";
import { employees } from "@/data/employees";

describe("Portal directory", () => {
  it("shows every employee by default", () => {
    render(<Portal employees={employees} />);
    expect(screen.getAllByRole("row")).toHaveLength(employees.length + 1);
  });

  it("filters by a skill in the search box", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    await user.type(screen.getByRole("textbox", { name: "Search employees" }), "TypeScript");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Nadia Rahman")).toBeInTheDocument();
  });

  it("shows an empty state when no employee matches the filters", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    await user.type(screen.getByRole("textbox", { name: "Search employees" }), "no such employee");
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    await user.selectOptions(screen.getByLabelText("Filter by status"), "In training");
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("shows Reset only once a filter is active, and Reset clears it", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by status"), "Available");
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(employees.length + 1);
  });

  it("has no detectable accessibility violations in the directory view", async () => {
    const { container } = render(<Portal employees={employees} />);
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
    render(<Portal employees={employees} />);
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
    render(<Portal employees={employees} />);
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
    const { container } = render(<Portal employees={employees} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("returns to the directory from a profile", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("button", { name: /back to/i }));
    expect(screen.queryByRole("heading", { name: "Nadia Rahman" })).not.toBeInTheDocument();
  });

  it("shows the Staff account form on the Overview tab for an employee without an account", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees.map(e => ({ ...e, hasAccount: false }))} />);
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Sign-in account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Initial password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Create Staff account" })).toBeInTheDocument();
  });

  it("shows that an employee already has an account, with no form", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees.map(e => ({ ...e, hasAccount: e.id === "BS-1003" }))} />);
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
    render(<Portal employees={[...employees, bare]} />);
    await user.click(screen.getByRole("button", { name: "View Bare Employee's profile" }));
    expect(screen.getByRole("heading", { name: "Bare Employee" })).toBeInTheDocument();
    expect(screen.getByText(/Reviewed Not recorded/)).toBeInTheDocument();
    expect(screen.getByLabelText("Initial password")).toBeInTheDocument();
  });
});

describe("Portal external interviews", () => {
  const added = { id: "7d2f3c1a-0000-4000-8000-000000000001", company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "", feedback: "", withdrawn: false };
  // Two interviews at the same company would have collided on the old company-based keys.
  const withNew = employees.map(e => (e.id === "BS-1003" ? { ...e, interviews: [added, { ...added, id: "7d2f3c1a-0000-4000-8000-000000000002", date: "2026-10-01" }] } : e));

  it("shows a staff-added interview in the profile Interviews tab, with a text label for an empty outcome", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const user = userEvent.setup();
    render(<Portal employees={withNew} />);
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
    render(<Portal employees={withNew} />);
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
    render(<Portal employees={employees} />);
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

  it("leaves a withdrawn entry out of the Upcoming interviews stat", () => {
    const { unmount } = render(<Portal employees={employees} />);
    expect(upcoming()).toBe("01");
    unmount();
    render(<Portal employees={onlyWithdrawn} />);
    expect(upcoming()).toBe("00");
  });

  it("leaves a withdrawn entry out of Interviews & placements", async () => {
    const user = userEvent.setup();
    render(<Portal employees={withWithdrawn} />);
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Interviews & placements" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(employees.flatMap(e => e.interviews).length);
    expect(screen.queryByText("Northstar Labs (fictional)")).not.toBeInTheDocument();
    expect(screen.getByText("Northstar Labs Ltd (fictional)")).toBeInTheDocument();
  });

  it("shows the withdrawn entry only in the profile's Withdrawn history, labelled, with no edit controls", async () => {
    const user = userEvent.setup();
    const { container } = render(<Portal employees={withWithdrawn} />);
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
    render(<Portal employees={onlyWithdrawn} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Interviews" }));
    expect(screen.getByText("This employee has no active external interviews.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Withdrawn (history)" })).toBeInTheDocument();
  });
});

describe("Portal training views (Story 3.1: same rendering, training from training-store)", () => {
  const nadia = employees[0];

  it("shows the Training tab exactly as before: completed then in progress, with dates, progress and result", async () => {
    const user = userEvent.setup();
    render(<Portal employees={employees} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    await user.click(screen.getByRole("tab", { name: "Training" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "Training & development" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("heading", { level: 3 }).map(h => h.textContent)).toEqual(nadia.training.map(t => t.name));
    expect(within(panel).getByText("Completed: 20 Aug 2026")).toBeInTheDocument();
    expect(within(panel).getByText("Target completion: 28 Sep 2026")).toBeInTheDocument();
    expect(within(panel).getByText("Completed · assessment passed")).toBeInTheDocument();
    expect(within(panel).getByText("In progress")).toBeInTheDocument();
    expect(within(panel).getByRole("progressbar", { name: `${nadia.training[0].name} completion` })).toHaveAttribute("value", "100");
    expect(within(panel).getByRole("progressbar", { name: `${nadia.training[1].name} completion` })).toHaveAttribute("value", String(nadia.training[1].progress));
  });

  it("lists every enrolment in Learning & development, with the same counts on the Overview", async () => {
    const user = userEvent.setup();
    const all = employees.flatMap(e => e.training);
    render(<Portal employees={employees} />);
    const stat = (label: string) => screen.getByText(label).closest("article")!.querySelector("strong")!.textContent;
    expect(stat("Learning in progress")).toBe(String(all.filter(t => t.progress < 100).length).padStart(2, "0"));
    expect(screen.getByText(`${all.filter(t => t.progress === 100).length} completed training records`)).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
    expect(screen.getByText(`${all.length} enrolments`)).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(all.length);
    const first = rows.filter(r => within(r).queryByText("Nadia Rahman"));
    expect(first.map(r => within(r).getAllByRole("cell")[3].textContent)).toEqual(["20 Aug 2026", "28 Sep 2026"]);
  });

  it("keys training by id, so two entries with the same programme name render without a key clash", async () => {
    const errorSpy = vi.spyOn(console, "error");
    try {
      const user = userEvent.setup();
      const repeat = { ...nadia.training[0], id: "7a1a0000-0000-4000-8000-0000ffff0001", date: "2025-02-10" };
      render(<Portal employees={employees.map(e => (e.id === nadia.id ? { ...e, training: [...e.training, repeat] } : e))} />);
      await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
      await user.click(screen.getByRole("tab", { name: "Training" }));
      expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { name: nadia.training[0].name })).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: /back to/i }));
      await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Learning & development" }));
      expect(errorSpy.mock.calls.map(args => args.map(String).join(" ")).filter(m => m.includes("same key"))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
