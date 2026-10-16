// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSession, listFor, getFor, loginProps, attendanceListFor, currentFor, portalProps, staffProps, listDepartments } = vi.hoisted(() => ({
  getSession: vi.fn(), listFor: vi.fn(), getFor: vi.fn(), loginProps: vi.fn(), attendanceListFor: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  currentFor: vi.fn(), portalProps: vi.fn(), staffProps: vi.fn(), listDepartments: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/server/auth", () => ({ getSession }));
vi.mock("@/server/attendance-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/attendance-store")>()),
  // Story 4.3: the page reads attendance through the session-aware listFor.
  attendanceStore: { listFor: attendanceListFor },
}));
vi.mock("@/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/employees-store")>()),
  employeesStore: { listFor, getFor, isActive: vi.fn(async () => true) },
}));
vi.mock("@/server/departments-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/departments-store")>()),
  // Story 4.3: the page reads department names through the session-aware listFor.
  departmentsStore: { list: vi.fn(), listFor: listDepartments, create: vi.fn(), update: vi.fn(), setManager: vi.fn(), managesAny: vi.fn() },
}));
vi.mock("@/server/training-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/training-store")>()),
  trainingStore: { currentFor },
}));
vi.mock("@/components/login", () => ({
  default: (props: Record<string, unknown>) => {
    loginProps(props);
    return <p>Sign-in form</p>;
  },
}));
vi.mock("@/components/portal", () => ({
  default: (props: Record<string, unknown>) => {
    portalProps(props);
    return <p>Employee directory</p>;
  },
}));
vi.mock("@/components/staff-attendance", () => ({
  default: (props: { entries: unknown[] }) => {
    staffProps(props);
    return <><p>Staff portal</p><table aria-label="Recent days"><tbody>{props.entries.map((_, i) => <tr key={i}><td>entry</td></tr>)}</tbody></table></>;
  },
}));

const { default: Home } = await import("@/app/page");
const { EmployeesUnavailableError } = await import("@/server/employees-store");
const { AttendanceUnavailableError } = await import("@/server/attendance-store");
const { DepartmentsUnavailableError } = await import("@/server/departments-store");

describe("Home when employee records are unavailable", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockRejectedValue(new EmployeesUnavailableError());
    getFor.mockRejectedValue(new EmployeesUnavailableError());
  });
  afterEach(() => errorSpy.mockRestore());

  it("shows the unavailable alert instead of the directory for an admin", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/employee records are unavailable/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("shows the unavailable alert instead of the staff portal for staff", async () => {
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/employee records are unavailable/i);
    expect(screen.queryByText("Staff portal")).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign-in form/)).not.toBeInTheDocument();
  });
});

describe("Home when signed out", () => {
  beforeEach(() => getSession.mockResolvedValue(null));

  it("renders the sign-in form without any demo-credential props or credentials", async () => {
    render(await Home());
    expect(loginProps).toHaveBeenCalledWith({});
    expect(document.body).not.toHaveTextContent(/Staff23Demo|demo credentials|password:/i);
  });
});

describe("Home routing by role", () => {
  beforeEach(() => {
    listFor.mockReset();
    getFor.mockReset();
  });

  it("renders only the staff portal for a staff session, reading their own record", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    render(await Home());
    expect(screen.getByText("Staff portal")).toBeInTheDocument();
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
    expect(getFor).toHaveBeenCalledWith({ role: "staff", employeeId: "BS-1003" }, "BS-1003");
    expect(listFor).not.toHaveBeenCalled();
  });

  it("shows the sign-in form when a staff member's own record is not visible", async () => {
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(null);
    render(await Home());
    expect(screen.getByText(/Sign-in form/)).toBeInTheDocument();
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
  });

  it("renders the directory for an admin", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    render(await Home());
    expect(screen.getByText("Employee directory")).toBeInTheDocument();
  });

  it("renders the management portal as `manager` with the scoped employees and department names (Stories 4.2, 4.3)", async () => {
    const { employees } = await import("@/data/employees");
    const scoped = employees.filter(e => e.id === "BS-1003" || e.id === "BS-1004");
    const departments = [{ id: "de9a0000-0000-4000-8000-000000000002", name: "Central R&D", parentId: null, managerUserId: "u-1", managerEmployeeId: "BS-1003" }];
    const manager = { role: "manager", employeeId: "BS-1003", userId: "u-1" };
    getSession.mockResolvedValue(manager);
    listFor.mockResolvedValue(scoped);
    currentFor.mockResolvedValue({ status: "unavailable" });
    portalProps.mockClear();
    listDepartments.mockClear();
    listDepartments.mockResolvedValueOnce(departments);
    render(await Home());
    expect(screen.getByText("Employee directory")).toBeInTheDocument();
    expect(screen.queryByText("Staff portal")).not.toBeInTheDocument();
    expect(listFor).toHaveBeenCalledWith(manager);
    expect(getFor).not.toHaveBeenCalled();
    expect(listDepartments).toHaveBeenCalledWith(manager);
    expect(currentFor).toHaveBeenCalledWith(manager, scoped.map(e => e.id));
    const props = portalProps.mock.calls.at(-1)?.[0] as { role: string; employees: unknown[]; departments?: unknown };
    expect(props.role).toBe("manager");
    expect(props.employees).toEqual(scoped);
    expect(props.departments).toEqual(departments);
  });

  it("passes each employee's assignments through unchanged; no `work` field reaches the portal (Story 4.5)", async () => {
    const { employees } = await import("@/data/employees");
    const open = {
      id: "a-1", employeeId: "BS-1001", departmentId: "d-1", client: "Not recorded", projectName: "Customer experience platform",
      role: "Software Engineer I", allocation: 80, startDate: "2026-09-14", latestUpdate: "", status: "open", completionDate: null,
      createdAt: "2026-10-14T00:00:00Z", closedAt: null,
    };
    const listed = [{ ...employees[0], assignments: [open] }];
    for (const session of [{ role: "admin" }, { role: "manager", employeeId: "BS-1008", userId: "u-1" }]) {
      getSession.mockResolvedValue(session);
      listFor.mockResolvedValue(listed);
      currentFor.mockResolvedValue({ status: "unavailable" });
      portalProps.mockClear();
      render(await Home());
      const props = portalProps.mock.calls.at(-1)?.[0] as { employees: { assignments: unknown[] }[] };
      expect(props.employees[0].assignments).toEqual([open]);
      expect(props.employees[0]).not.toHaveProperty("work");
    }
  });

  it("passes each employee's assignment evaluations through to both portals (Story 4.6)", async () => {
    const { employees } = await import("@/data/employees");
    const evaluation = {
      id: "ev-1", assignmentId: "a-0", employeeId: "BS-1001", departmentId: "d-1", evaluation: "Delivered on time.", clientFeedback: "Happy client.",
      createdBy: "u-1", createdAt: "2026-10-16T00:00:00Z", authoredBy: "u-1", updatedAt: "2026-10-16T00:00:00Z",
      createdByName: null, createdByRole: "manager", authoredByName: null, authoredByRole: "manager",
    };
    const listed = [{ ...employees[0], evaluations: [evaluation] }];
    for (const session of [{ role: "admin" }, { role: "manager", employeeId: "BS-1008", userId: "u-1" }]) {
      getSession.mockResolvedValue(session);
      listFor.mockResolvedValue(listed);
      currentFor.mockResolvedValue({ status: "unavailable" });
      portalProps.mockClear();
      render(await Home());
      const props = portalProps.mock.calls.at(-1)?.[0] as { employees: { evaluations: unknown[] }[] };
      expect(props.employees[0].evaluations).toEqual([evaluation]);
    }
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1001" });
    getFor.mockResolvedValue(listed[0]);
    staffProps.mockClear();
    render(await Home());
    const staff = staffProps.mock.calls.at(-1)?.[0] as { employee: { evaluations: unknown[] } };
    expect(staff.employee.evaluations).toEqual([evaluation]);
    expect(getFor).toHaveBeenLastCalledWith({ role: "staff", employeeId: "BS-1001" }, "BS-1001");
  });

  it("passes no role (the Administrator portal) for an admin", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    portalProps.mockClear();
    render(await Home());
    expect((portalProps.mock.calls.at(-1)?.[0] as { role?: string }).role).toBeUndefined();
  });
});

describe("Home when attendance is unavailable", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    const { employees } = await import("@/data/employees");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    attendanceListFor.mockRejectedValue(new AttendanceUnavailableError());
  });
  afterEach(() => {
    errorSpy.mockRestore();
    attendanceListFor.mockReset();
    attendanceListFor.mockResolvedValue([]);
  });

  it("shows the attendance alert instead of the staff portal and no entries table", async () => {
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/attendance is unavailable/i);
    expect(screen.queryByText("Staff portal")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign-in form/)).not.toBeInTheDocument();
    expect(attendanceListFor).toHaveBeenCalledWith({ role: "staff", employeeId: "BS-1003" }, "BS-1003");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("Home streams current LMS enrolments (Story 3.2)", () => {
  const okResult = { status: "ok", asOf: "2026-10-12T05:00:00.000Z", stale: false, inProgress: [], lmsCompleted: [], freshness: {} } as const;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockReset(); getFor.mockReset(); currentFor.mockReset(); portalProps.mockReset(); staffProps.mockReset();
  });
  afterEach(() => errorSpy.mockRestore());

  it("passes the staff portal a promise for the staff member's own id, without awaiting it", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    currentFor.mockReturnValue(new Promise(() => {})); // never resolves: the page must still render
    render(await Home());
    expect(screen.getByText("Staff portal")).toBeInTheDocument();
    expect(currentFor).toHaveBeenCalledWith({ role: "staff", employeeId: "BS-1003" }, ["BS-1003"]);
    expect(staffProps.mock.calls[0][0].current).toBeInstanceOf(Promise);
  });

  it("passes the Administrator portal a promise for every listed employee", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue(employees);
    currentFor.mockResolvedValue(okResult);
    render(await Home());
    expect(currentFor).toHaveBeenCalledWith({ role: "admin" }, employees.map(e => e.id));
    await expect(portalProps.mock.calls[0][0].current).resolves.toEqual(okResult);
  });

  it("turns an unexpected error into unavailable (a resolved value) and logs it", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    currentFor.mockRejectedValue(new TypeError("bug"));
    render(await Home());
    await expect(portalProps.mock.calls[0][0].current).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("turns a synchronous throw into unavailable too", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    currentFor.mockImplementation(() => { throw new TypeError("bug"); });
    render(await Home());
    await expect(portalProps.mock.calls[0][0].current).resolves.toEqual({ status: "unavailable" });
  });
});

describe("Home loads the department list for the Administrator (Story 4.1)", () => {
  const departments = [
    { id: "de9a0000-0000-4000-8000-000000000001", name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
    { id: "de9a0000-0000-4000-8000-000000000002", name: "Central R&D", parentId: "de9a0000-0000-4000-8000-000000000001", managerUserId: null, managerEmployeeId: null },
  ];
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockReset(); getFor.mockReset(); portalProps.mockReset(); listDepartments.mockReset();
    currentFor.mockResolvedValue({ status: "unavailable" });
  });
  afterEach(() => {
    errorSpy.mockRestore();
    listDepartments.mockReset();
    listDepartments.mockResolvedValue([]);
  });

  it("passes the departments to the portal, read with the admin session", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    listDepartments.mockResolvedValue(departments);
    render(await Home());
    expect(listDepartments).toHaveBeenCalledWith({ role: "admin" });
    expect(portalProps.mock.calls[0][0].departments).toEqual(departments);
  });

  it("never reads departments for a staff session", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    render(await Home());
    expect(listDepartments).not.toHaveBeenCalled();
  });

  it("shows the departments-unavailable alert, not a partial directory, when departments are unavailable", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    listDepartments.mockRejectedValue(new DepartmentsUnavailableError());
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/departments are unavailable/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/employee records/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });
});
