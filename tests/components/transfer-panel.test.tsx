// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const transferMock = vi.fn();
vi.mock("@/server/employee-actions", () => ({
  transferEmployeeAction: (...args: unknown[]) => transferMock(...args),
}));

import TransferPanel from "@/components/transfer-panel";

const P = "de9a0000-0000-4000-8000-0000000000c1";
const C = "de9a0000-0000-4000-8000-0000000000c2";
const Z = "de9a0000-0000-4000-8000-0000000000c3";
const departments = [
  { id: P, name: "Parent Team", parentId: null, managerUserId: "u-1", managerEmployeeId: null },
  { id: C, name: "Child Team", parentId: P, managerUserId: null, managerEmployeeId: null },
  { id: Z, name: "Other Team", parentId: null, managerUserId: null, managerEmployeeId: null },
];

const optionNames = () => screen.getAllByRole("option").map(o => o.textContent);

describe("TransferPanel (Story 4.8)", () => {
  beforeEach(() => transferMock.mockReset());

  it("shows the current department and offers every other listed department", () => {
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={P} />);
    expect(screen.getByRole("heading", { name: "Department" })).toBeInTheDocument();
    expect(screen.getByText("Department: Parent Team")).toBeInTheDocument();
    expect(screen.getByLabelText("Move to department")).toBeInTheDocument();
    expect(optionNames()).toEqual(["Choose a department", "Child Team", "Other Team"]);
  });

  it("says No department and offers every department when the employee has none", () => {
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={null} />);
    expect(screen.getByText("No department")).toBeInTheDocument();
    expect(optionNames()).toEqual(["Choose a department", "Parent Team", "Child Team", "Other Team"]);
  });

  it("says there is nowhere to move them, with no form, when no other department is available", () => {
    render(<TransferPanel employeeId="BS-1003" departments={departments.slice(0, 1)} departmentId={P} />);
    expect(screen.getByText("There is no other department you can move this employee to.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfer employee" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Move to department")).not.toBeInTheDocument();
  });

  it("submits only the Employee ID and the destination, then shows the success text and the new department", async () => {
    transferMock.mockResolvedValue({ error: "", message: "Meera Das was moved to Child Team." });
    const user = userEvent.setup();
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={P} />);
    await user.selectOptions(screen.getByLabelText("Move to department"), "Child Team");
    await user.click(screen.getByRole("button", { name: "Transfer employee" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Meera Das was moved to Child Team.");
    expect(screen.getByText("Department: Child Team")).toBeInTheDocument();
    expect(optionNames()).toEqual(["Choose a department", "Parent Team", "Other Team"]);
    const sent = transferMock.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({ employeeId: "BS-1003", toDepartmentId: C });
  });

  it("shows a refusal as an alert and keeps the current department", async () => {
    transferMock.mockResolvedValue({ error: "Close this employee's open assignment before moving them.", message: "" });
    const user = userEvent.setup();
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={P} />);
    await user.selectOptions(screen.getByLabelText("Move to department"), "Other Team");
    await user.click(screen.getByRole("button", { name: "Transfer employee" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Close this employee's open assignment before moving them.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Department: Parent Team")).toBeInTheDocument();
    // The chosen department is kept after a refusal, so it can be submitted again.
    expect(screen.getByLabelText("Move to department")).toHaveValue(Z);
  });

  it("clears the choice after a success", async () => {
    transferMock.mockResolvedValue({ error: "", message: "Meera Das was moved to Child Team." });
    const user = userEvent.setup();
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={P} />);
    await user.selectOptions(screen.getByLabelText("Move to department"), "Child Team");
    await user.click(screen.getByRole("button", { name: "Transfer employee" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByLabelText("Move to department")).toHaveValue("");
  });

  it("is keyboard operable", async () => {
    transferMock.mockResolvedValue({ error: "", message: "Meera Das was moved to Child Team." });
    const user = userEvent.setup();
    render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={P} />);
    await user.tab();
    expect(screen.getByLabelText("Move to department")).toHaveFocus();
    await user.selectOptions(screen.getByLabelText("Move to department"), "Child Team");
    await user.tab();
    expect(screen.getByRole("button", { name: "Transfer employee" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(transferMock).toHaveBeenCalledTimes(1);
  });

  it.each([[P], [null]])("has no detectable accessibility violations (department %s)", async departmentId => {
    const { container } = render(<TransferPanel employeeId="BS-1003" departments={departments} departmentId={departmentId} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
