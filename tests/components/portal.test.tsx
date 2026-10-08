// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("Portal archived employees (Story 1.4)", () => {
  // Meera Das (In training) and Tanvir Alam (In training) are archived.
  const withArchived = employees.map(e => ({ ...e, hasAccount: false, archived: e.id === "BS-1003" || e.id === "BS-1006" }));
  const active = withArchived.filter(e => !e.archived);

  it("hides archived employees from the default directory, the counts and the Overview stats", () => {
    render(<Portal employees={withArchived} />);
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
    render(<Portal employees={withArchived} />);
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
    render(<Portal employees={withArchived} />);
    await user.selectOptions(screen.getByLabelText("Show employees"), "Archived employees");
    await user.click(screen.getByRole("button", { name: "View Meera Das's profile" }));
    expect(screen.getByRole("heading", { name: "Meera Das" })).toBeInTheDocument();
    expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(2); // header and Account access panel
    expect(screen.getByRole("heading", { name: "Account access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore employee" })).toBeInTheDocument();
  });

  it("offers Archive on an active employee's profile, with no Archived label", async () => {
    const user = userEvent.setup();
    render(<Portal employees={withArchived} />);
    await user.click(screen.getByRole("button", { name: "View Nadia Rahman's profile" }));
    expect(screen.getByRole("button", { name: "Archive employee" })).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });
});
