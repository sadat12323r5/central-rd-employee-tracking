// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("@/server/auth", () => ({
  signOut: () => {},
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
});
