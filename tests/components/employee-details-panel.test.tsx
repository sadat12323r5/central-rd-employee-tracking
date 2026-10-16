// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const updateMock = vi.fn();
vi.mock("@/server/employee-actions", () => ({
  updateEmployeeDetailsAction: (...args: unknown[]) => updateMock(...args),
}));

import EmployeeDetailsPanel from "@/components/employee-details-panel";

const props = {
  employeeId: "BS-4321", name: "Tanvir Hasan", title: "QA Engineer", team: "Quality", manager: "Meera Das", office: "Dhaka HQ",
  employmentType: "Trainee", departmentName: "QA Lab",
};
const form = () => within(screen.getByRole("form", { name: "Edit employee details" }));

describe("EmployeeDetailsPanel (Story 7.2)", () => {
  beforeEach(() => updateMock.mockReset());

  it("is prefilled with the employee's current details", () => {
    render(<EmployeeDetailsPanel {...props} />);
    expect(form().getByLabelText("Job title")).toHaveValue("QA Engineer");
    expect(form().getByLabelText("Team")).toHaveValue("Quality");
    expect(form().getByLabelText("Reporting manager")).toHaveValue("Meera Das");
    expect(form().getByLabelText("Office")).toHaveValue("Dhaka HQ");
    expect(form().getByLabelText("Employment type")).toHaveValue("Trainee");
    for (const label of ["Job title", "Team", "Reporting manager", "Office", "Employment type"]) {
      expect(form().getByLabelText(label)).toBeRequired();
    }
  });

  it("offers the three employment types", () => {
    render(<EmployeeDetailsPanel {...props} />);
    expect(within(form().getByLabelText("Employment type")).getAllByRole("option").map(o => o.textContent))
      .toEqual(["Permanent", "Trainee", "Intern"]);
  });

  it("keeps a legacy employment type outside the three as the selected option, and submits it unchanged", async () => {
    updateMock.mockResolvedValue({ error: "Check the employee details.", message: "" });
    const user = userEvent.setup();
    render(<EmployeeDetailsPanel {...props} employmentType="Contract" />);
    const select = form().getByLabelText("Employment type") as HTMLSelectElement;
    expect(select).toHaveValue("Contract");
    expect(within(select).getAllByRole("option").map(o => o.textContent)).toContain("Contract");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByRole("alert");
    expect((updateMock.mock.calls[0][1] as FormData).get("employmentType")).toBe("Contract");
  });

  it("has no department control, and shows the department read-only with the transfer note", () => {
    render(<EmployeeDetailsPanel {...props} />);
    expect(form().queryByLabelText(/department/i)).not.toBeInTheDocument();
    expect(form().getByText("QA Lab")).toBeInTheDocument();
    expect(form().getByText("Changes through a transfer.")).toBeInTheDocument();
    const element = screen.getByRole("form", { name: "Edit employee details" }) as HTMLFormElement;
    const names = [...new FormData(element).keys()];
    expect(names).not.toContain("departmentId");
    expect(names).not.toContain("department");
  });

  it("submits the employee id and the five fields, and shows the success status", async () => {
    updateMock.mockResolvedValue({ error: "", message: "Tanvir Hasan's details were saved." });
    const user = userEvent.setup();
    render(<EmployeeDetailsPanel {...props} />);
    await user.clear(form().getByLabelText("Job title"));
    await user.type(form().getByLabelText("Job title"), "Senior QA Engineer");
    await user.selectOptions(form().getByLabelText("Employment type"), "Permanent");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    // The status region is always present (empty until the action answers): wait for the text, not the role.
    await screen.findByText("Tanvir Hasan's details were saved.");
    expect(screen.getByRole("status")).toHaveTextContent("Tanvir Hasan's details were saved.");
    expect(Object.fromEntries((updateMock.mock.calls[0][1] as FormData).entries())).toEqual({
      employeeId: "BS-4321", title: "Senior QA Engineer", team: "Quality", manager: "Meera Das", office: "Dhaka HQ", employmentType: "Permanent",
    });
    expect(form().getByLabelText("Job title")).toHaveValue("Senior QA Engineer");
  });

  it("shows a refusal as an alert and keeps what was entered and focus", async () => {
    updateMock.mockResolvedValue({ error: "You can only edit employees in your own department or its sub-departments.", message: "" });
    const user = userEvent.setup();
    render(<EmployeeDetailsPanel {...props} />);
    await user.clear(form().getByLabelText("Office"));
    await user.type(form().getByLabelText("Office"), "Chattogram");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can only edit employees");
    expect(form().getByLabelText("Office")).toHaveValue("Chattogram");
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Save details" })).toHaveFocus();
  });

  it("can be completed with the keyboard alone", async () => {
    updateMock.mockResolvedValue({ error: "", message: "Tanvir Hasan's details were saved." });
    const user = userEvent.setup();
    render(<EmployeeDetailsPanel {...props} />);
    form().getByLabelText("Employment type").focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save details" })).toHaveFocus();
    await user.keyboard("{Enter}");
    // The status region is always present (empty until the action answers): wait for the text, not the role.
    await screen.findByText("Tanvir Hasan's details were saved.");
    expect(screen.getByRole("status")).toHaveTextContent("Tanvir Hasan's details were saved.");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<EmployeeDetailsPanel {...props} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
