import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Department, DepartmentInput } from "@/server/departments-store";
import type { SessionIdentity } from "@/server/session";

const { getSession, create, update, setManager, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<SessionIdentity | null>>(),
  create: vi.fn<(session: SessionIdentity, input: DepartmentInput) => Promise<Department>>(),
  update: vi.fn<(session: SessionIdentity, id: string, input: DepartmentInput) => Promise<Department>>(),
  setManager: vi.fn<(session: SessionIdentity, id: string, employeeId: string | null) => Promise<Department>>(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
// The Supabase store is covered by departments-store.test.ts and, against the shared project, departments-rls.test.ts.
vi.mock("../src/server/departments-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/departments-store")>()),
  departmentsStore: { create, update, setManager, list: vi.fn(), managesAny: vi.fn() },
}));

const actions = await import("../src/server/department-actions");
const { createDepartmentAction, setDepartmentManagerAction, updateDepartmentAction } = actions;
const {
  DepartmentCycleError, DepartmentNameInvalidError, DepartmentNameTakenError, DepartmentNotFoundError, DepartmentsForbiddenError,
  DepartmentsUnavailableError, ManagerArchivedError, ManagerEmployeeNotFoundError, ManagerHasNoAccountError,
} = await import("../src/server/departments-store");

const blank = { error: "", message: "" };
const ADMIN = { role: "admin" } as const;
const MANAGER = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const STAFF = { role: "staff", employeeId: "BS-1001" } as const;
const NON_ADMINS: [string, SessionIdentity | null][] = [["a staff session", STAFF], ["a manager session", MANAGER], ["no session", null]];
const noManager = { managerUserId: null, managerEmployeeId: null };
const LND = "de9a0000-0000-4000-8000-000000000001";
const CRD = "de9a0000-0000-4000-8000-000000000002";

const FORBIDDEN = "Only an Administrator can manage departments.";
const TAKEN = "A department with that name already exists.";
const CYCLE = "A department can't be placed under itself or one of its own sub-departments.";
const NOT_FOUND = "Choose an existing department.";
const UNAVAILABLE = "Departments are temporarily unavailable. Nothing was saved.";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  getSession.mockResolvedValue(ADMIN);
  create.mockImplementation(async (_session, input) => ({ id: "new", ...input, ...noManager }));
  update.mockImplementation(async (_session, id, input) => ({ id, ...input, ...noManager }));
  setManager.mockImplementation(async (_session, id, employeeId) => ({
    id, name: "L&D", parentId: null, managerUserId: employeeId ? "user-1" : null, managerEmployeeId: employeeId,
  }));
});
afterEach(() => vi.clearAllMocks());

describe("department actions module", () => {
  it("exports no delete action", () => {
    expect(Object.keys(actions).sort()).toEqual(["createDepartmentAction", "setDepartmentManagerAction", "updateDepartmentAction"]);
  });
});

describe("createDepartmentAction", () => {
  it("adds a top-level department when the parent is empty", async () => {
    expect(await createDepartmentAction(blank, form({ name: "Quality", parentId: "" }))).toEqual({ error: "", message: "Department added." });
    expect(create).toHaveBeenCalledWith(ADMIN, { name: "Quality", parentId: null });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("adds a child, normalising the name", async () => {
    await createDepartmentAction(blank, form({ name: "  QA   Lab ", parentId: LND }));
    expect(create).toHaveBeenCalledWith(ADMIN, { name: "QA Lab", parentId: LND });
  });

  it("treats a missing parent field as top level", async () => {
    await createDepartmentAction(blank, form({ name: "Quality" }));
    expect(create).toHaveBeenCalledWith(ADMIN, { name: "Quality", parentId: null });
  });

  it.each([
    ["an empty name", { name: "", parentId: "" }, /department name/i],
    ["a blank name", { name: "   ", parentId: "" }, /department name/i],
    ["a missing name", { parentId: "" }, /department name/i],
    ["a name over 100 characters", { name: "x".repeat(101), parentId: "" }, /100 characters/],
    ["a non-uuid parent", { name: "Quality", parentId: "L&D" }, /parent department/i],
  ])("rejects %s before the store", async (_label, fields, message) => {
    const result = await createDepartmentAction(blank, form(fields as Record<string, string>));
    expect(result.message).toBe("");
    expect(result.error).toMatch(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 100 characters", async () => {
    expect((await createDepartmentAction(blank, form({ name: "x".repeat(100), parentId: "" }))).message).toBe("Department added.");
  });

  it.each(NON_ADMINS)(
    "rejects %s at the server; the store is never called", async (_label, session) => {
      getSession.mockResolvedValue(session as SessionIdentity | null);
      expect(await createDepartmentAction(blank, form({ name: "Quality", parentId: "" }))).toEqual({ error: FORBIDDEN, message: "" });
      expect(create).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new DepartmentNameTakenError(), TAKEN],
    [new DepartmentNotFoundError(), NOT_FOUND],
    [new DepartmentsForbiddenError(), FORBIDDEN],
    [new DepartmentNameInvalidError(), "Enter a department name of 1 to 100 characters."],
  ])("maps the store's %s to its message", async (error, message) => {
    create.mockRejectedValue(error);
    expect(await createDepartmentAction(blank, form({ name: "Quality", parentId: "" }))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never reports success when departments are unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(new DepartmentsUnavailableError());
    expect(await createDepartmentAction(blank, form({ name: "Quality", parentId: "" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rethrows unexpected errors", async () => {
    create.mockRejectedValue(new TypeError("bug"));
    await expect(createDepartmentAction(blank, form({ name: "Quality", parentId: "" }))).rejects.toThrow("bug");
  });
});

describe("updateDepartmentAction", () => {
  it("renames and re-parents a department", async () => {
    expect(await updateDepartmentAction(blank, form({ id: CRD, name: "Central R&D Lab", parentId: LND })))
      .toEqual({ error: "", message: "Department updated." });
    expect(update).toHaveBeenCalledWith(ADMIN, CRD, { name: "Central R&D Lab", parentId: LND });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("moves a department to the top level", async () => {
    await updateDepartmentAction(blank, form({ id: CRD, name: "Central R&D", parentId: "" }));
    expect(update).toHaveBeenCalledWith(ADMIN, CRD, { name: "Central R&D", parentId: null });
  });

  it.each([
    ["a missing id", { name: "Central R&D", parentId: "" }, /department/i],
    ["a non-uuid id", { id: "crd", name: "Central R&D", parentId: "" }, /existing department/i],
    ["an empty name", { id: CRD, name: "", parentId: "" }, /department name/i],
    ["a name over 100 characters", { id: CRD, name: "y".repeat(101), parentId: "" }, /100 characters/],
  ])("rejects %s before the store", async (_label, fields, message) => {
    const result = await updateDepartmentAction(blank, form(fields as Record<string, string>));
    expect(result.error).toMatch(message);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(NON_ADMINS)(
    "rejects %s at the server; the store is never called", async (_label, session) => {
      getSession.mockResolvedValue(session as SessionIdentity | null);
      expect(await updateDepartmentAction(blank, form({ id: CRD, name: "Central R&D", parentId: "" }))).toEqual({ error: FORBIDDEN, message: "" });
      expect(update).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new DepartmentCycleError(), CYCLE],
    [new DepartmentNameTakenError(), TAKEN],
    [new DepartmentNotFoundError(), NOT_FOUND],
    [new DepartmentsForbiddenError(), FORBIDDEN],
    [new DepartmentNameInvalidError(), "Enter a department name of 1 to 100 characters."],
  ])("maps the store's %s to its message", async (error, message) => {
    update.mockRejectedValue(error);
    expect(await updateDepartmentAction(blank, form({ id: LND, name: "L&D", parentId: CRD }))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors", async () => {
    update.mockRejectedValue(new TypeError("bug"));
    await expect(updateDepartmentAction(blank, form({ id: LND, name: "L&D", parentId: "" }))).rejects.toThrow("bug");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never reports success when departments are unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    update.mockRejectedValue(new DepartmentsUnavailableError());
    expect(await updateDepartmentAction(blank, form({ id: LND, name: "L&D", parentId: "" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("setDepartmentManagerAction", () => {
  it("assigns an employee as manager", async () => {
    expect(await setDepartmentManagerAction(blank, form({ id: LND, manager: "BS-1002" }))).toEqual({ error: "", message: "Manager updated." });
    expect(setManager).toHaveBeenCalledWith(ADMIN, LND, "BS-1002");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("removes the manager for \"none\"", async () => {
    expect(await setDepartmentManagerAction(blank, form({ id: LND, manager: "none" }))).toEqual({ error: "", message: "Manager removed." });
    expect(setManager).toHaveBeenCalledWith(ADMIN, LND, null);
  });

  it.each([
    ["a missing department", { manager: "BS-1002" }, /department/i],
    ["a non-uuid department", { id: "lnd", manager: "BS-1002" }, /existing department/i],
    ["a missing choice", { id: LND }, /choose a manager/i],
    ["an empty choice (Choose…)", { id: LND, manager: "" }, /choose a manager/i],
    ["a malformed employee id", { id: LND, manager: "BS-12" }, /employee from the list/i],
    ["another value", { id: LND, manager: "admin" }, /employee from the list/i],
  ])("rejects %s before the store", async (_label, fields, message) => {
    const result = await setDepartmentManagerAction(blank, form(fields as Record<string, string>));
    expect(result.message).toBe("");
    expect(result.error).toMatch(message);
    expect(setManager).not.toHaveBeenCalled();
  });

  it.each(NON_ADMINS)("rejects %s at the server; the store is never called", async (_label, session) => {
    getSession.mockResolvedValue(session);
    expect(await setDepartmentManagerAction(blank, form({ id: LND, manager: "BS-1002" }))).toEqual({ error: FORBIDDEN, message: "" });
    expect(setManager).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [new ManagerHasNoAccountError("Rafi Ahmed"), "Rafi Ahmed has no sign-in account yet. Provision their account first, then make them a manager."],
    [new ManagerArchivedError("Rafi Ahmed"), "Rafi Ahmed's account is archived. Restore it first."],
    [new ManagerEmployeeNotFoundError(), "Choose an existing department and employee."],
    [new DepartmentNotFoundError(), "Choose an existing department and employee."],
    [new DepartmentsForbiddenError(), FORBIDDEN],
  ])("maps the store's %s to its message, saving nothing", async (error, message) => {
    setManager.mockRejectedValue(error);
    expect(await setDepartmentManagerAction(blank, form({ id: LND, manager: "BS-1002" }))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never reports success when departments are unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setManager.mockRejectedValue(new DepartmentsUnavailableError());
    expect(await setDepartmentManagerAction(blank, form({ id: LND, manager: "none" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rethrows unexpected errors", async () => {
    setManager.mockRejectedValue(new TypeError("bug"));
    await expect(setDepartmentManagerAction(blank, form({ id: LND, manager: "BS-1002" }))).rejects.toThrow("bug");
  });
});
