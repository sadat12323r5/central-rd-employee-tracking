// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/server/department-actions", () => ({
  createDepartmentAction: (...args: unknown[]) => createMock(...args),
  updateDepartmentAction: (...args: unknown[]) => updateMock(...args),
}));

import DepartmentsPanel from "@/components/departments-panel";
import type { Department } from "@/domain/departments";

const LND = "de9a0000-0000-4000-8000-000000000001";
const CRD = "de9a0000-0000-4000-8000-000000000002";
const QA = "de9a0000-0000-4000-8000-000000000003";
const OPS = "de9a0000-0000-4000-8000-000000000004";
const departments: Department[] = [
  { id: CRD, name: "Central R&D", parentId: LND },
  { id: LND, name: "L&D", parentId: null },
  { id: OPS, name: "Operations", parentId: null },
  { id: QA, name: "QA Lab", parentId: CRD },
];

describe("DepartmentsPanel", () => {
  beforeEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
  });

  it("lists each department with its parent, top-level ones labelled", () => {
    render(<DepartmentsPanel departments={departments} />);
    const rows = within(screen.getByRole("table", { name: "Departments" })).getAllByRole("row").slice(1);
    expect(rows.map(r => within(r).getAllByRole("cell").slice(0, 2).map(c => c.textContent))).toEqual([
      ["Central R&D", "L&D"],
      ["L&D", "Top level"],
      ["Operations", "Top level"],
      ["QA Lab", "Central R&D"],
    ]);
  });

  it("has no delete control", () => {
    render(<DepartmentsPanel departments={departments} />);
    expect(screen.queryByRole("button", { name: /delete|remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /delete|remove/i })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).not.toHaveTextContent(/delete|remove|archive/i);
  });

  it("adds a department with its name and parent", async () => {
    createMock.mockResolvedValue({ error: "", message: "Department added." });
    const user = userEvent.setup();
    render(<DepartmentsPanel departments={departments} />);
    const addForm = screen.getByRole("form", { name: "Add a department" });
    await user.type(within(addForm).getByLabelText("Department name"), "QA Lab");
    await user.selectOptions(within(addForm).getByLabelText("Parent department"), LND);
    await user.click(screen.getByRole("button", { name: "Add department" }));

    expect(await screen.findByText("Department added.")).toHaveAttribute("role", "status");
    const submitted = createMock.mock.calls[0][1] as FormData;
    expect(submitted.get("name")).toBe("QA Lab");
    expect(submitted.get("parentId")).toBe(LND);
  });

  it("offers Top level and every department as the parent of a new one", () => {
    render(<DepartmentsPanel departments={departments} />);
    const select = within(screen.getByRole("form", { name: "Add a department" })).getByLabelText("Parent department");
    expect(within(select).getAllByRole("option").map(o => [o.textContent, (o as HTMLOptionElement).value])).toEqual([
      ["Top level", ""], ["Central R&D", CRD], ["L&D", LND], ["Operations", OPS], ["QA Lab", QA],
    ]);
  });

  it("keeps the typed name and parent after a refusal, so they can be corrected; clears them after a success", async () => {
    createMock.mockResolvedValueOnce({ error: "A department with that name already exists.", message: "" });
    createMock.mockResolvedValueOnce({ error: "", message: "Department added." });
    const user = userEvent.setup();
    render(<DepartmentsPanel departments={departments} />);
    const form = () => screen.getByRole("form", { name: "Add a department" });
    await user.type(within(form()).getByLabelText("Department name"), "central r&d");
    await user.selectOptions(within(form()).getByLabelText("Parent department"), LND);
    await user.click(screen.getByRole("button", { name: "Add department" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A department with that name already exists.");
    expect(within(form()).getByLabelText("Department name")).toHaveValue("central r&d");
    expect(within(form()).getByLabelText("Parent department")).toHaveValue(LND);

    await user.clear(within(form()).getByLabelText("Department name"));
    await user.type(within(form()).getByLabelText("Department name"), "Quality");
    await user.click(screen.getByRole("button", { name: "Add department" }));
    expect(await screen.findByText("Department added.")).toBeInTheDocument();
    expect((createMock.mock.calls[1][1] as FormData).get("parentId")).toBe(LND);
    expect(within(form()).getByLabelText("Department name")).toHaveValue("");
    expect(within(form()).getByLabelText("Parent department")).toHaveValue("");
  });

  it("shows a refusal as an alert", async () => {
    createMock.mockResolvedValue({ error: "A department with that name already exists.", message: "" });
    const user = userEvent.setup();
    render(<DepartmentsPanel departments={departments} />);
    const addForm = screen.getByRole("form", { name: "Add a department" });
    await user.type(within(addForm).getByLabelText("Department name"), "central r&d");
    await user.click(screen.getByRole("button", { name: "Add department" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A department with that name already exists.");
  });

  it("edits a department's name and parent; neither it nor its descendants are parent choices", async () => {
    updateMock.mockResolvedValue({ error: "", message: "Department updated." });
    const user = userEvent.setup();
    render(<DepartmentsPanel departments={departments} />);
    await user.click(screen.getByText("Edit", { selector: "summary[aria-label='Edit department: L&D']" }));
    const name = screen.getByLabelText("Department name · L&D");
    const parent = screen.getByLabelText("Parent department · L&D");
    expect(name).toHaveValue("L&D");
    expect(parent).toHaveValue("");
    expect(within(parent).getAllByRole("option").map(o => o.textContent)).toEqual(["Top level", "Operations"]);
    expect(within(screen.getByLabelText("Parent department · Central R&D")).getAllByRole("option").map(o => o.textContent))
      .toEqual(["Top level", "L&D", "Operations"]);

    await user.clear(name);
    await user.type(name, "Learning & Development");
    await user.selectOptions(parent, OPS);
    const row = name.closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Save department" }));

    expect(await within(row).findByText("Department updated.")).toBeInTheDocument();
    const submitted = updateMock.mock.calls[0][1] as FormData;
    expect(submitted.get("id")).toBe(LND);
    expect(submitted.get("name")).toBe("Learning & Development");
    expect(submitted.get("parentId")).toBe(OPS);
  });

  it("shows the cycle refusal on the edited row", async () => {
    updateMock.mockResolvedValue({ error: "A department can't be placed under itself or one of its own sub-departments.", message: "" });
    const user = userEvent.setup();
    render(<DepartmentsPanel departments={departments} />);
    await user.click(screen.getByText("Edit", { selector: "summary[aria-label='Edit department: L&D']" }));
    await user.click(within(screen.getByLabelText("Department name · L&D").closest("tr")!).getByRole("button", { name: "Save department" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be placed under itself/);
  });

  it("says so when there are no departments yet", () => {
    render(<DepartmentsPanel departments={[]} />);
    expect(screen.getByText(/No departments yet/)).toBeInTheDocument();
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<DepartmentsPanel departments={departments} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
