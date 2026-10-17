// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const createMock = vi.fn();
vi.mock("@/server/employee-actions", () => ({
  createEmployeeAction: (...args: unknown[]) => createMock(...args),
}));

import AddEmployeePanel from "@/components/add-employee-panel";
import type { Department } from "@/domain/departments";

const LND = "de9a0000-0000-4000-8000-000000000001";
const CRD = "de9a0000-0000-4000-8000-000000000002";
const departments: Department[] = [
  { id: LND, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
  { id: CRD, name: "Central R&D", parentId: LND, managerUserId: null, managerEmployeeId: null },
];

async function fill(user: ReturnType<typeof userEvent.setup>, overrides: Record<string, string> = {}) {
  const form = within(screen.getByRole("form", { name: "Add an employee" }));
  const values: Record<string, string> = {
    "Employee ID": "BS-4321", "Full name": "Tanvir Hasan", "Job title": "QA Engineer", Team: "Quality",
    "Email address": "tanvir@example.com", "Reporting manager": "Meera Das", Office: "Dhaka HQ", ...overrides,
  };
  for (const [label, value] of Object.entries(values)) await user.type(form.getByLabelText(label), value);
  await user.selectOptions(form.getByLabelText("Department"), CRD);
  await user.selectOptions(form.getByLabelText("Employment type"), "Trainee");
}

describe("AddEmployeePanel", () => {
  beforeEach(() => createMock.mockReset());

  it("offers the given departments, with no valid empty default", () => {
    render(<AddEmployeePanel departments={departments} />);
    const select = screen.getByLabelText("Department") as HTMLSelectElement;
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map(o => o.textContent)).toEqual(["Choose a department…", "Central R&D", "L&D"]);
    expect(options[0]).toBeDisabled();
    expect(select).toBeRequired();
    expect(select.value).toBe("");
  });

  it("offers the three employment types", () => {
    render(<AddEmployeePanel departments={departments} />);
    const options = within(screen.getByLabelText("Employment type")).getAllByRole("option").slice(1);
    expect(options.map(o => o.textContent)).toEqual(["Permanent", "Trainee", "Intern"]);
  });

  it("labels every input and marks the required ones", () => {
    render(<AddEmployeePanel departments={departments} />);
    for (const label of ["Employee ID", "Full name", "Job title", "Team", "Email address", "Department", "Reporting manager", "Office", "Employment type"]) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }
    expect(screen.getByLabelText("Join date (optional)")).not.toBeRequired();
  });

  it("submits the fields, shows the success status and resets the form", async () => {
    createMock.mockResolvedValue({ error: "", message: "Tanvir Hasan was added." });
    const user = userEvent.setup();
    render(<AddEmployeePanel departments={departments} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Add employee" }));
    // The status region is always present (empty until the action answers): wait for the text, not the role.
    await screen.findByText("Tanvir Hasan was added.");
    expect(screen.getByRole("status")).toHaveTextContent("Tanvir Hasan was added.");
    const sent = createMock.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({
      employeeId: "BS-4321", name: "Tanvir Hasan", title: "QA Engineer", team: "Quality", email: "tanvir@example.com",
      departmentId: CRD, manager: "Meera Das", office: "Dhaka HQ", employmentType: "Trainee", joinedOn: "",
    });
    expect(screen.getByLabelText("Employee ID")).toHaveValue("");
    expect(screen.getByLabelText("Department")).toHaveValue("");
  });

  it("shows a refusal as an alert and keeps what was entered", async () => {
    createMock.mockResolvedValue({ error: "An employee with this Employee ID already exists.", message: "" });
    const user = userEvent.setup();
    render(<AddEmployeePanel departments={departments} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Add employee" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An employee with this Employee ID already exists.");
    expect(screen.getByLabelText("Employee ID")).toHaveValue("BS-4321");
    expect(screen.getByLabelText("Department")).toHaveValue(CRD);
    expect(screen.getByRole("status")).toHaveTextContent("");
    // The form is not remounted on a refusal: keyboard focus stays on the submit button.
    expect(screen.getByRole("button", { name: "Add employee" })).toHaveFocus();
  });

  it("can be completed with the keyboard alone", async () => {
    createMock.mockResolvedValue({ error: "", message: "Tanvir Hasan was added." });
    const user = userEvent.setup();
    render(<AddEmployeePanel departments={departments} />);
    await fill(user);
    screen.getByLabelText("Join date (optional)").focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Add employee" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByText("Tanvir Hasan was added.");
    expect(screen.getByRole("status")).toHaveTextContent("Tanvir Hasan was added.");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<AddEmployeePanel departments={departments} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
