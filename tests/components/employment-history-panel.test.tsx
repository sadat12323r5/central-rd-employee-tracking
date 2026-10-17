// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const { addMock, updateMock, removeMock } = vi.hoisted(() => ({ addMock: vi.fn(), updateMock: vi.fn(), removeMock: vi.fn() }));
vi.mock("@/server/employment-history-actions", () => ({
  addEmploymentHistoryAction: (...args: unknown[]) => addMock(...args),
  updateEmploymentHistoryAction: (...args: unknown[]) => updateMock(...args),
  removeEmploymentHistoryAction: (...args: unknown[]) => removeMock(...args),
}));

import EmploymentHistoryPanel from "@/components/employment-history-panel";
import { employees } from "@/data/employees";

const fahim = employees.find(e => e.id === "BS-1008")!;
const entries = fahim.history;
const [current, previous] = entries;
const addForm = () => within(screen.getByRole("form", { name: "Add employment entry" }));
const name = (h: typeof current) => `${h.role}, ${h.company}`;

describe("EmploymentHistoryPanel (Story 7.3)", () => {
  beforeEach(() => { addMock.mockReset(); updateMock.mockReset(); removeMock.mockReset(); });

  it("renders the original timeline markup, in the given order, without controls when it cannot edit", async () => {
    const { container } = render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit={false} />);
    const items = [...container.querySelectorAll(".timeline > .timeline-item")];
    expect(items).toHaveLength(2);
    expect(items.map(item => [...item.children].map(c => `${c.tagName.toLowerCase()}${c.className ? `.${c.className}` : ""}:${c.textContent}`))).toEqual(
      entries.map(h => [`span.timeline-dot:`, `small:${h.period}`, `h3:${h.role}`, `strong:${h.company}`, `p:${h.detail}`]),
    );
    expect(items[0]).toHaveTextContent("2022-02-06 – Present");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when nothing is recorded", () => {
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={[]} canEdit />);
    expect(screen.getByText("No employment history has been recorded.")).toBeInTheDocument();
  });

  it("offers a labelled add form plus Edit and Remove per entry when it can edit", async () => {
    const { container } = render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    for (const label of ["Role", "Employer", "Period"]) expect(addForm().getByLabelText(label)).toBeRequired();
    expect(addForm().getByLabelText("Detail (optional)")).not.toBeRequired();
    for (const h of entries) {
      expect(screen.getByRole("button", { name: `Edit employment entry: ${name(h)}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Remove employment entry: ${name(h)}` })).toBeInTheDocument();
    }
    expect(await axe(container)).toHaveNoViolations();
  });

  it("submits an add with the employee id, clears the form on success and shows the message", async () => {
    addMock.mockResolvedValue({ error: "", message: "Employment entry added." });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.type(addForm().getByLabelText("Role"), "Intern");
    await user.type(addForm().getByLabelText("Employer"), "Orbit Analytics");
    await user.type(addForm().getByLabelText("Period"), "2020");
    await user.click(addForm().getByRole("button", { name: "Add entry" }));
    expect(await screen.findByText("Employment entry added.")).toBeInTheDocument();
    expect(Object.fromEntries(addMock.mock.calls[0][1] as FormData)).toEqual({ employeeId: "BS-1008", role: "Intern", employer: "Orbit Analytics", period: "2020", detail: "" });
    expect(addForm().getByLabelText("Role")).toHaveValue("");
  });

  it("keeps the entered values after a refusal and shows the error as an alert", async () => {
    addMock.mockResolvedValue({ error: "Include a four-digit year in the period, like 2021 – 2023 or Mar 2023 – Present.", message: "" });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.type(addForm().getByLabelText("Role"), "Intern");
    await user.type(addForm().getByLabelText("Employer"), "Orbit");
    await user.type(addForm().getByLabelText("Period"), "Last year");
    await user.click(addForm().getByRole("button", { name: "Add entry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/four-digit year/);
    expect(addForm().getByLabelText("Role")).toHaveValue("Intern");
    expect(addForm().getByLabelText("Period")).toHaveValue("Last year");
  });

  it("edits an entry inline, prefilled, and closes the form after saving (keyboard only)", async () => {
    updateMock.mockResolvedValue({ error: "", message: "Employment entry saved." });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    screen.getByRole("button", { name: `Edit employment entry: ${name(previous)}` }).focus();
    await user.keyboard("{Enter}");
    const form = within(screen.getByRole("form", { name: `Edit employment entry: ${name(previous)}` }));
    expect(form.getByLabelText("Role")).toHaveValue(previous.role);
    expect(form.getByLabelText("Employer")).toHaveValue(previous.company);
    expect(form.getByLabelText("Period")).toHaveValue(previous.period);
    expect(form.getByLabelText("Detail (optional)")).toHaveValue(previous.detail);
    await user.clear(form.getByLabelText("Role"));
    await user.type(form.getByLabelText("Role"), "Associate Engineer{Enter}");
    expect(await screen.findByText("Employment entry saved.")).toBeInTheDocument();
    expect(Object.fromEntries(updateMock.mock.calls[0][1] as FormData)).toMatchObject({ id: previous.id, role: "Associate Engineer", employer: previous.company });
    expect(screen.queryByRole("form", { name: `Edit employment entry: ${name(previous)}` })).not.toBeInTheDocument();
  });

  it("keeps an edit open with the entered values when it is refused", async () => {
    updateMock.mockResolvedValue({ error: "That entry was removed and can no longer be changed.", message: "" });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.click(screen.getByRole("button", { name: `Edit employment entry: ${name(current)}` }));
    const form = within(screen.getByRole("form", { name: `Edit employment entry: ${name(current)}` }));
    await user.type(form.getByLabelText("Detail (optional)"), " More.");
    await user.click(form.getByRole("button", { name: "Save entry" }));
    expect(await form.findByRole("alert")).toHaveTextContent("That entry was removed and can no longer be changed.");
    expect(form.getByLabelText("Detail (optional)")).toHaveValue(`${current.detail} More.`);
  });

  it("asks for confirmation before removing, and cancelling removes nothing", async () => {
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.click(screen.getByRole("button", { name: `Remove employment entry: ${name(previous)}` }));
    const confirm = screen.getByRole("button", { name: "Confirm remove" });
    expect(confirm).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm remove" })).not.toBeInTheDocument();
  });

  it("removes after confirmation and shows the message", async () => {
    removeMock.mockResolvedValue({ error: "", message: "Employment entry removed. It is kept in the record's history." });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.click(screen.getByRole("button", { name: `Remove employment entry: ${name(previous)}` }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Employment entry removed. It is kept in the record's history.")).toBeInTheDocument();
    expect(Object.fromEntries(removeMock.mock.calls[0][1] as FormData)).toEqual({ id: previous.id, employeeId: "BS-1008" });
  });

  it("shows a refused removal as an alert", async () => {
    removeMock.mockResolvedValue({ error: "Employment history could not be reached, so nothing was saved. Please try again in a moment.", message: "" });
    const user = userEvent.setup();
    render(<EmploymentHistoryPanel employeeId={fahim.id} entries={entries} canEdit />);
    await user.click(screen.getByRole("button", { name: `Remove employment entry: ${name(current)}` }));
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached/);
  });
});
