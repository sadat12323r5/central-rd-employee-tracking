// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSession, listFor, getFor, loginProps, attendanceListFor, currentFor, portalProps, staffProps, listDepartments, departmentOptions, calendarVersions, summariesFor } = vi.hoisted(() => ({
  getSession: vi.fn(), listFor: vi.fn(), getFor: vi.fn(), loginProps: vi.fn(), attendanceListFor: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  currentFor: vi.fn(), portalProps: vi.fn(), staffProps: vi.fn(), listDepartments: vi.fn(async () => [] as unknown[]),
  departmentOptions: vi.fn(async () => [] as { id: string; name: string }[]),
  calendarVersions: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  summariesFor: vi.fn(async (..._args: unknown[]) => ({ unavailable: "no-calendar" }) as unknown),
}));

vi.mock("@/server/auth", () => ({ getSession }));
vi.mock("@/server/attendance-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/attendance-store")>()),
  // Story 4.3: the page reads attendance through the session-aware listFor.
  attendanceStore: { listFor: attendanceListFor },
}));
// Story 5.4: the attendance summaries the portal shows.
vi.mock("@/server/attendance-summary", () => ({ attendanceSummariesFor: summariesFor }));
vi.mock("@/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/employees-store")>()),
  employeesStore: { listFor, getFor, isActive: vi.fn(async () => true) },
}));
vi.mock("@/server/departments-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/departments-store")>()),
  // Story 4.3: the page reads department names through the session-aware listFor.
  departmentsStore: { list: vi.fn(), listFor: listDepartments, create: vi.fn(), update: vi.fn(), setManager: vi.fn(), managesAny: vi.fn() },
}));
vi.mock("@/server/backfilled-project-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/backfilled-project-store")>()),
  // Story 4.7: the staff portal's department options for the backfill form.
  backfilledProjectStore: { listFor: vi.fn(), departmentOptions, add: vi.fn(), edit: vi.fn(), withdraw: vi.fn() },
}));
vi.mock("@/server/holiday-calendar-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/holiday-calendar-store")>()),
  // Story 5.1: the Administrator's holiday calendar versions.
  holidayCalendarStore: { versions: calendarVersions, active: vi.fn(), load: vi.fn() },
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
    // Story 4.10: the only single-employee read is the manager's own record, under the Staff identity.
    expect(getFor.mock.calls).toEqual([[{ role: "staff", employeeId: "BS-1003" }, "BS-1003"]]);
    expect(listDepartments).toHaveBeenCalledWith(manager);
    expect(currentFor).toHaveBeenCalledWith(manager, scoped.map(e => e.id));
    const props = portalProps.mock.calls.at(-1)?.[0] as { role: string; employees: unknown[]; departments?: unknown };
    expect(props.role).toBe("manager");
    // Story 4.4: interviews are stripped server-side before a manager portal ever sees them.
    expect(props.employees).toEqual(scoped.map(e => ({ ...e, interviews: [] })));
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

  it("passes each employee's backfilled projects through to both portals (Story 4.7)", async () => {
    const { employees } = await import("@/data/employees");
    const backfilled = {
      id: "bp-1", employeeId: "BS-1001", departmentId: "d-1", departmentName: "Dept 1", client: "Old client", projectName: "Past work", completionDate: "2025-06-30",
      outcome: "Delivered.", status: "active", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", withdrawnAt: null,
      provenance: "backfilled",
    };
    const listed = [{ ...employees[0], backfilledProjects: [backfilled] }];
    for (const session of [{ role: "admin" }, { role: "manager", employeeId: "BS-1008", userId: "u-1" }]) {
      getSession.mockResolvedValue(session);
      listFor.mockResolvedValue(listed);
      currentFor.mockResolvedValue({ status: "unavailable" });
      portalProps.mockClear();
      render(await Home());
      const props = portalProps.mock.calls.at(-1)?.[0] as { employees: { backfilledProjects: unknown[] }[] };
      expect(props.employees[0].backfilledProjects).toEqual([backfilled]);
    }
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1001" });
    getFor.mockResolvedValue(listed[0]);
    staffProps.mockClear();
    render(await Home());
    const staff = staffProps.mock.calls.at(-1)?.[0] as { employee: { backfilledProjects: unknown[] } };
    expect(staff.employee.backfilledProjects).toEqual([backfilled]);
  });

  it("passes the department options (id and name) to the staff portal, or null when they are unavailable (Story 4.7)", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1001" });
    getFor.mockResolvedValue(employees[0]);
    currentFor.mockResolvedValue({ status: "unavailable" });
    const options = [{ id: "d-1", name: "Central R&D" }, { id: "d-2", name: "L&D" }];
    departmentOptions.mockResolvedValueOnce(options);
    staffProps.mockClear();
    render(await Home());
    expect((staffProps.mock.calls.at(-1)?.[0] as { departmentOptions: unknown }).departmentOptions).toEqual(options);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    departmentOptions.mockRejectedValueOnce(new Error("PGRST202"));
    staffProps.mockClear();
    render(await Home());
    expect((staffProps.mock.calls.at(-1)?.[0] as { departmentOptions: unknown }).departmentOptions).toBeNull();
    expect(screen.getAllByText("Staff portal").length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never reads department options for the Administrator portal (Story 4.7)", async () => {
    departmentOptions.mockClear();
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    render(await Home());
    expect(departmentOptions).not.toHaveBeenCalled();
  });

  it("passes every department's name to the manager portal as departmentNames, or null when unavailable (Story 4.8)", async () => {
    getSession.mockResolvedValue({ role: "manager", employeeId: "BS-1008", userId: "u-1" });
    listFor.mockResolvedValue([]);
    const names = [{ id: "d-1", name: "Central R&D" }, { id: "d-2", name: "L&D" }];
    departmentOptions.mockResolvedValueOnce(names);
    portalProps.mockClear();
    render(await Home());
    expect((portalProps.mock.calls.at(-1)?.[0] as { departmentNames: unknown }).departmentNames).toEqual(names);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    departmentOptions.mockRejectedValueOnce(new Error("PGRST202"));
    portalProps.mockClear();
    render(await Home());
    expect((portalProps.mock.calls.at(-1)?.[0] as { departmentNames: unknown }).departmentNames).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("strips interviews server-side from every employee a manager session receives (Story 4.4)", async () => {
    const { employees } = await import("@/data/employees");
    const withInterviews = employees.filter(e => e.interviews.length > 0).slice(0, 2);
    expect(withInterviews).toHaveLength(2);
    const manager = { role: "manager", employeeId: "BS-1003" };
    getSession.mockResolvedValue(manager);
    listFor.mockResolvedValue(withInterviews);
    currentFor.mockReset();
    currentFor.mockResolvedValue({ status: "unavailable" });
    portalProps.mockClear();
    render(await Home());
    const props = portalProps.mock.calls.at(-1)?.[0] as { role: string; employees: { id: string; interviews: unknown[] }[] };
    expect(props.role).toBe("manager");
    expect(props.employees).toEqual(withInterviews.map(e => ({ ...e, interviews: [] })));
    expect(JSON.stringify(props.employees)).not.toContain(withInterviews[0].interviews[0].company);
    // Training ids are unchanged by the strip.
    expect(currentFor).toHaveBeenCalledWith(manager, withInterviews.map(e => e.id));
    // The store's own objects are not mutated.
    expect(withInterviews.every(e => e.interviews.length > 0)).toBe(true);
  });

  it("passes interviews through unchanged for an admin (Story 4.4 regression)", async () => {
    const { employees } = await import("@/data/employees");
    const withInterviews = employees.filter(e => e.interviews.length > 0).slice(0, 2);
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue(withInterviews);
    portalProps.mockClear();
    render(await Home());
    expect((portalProps.mock.calls.at(-1)?.[0] as { employees: unknown[] }).employees).toEqual(withInterviews);
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

describe("Home builds \"My record\" for linked management accounts (Story 4.10)", () => {
  const own = { role: "staff", employeeId: "BS-1004" };
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockReset(); getFor.mockReset(); portalProps.mockReset(); currentFor.mockReset(); departmentOptions.mockClear();
    attendanceListFor.mockReset(); attendanceListFor.mockResolvedValue([]);
    listDepartments.mockResolvedValue([]);
    currentFor.mockResolvedValue({ status: "unavailable" });
  });
  afterEach(() => errorSpy.mockRestore());

  type MyRecord = { employee: { id: string; interviews: unknown[] }; entries: unknown[]; serverNow: string; current: Promise<unknown>; departmentOptions: unknown };
  const myRecordProp = () => (portalProps.mock.calls.at(-1)?.[0] as { myRecord?: MyRecord }).myRecord;

  it.each([
    ["a manager", { role: "manager", employeeId: "BS-1004", userId: "u-1" }],
    ["a linked Administrator", { role: "admin", employeeId: "BS-1004" }],
  ])("passes %s their own record, read only with `{ role: \"staff\", employeeId }`", async (_label, session) => {
    const { employees } = await import("@/data/employees");
    const mine = employees.find(e => e.id === "BS-1004")!;
    const entry = { id: "t-1", employeeId: "BS-1004", date: "2026-10-16", clockIn: "2026-10-16T03:00:00.000Z", clockOut: null, breakMinutes: 0, workMode: "Office", log: null };
    const options = [{ id: "d-1", name: "Central R&D" }];
    getSession.mockResolvedValue(session);
    listFor.mockResolvedValue([]);
    getFor.mockResolvedValue(mine);
    attendanceListFor.mockResolvedValue([entry]);
    departmentOptions.mockResolvedValue(options);
    render(await Home());
    const myRecord = myRecordProp();
    expect(myRecord?.employee).toBe(mine);
    expect(myRecord?.entries).toEqual([entry]);
    expect(myRecord?.departmentOptions).toEqual(options);
    expect(typeof myRecord?.serverNow).toBe("string");
    expect(myRecord?.current).toBeInstanceOf(Promise);
    expect(getFor).toHaveBeenCalledWith(own, "BS-1004");
    expect(attendanceListFor).toHaveBeenCalledWith(own, "BS-1004");
    expect(currentFor).toHaveBeenCalledWith(own, ["BS-1004"]);
    // The own reads never use the management identity.
    expect(getFor.mock.calls.every(([s]) => JSON.stringify(s) === JSON.stringify(own))).toBe(true);
    expect(attendanceListFor.mock.calls.every(([s]) => JSON.stringify(s) === JSON.stringify(own))).toBe(true);
    departmentOptions.mockReset(); departmentOptions.mockResolvedValue([]);
  });

  it("keeps the manager's own interviews in myRecord while the employees list stays interview-free", async () => {
    const { employees } = await import("@/data/employees");
    const withInterviews = employees.filter(e => e.interviews.length > 0).slice(0, 2);
    const mine = withInterviews[0];
    getSession.mockResolvedValue({ role: "manager", employeeId: mine.id, userId: "u-1" });
    listFor.mockResolvedValue(withInterviews);
    getFor.mockResolvedValue(mine);
    render(await Home());
    const props = portalProps.mock.calls.at(-1)?.[0] as { employees: { interviews: unknown[] }[]; myRecord: MyRecord };
    expect(props.employees.every(e => e.interviews.length === 0)).toBe(true);
    expect(props.myRecord.employee.interviews).toEqual(mine.interviews);
    expect(props.myRecord.employee.interviews.length).toBeGreaterThan(0);
  });

  it("leaves myRecord undefined for an unlinked Administrator, with no own-record reads", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    render(await Home());
    expect(myRecordProp()).toBeUndefined();
    expect(getFor).not.toHaveBeenCalled();
    expect(attendanceListFor).not.toHaveBeenCalled();
    expect(departmentOptions).not.toHaveBeenCalled();
  });

  it("omits myRecord when the own employee read returns null", async () => {
    getSession.mockResolvedValue({ role: "admin", employeeId: "BS-1004" });
    listFor.mockResolvedValue([]);
    getFor.mockResolvedValue(null);
    render(await Home());
    expect(screen.getByText("Employee directory")).toBeInTheDocument();
    expect(myRecordProp()).toBeUndefined();
  });

  it("shows the existing unavailable pages when an own-record read fails", async () => {
    getSession.mockResolvedValue({ role: "manager", employeeId: "BS-1004", userId: "u-1" });
    listFor.mockResolvedValue([]);
    getFor.mockResolvedValue(null);
    attendanceListFor.mockRejectedValue(new AttendanceUnavailableError());
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/attendance is unavailable/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
  });

  it("shows the employee-records alert when the own employee read fails", async () => {
    getSession.mockResolvedValue({ role: "admin", employeeId: "BS-1004" });
    listFor.mockResolvedValue([]);
    getFor.mockRejectedValue(new EmployeesUnavailableError());
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/employee records are unavailable/i);
  });
});

describe("Home loads the holiday calendar versions for the Administrator (Story 5.1)", () => {
  const versions = [{
    id: "v-1", version: 1, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
    source: "bangladesh-2026.csv", loadedBy: "u", loadedAt: "2026-10-17T04:30:00Z", holidayCount: 31,
  }];
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockReset(); getFor.mockReset(); portalProps.mockReset(); calendarVersions.mockReset();
    currentFor.mockResolvedValue({ status: "unavailable" });
    listDepartments.mockResolvedValue([]);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    calendarVersions.mockReset();
    calendarVersions.mockResolvedValue([]);
  });

  it("passes the versions to the portal, read with the admin session", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    calendarVersions.mockResolvedValue(versions);
    render(await Home());
    expect(calendarVersions).toHaveBeenCalledWith({ role: "admin" });
    expect(portalProps.mock.calls[0][0].holidayCalendars).toEqual(versions);
  });

  it("passes null (logged), not a page failure, when the calendar is unavailable", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    calendarVersions.mockRejectedValue(new Error("PGRST205"));
    render(await Home());
    expect(screen.getByText("Employee directory")).toBeInTheDocument();
    expect(portalProps.mock.calls[0][0].holidayCalendars).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("never reads the versions for a manager", async () => {
    getSession.mockResolvedValue({ role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" });
    listFor.mockResolvedValue([]);
    render(await Home());
    expect(calendarVersions).not.toHaveBeenCalled();
    expect(portalProps.mock.calls[0][0].holidayCalendars).toBeUndefined();
  });
});

describe("Home attendance summaries (Story 5.4)", () => {
  const summaries = { period: { from: "2026-10-01", to: "2026-10-17" }, byEmployee: {} };
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockReset(); getFor.mockReset(); portalProps.mockReset(); summariesFor.mockReset();
    currentFor.mockResolvedValue({ status: "unavailable" });
    listDepartments.mockResolvedValue([]);
    summariesFor.mockResolvedValue(summaries);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    summariesFor.mockReset();
    summariesFor.mockResolvedValue({ unavailable: "no-calendar" });
  });

  it.each([
    ["admin", { role: "admin" }],
    ["manager", { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" }],
  ] as const)("passes the %s's summaries, computed for the listed employees and today in Dhaka, to the portal", async (_name, session) => {
    const { employees } = await import("@/data/employees");
    const { todayInDhaka } = await import("@/domain/dates");
    getSession.mockResolvedValue(session);
    listFor.mockResolvedValue(employees.slice(0, 2));
    render(await Home());
    const [passedSession, passedEmployees, today] = summariesFor.mock.calls[0] as [unknown, { id: string }[], string];
    expect(passedSession).toEqual(session);
    expect(passedEmployees.map(e => e.id)).toEqual(employees.slice(0, 2).map(e => e.id));
    expect(today).toBe(todayInDhaka());
    expect(portalProps.mock.calls[0][0].attendance).toEqual(summaries);
  });

  it("shows the attendance alert when the attendance read fails", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    summariesFor.mockRejectedValue(new AttendanceUnavailableError());
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/attendance is unavailable/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
  });

  it("shows the attendance alert for a manager when the attendance read fails", async () => {
    getSession.mockResolvedValue({ role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" });
    listFor.mockResolvedValue([]);
    summariesFor.mockRejectedValue(new AttendanceUnavailableError());
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/attendance is unavailable/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
  });

  it("never computes summaries for a staff session", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    render(await Home());
    expect(summariesFor).not.toHaveBeenCalled();
  });
});
