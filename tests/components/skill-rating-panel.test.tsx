// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const rateMock = vi.fn();
vi.mock("@/server/assessment-actions", () => ({
  rateSkillAction: (...args: unknown[]) => rateMock(...args),
  saveEvaluationAction: vi.fn(),
}));

import SkillRatingPanel from "@/components/skill-rating-panel";

const skills = [{ name: "React", level: 4, evidence: "Project review" }, { name: "Communication", level: 3, evidence: "Mentor feedback" }];
const props = { employeeId: "BS-4321", name: "Tanvir Hasan", skills };
const form = () => within(screen.getByRole("form", { name: "Rate a skill" }));

describe("SkillRatingPanel (Story 7.4)", () => {
  beforeEach(() => rateMock.mockReset());

  it("has a required skill name with the existing names suggested, a 1–5 level select with labels and evidence", () => {
    render(<SkillRatingPanel {...props} />);
    const name = form().getByLabelText("Skill");
    expect(name).toBeRequired();
    const list = document.getElementById(name.getAttribute("list")!)!;
    expect([...list.querySelectorAll("option")].map(o => o.getAttribute("value"))).toEqual(["React", "Communication"]);
    const level = form().getByLabelText("Level");
    expect(level).toBeRequired();
    expect(within(level).getAllByRole("option").map(o => o.textContent)).toEqual([
      "Choose a level", "1 · foundational", "2 · developing", "3 · independent", "4 · advanced", "5 · expert",
    ]);
    expect(form().getByLabelText("Evidence")).toBeRequired();
  });

  it("submits the employee id, name, level and evidence, shows the confirmation, and clears once the skills refresh", async () => {
    rateMock.mockResolvedValue({ error: "", message: "Go was rated 5 out of 5 for Tanvir Hasan." });
    const user = userEvent.setup();
    const view = render(<SkillRatingPanel {...props} />);
    await user.type(form().getByLabelText("Skill"), "Go");
    await user.selectOptions(form().getByLabelText("Level"), "5");
    await user.type(form().getByLabelText("Evidence"), "Shipped a service");
    await user.click(screen.getByRole("button", { name: "Save rating" }));
    await screen.findByText("Go was rated 5 out of 5 for Tanvir Hasan.");
    expect(Object.fromEntries((rateMock.mock.calls[0][1] as FormData).entries())).toEqual({
      employeeId: "BS-4321", name: "Go", level: "5", evidence: "Shipped a service",
    });
    view.rerender(<SkillRatingPanel {...props} skills={[{ name: "Go", level: 5, evidence: "Shipped a service" }, ...skills]} />);
    expect(form().getByLabelText("Skill")).toHaveValue("");
    // The confirmation survives the refresh.
    expect(screen.getByRole("status")).toHaveTextContent("Go was rated 5 out of 5 for Tanvir Hasan.");
  });

  it("shows a refusal as an alert and keeps what was entered", async () => {
    rateMock.mockResolvedValue({ error: "You can only assess employees in your own department or its sub-departments.", message: "" });
    const user = userEvent.setup();
    render(<SkillRatingPanel {...props} />);
    await user.type(form().getByLabelText("Skill"), "React");
    await user.selectOptions(form().getByLabelText("Level"), "2");
    await user.type(form().getByLabelText("Evidence"), "Review");
    await user.click(screen.getByRole("button", { name: "Save rating" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can only assess employees");
    expect(form().getByLabelText("Skill")).toHaveValue("React");
    expect(form().getByLabelText("Level")).toHaveValue("2");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("can be completed with the keyboard alone", async () => {
    rateMock.mockResolvedValue({ error: "", message: "Go was rated 3 out of 5 for Tanvir Hasan." });
    const user = userEvent.setup();
    render(<SkillRatingPanel {...props} />);
    await user.click(form().getByLabelText("Skill"));
    await user.keyboard("Go");
    await user.tab();
    expect(form().getByLabelText("Level")).toHaveFocus();
    await user.selectOptions(form().getByLabelText("Level"), "3");
    await user.tab();
    await user.keyboard("Evidence");
    await user.tab();
    expect(screen.getByRole("button", { name: "Save rating" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByText("Go was rated 3 out of 5 for Tanvir Hasan.");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<SkillRatingPanel {...props} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
