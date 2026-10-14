// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const saveMock = vi.fn();
vi.mock("@/server/assessment-actions", () => ({
  rateSkillAction: vi.fn(),
  saveEvaluationAction: (...args: unknown[]) => saveMock(...args),
}));

import EvaluationPanel from "@/components/evaluation-panel";

const props = {
  employeeId: "BS-4321", name: "Tanvir Hasan", strengths: "Clear reasoning", developmentPriorities: "Present more", readiness: "Ready",
};
const form = () => within(screen.getByRole("form", { name: "Edit evaluation" }));

describe("EvaluationPanel (Story 7.4)", () => {
  beforeEach(() => saveMock.mockReset());

  it("is prefilled with the current evaluation, every field required, and has no reviewer or date control", () => {
    render(<EvaluationPanel {...props} />);
    expect(form().getByLabelText("Strengths")).toHaveValue("Clear reasoning");
    expect(form().getByLabelText("Development priorities")).toHaveValue("Present more");
    expect(form().getByLabelText("Readiness")).toHaveValue("Ready");
    for (const label of ["Strengths", "Development priorities", "Readiness"]) expect(form().getByLabelText(label)).toBeRequired();
    const names = [...new FormData(screen.getByRole("form", { name: "Edit evaluation" }) as HTMLFormElement).keys()];
    expect(names).toEqual(["employeeId", "strengths", "developmentPriorities", "readiness"]);
  });

  it("submits the three texts and shows the confirmation, which survives the refreshed values", async () => {
    saveMock.mockResolvedValue({ error: "", message: "Tanvir Hasan's evaluation was saved." });
    const user = userEvent.setup();
    const view = render(<EvaluationPanel {...props} />);
    await user.clear(form().getByLabelText("Readiness"));
    await user.type(form().getByLabelText("Readiness"), "Ready for interviews");
    await user.click(screen.getByRole("button", { name: "Save evaluation" }));
    await screen.findByText("Tanvir Hasan's evaluation was saved.");
    expect(Object.fromEntries((saveMock.mock.calls[0][1] as FormData).entries())).toEqual({
      employeeId: "BS-4321", strengths: "Clear reasoning", developmentPriorities: "Present more", readiness: "Ready for interviews",
    });
    view.rerender(<EvaluationPanel {...props} readiness="Ready for interviews" strengths="Saved strengths" />);
    expect(form().getByLabelText("Strengths")).toHaveValue("Saved strengths");
    expect(screen.getByRole("status")).toHaveTextContent("Tanvir Hasan's evaluation was saved.");
  });

  it("shows a refusal as an alert and keeps what was entered", async () => {
    saveMock.mockResolvedValue({ error: "Enter the strengths.", message: "" });
    const user = userEvent.setup();
    render(<EvaluationPanel {...props} />);
    await user.clear(form().getByLabelText("Development priorities"));
    await user.type(form().getByLabelText("Development priorities"), "Draft priorities");
    await user.click(screen.getByRole("button", { name: "Save evaluation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the strengths.");
    expect(form().getByLabelText("Development priorities")).toHaveValue("Draft priorities");
    expect(screen.getByRole("button", { name: "Save evaluation" })).toHaveFocus();
  });

  it("starts empty when no evaluation is recorded", () => {
    render(<EvaluationPanel {...props} strengths="" developmentPriorities="" readiness="" />);
    expect(form().getByLabelText("Strengths")).toHaveValue("");
    expect(form().getByLabelText("Readiness")).toHaveValue("");
  });

  it("can be completed with the keyboard alone", async () => {
    saveMock.mockResolvedValue({ error: "", message: "Tanvir Hasan's evaluation was saved." });
    const user = userEvent.setup();
    render(<EvaluationPanel {...props} />);
    form().getByLabelText("Readiness").focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save evaluation" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByText("Tanvir Hasan's evaluation was saved.");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<EvaluationPanel {...props} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
