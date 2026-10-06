// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const provisionMock = vi.fn();
vi.mock("@/server/account-actions", () => ({
  provisionStaffAccountAction: (...args: unknown[]) => provisionMock(...args),
}));

import StaffAccountPanel from "@/components/staff-account-panel";

const password = "a-long-initial-password";

describe("StaffAccountPanel", () => {
  beforeEach(() => provisionMock.mockReset());

  it("submits only the Employee ID and the initial password (typed twice), then shows the success status", async () => {
    provisionMock.mockResolvedValue({ error: "", message: "Sign-in account created for Meera Das." });
    const user = userEvent.setup();
    render(<StaffAccountPanel employeeId="BS-1003" name="Meera Das" hasAccount={false} />);
    await user.type(screen.getByLabelText("Initial password"), password);
    expect(screen.getByLabelText("Confirm initial password")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Confirm initial password"), password);
    await user.click(screen.getByRole("button", { name: "Create Staff account" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Sign-in account created for Meera Das.");
    expect(screen.getByText("Has a sign-in account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Staff account" })).not.toBeInTheDocument();
    const submitted = provisionMock.mock.calls[0][1] as FormData;
    expect([...submitted.keys()].sort()).toEqual(["confirmPassword", "employeeId", "password"]);
    expect(submitted.get("employeeId")).toBe("BS-1003");
    expect(document.body).not.toHaveTextContent(password);
  });

  it("shows a server error as an alert and keeps the form", async () => {
    provisionMock.mockResolvedValue({ error: "This employee already has a sign-in account.", message: "" });
    const user = userEvent.setup();
    render(<StaffAccountPanel employeeId="BS-1003" name="Meera Das" hasAccount={false} />);
    await user.type(screen.getByLabelText("Initial password"), password);
    await user.type(screen.getByLabelText("Confirm initial password"), password);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("This employee already has a sign-in account.");
    expect(screen.getByRole("button", { name: "Create Staff account" })).toBeInTheDocument();
  });

  it("shows only the account state when the employee already has an account", () => {
    render(<StaffAccountPanel employeeId="BS-1003" name="Meera Das" hasAccount />);
    expect(screen.getByText("Has a sign-in account")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Initial password")).not.toBeInTheDocument();
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<StaffAccountPanel employeeId="BS-1003" name="Meera Das" hasAccount={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
