import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assignment, AssignmentEvaluation, BackfilledProject, Employee, LeaveRecord } from "../src/data/employees";
import type { TimesheetEntry } from "../src/domain/timesheet";
import type { ManagerScopeSet } from "../src/server/manager-scope";
import type { CurrentTraining } from "../src/server/training-store";

const {
  getActor, getServiceClient, recordActivityExport, recordBulkActivityExport, recordDepartmentActivityExport, createAuditStore,
} = vi.hoisted(() => {
  const recordActivityExport = vi.fn();
  const recordBulkActivityExport = vi.fn();
  const recordDepartmentActivityExport = vi.fn();
  return {
    getActor: vi.fn(),
    getServiceClient: vi.fn(() => ({ fake: "service client" })),
    recordActivityExport,
    recordBulkActivityExport,
    recordDepartmentActivityExport,
    createAuditStore: vi.fn(() => ({ recordActivityExport, recordBulkActivityExport, recordDepartmentActivityExport })),
  };
});

vi.mock("../src/server/auth", () => ({ getActor, getSession: vi.fn() }));
vi.mock("../src/server/supabase", () => ({ getServiceClient, getUserClient: vi.fn() }));
vi.mock("../src/server/audit-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/audit-store")>()),
  createAuditStore,
}));

const {
  activityErrorMessage, ActivityEmployeeNotFoundError, ActivityForbiddenError, ActivityUnavailableError, ActivityValidationError,
  exportActivity, exportAllActivity, NOT_ALLOWED, OUT_OF_SCOPE, UNAVAILABLE, UNKNOWN_EMPLOYEE,
} = await import("../src/server/activity-export");
const { exportActivityAction, exportAllActivityAction } = await import("../src/server/activity-actions");
const { AttendanceUnavailableError, attendanceStore } = await import("../src/server/attendance-store");
const { InterviewsUnavailableError, interviewsStore } = await import("../src/server/interviews-store");
const { TrainingUnavailableError, trainingStore } = await import("../src/server/training-store");
const { EmployeesUnavailableError, employeesStore } = await import("../src/server/employees-store");
const { AuditEmployeeNotFoundError, AuditUnavailableError, AuditValidationError } = await import("../src/server/audit-store");
const { managerScope, ManagerScopeUnavailableError } = await import("../src/server/manager-scope");
const { AssignmentsUnavailableError, assignmentsStore } = await import("../src/server/assignments-store");
const { BackfillUnavailableError, backfilledProjectStore } = await import("../src/server/backfilled-project-store");
const { EvaluationsUnavailableError, assignmentEvaluationsStore } = await import("../src/server/assignment-evaluations-store");
const { LeaveUnavailableError, leaveStore } = await import("../src/server/leave-store");

const admin = { role: "admin" } as const;
const actorId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-13T06:00:00Z"); // 13 Oct 2026 in Dhaka

const nadia = { id: "BS-1001", name: "Nadia Rahman" } as Employee;

const entry = (date: string): TimesheetEntry => ({
  id: `a-${date}`, employeeId: "BS-1001", date, clockIn: `${date}T03:00:00Z`, clockOut: `${date}T11:00:00Z`, breakMinutes: 0,
  workMode: "Office", log: null,
});

/** The Story 8.4 stores, empty unless a test fills them. */
function fakeRecordStores() {
  return {
    assignments: { listFor: vi.fn(async (_s: unknown, _id?: string): Promise<Assignment[]> => []) },
    backfilledProjects: { listFor: vi.fn(async (_s: unknown, _id?: string): Promise<BackfilledProject[]> => []) },
    evaluations: { listFor: vi.fn(async (_s: unknown, _id?: string): Promise<AssignmentEvaluation[]> => []) },
    leave: { listFor: vi.fn(async (_s: unknown, _id?: string): Promise<LeaveRecord[]> => []) },
  };
}

const recordReads = (deps: ReturnType<typeof fakeRecordStores>) => [
  deps.assignments.listFor, deps.backfilledProjects.listFor, deps.evaluations.listFor, deps.leave.listFor,
].map(fn => fn.mock.calls.length);

function fakeDeps() {
  const audit = vi.fn(async () => {});
  const deps = {
    ...fakeRecordStores(),
    employees: { getFor: vi.fn(async (_s: unknown, id: string) => (id === "BS-1001" ? nadia : null)) },
    attendance: { listFor: vi.fn(async () => [entry("2026-09-02"), entry("2026-10-01")]) },
    interviews: {
      listFor: vi.fn(async () => [{
        id: "i1", employeeId: "BS-1001", company: "=HYPERLINK(\"http://x\")", role: "QA", date: "2026-09-15", stage: "Technical",
        outcome: "Scheduled", feedback: "", withdrawn: false,
      }]),
    },
    training: {
      listFor: vi.fn(async () => [{ id: "t1", employeeId: "BS-1001", name: "React", provider: "Udemy", progress: 100, date: "2026-09-20", result: "Passed" }]),
      currentFor: vi.fn(async (): Promise<CurrentTraining> => ({
        status: "ok" as const, asOf: "2026-10-13T00:00:00Z", stale: false,
        inProgress: [{ id: "e1", employeeId: "BS-1001", name: "Leadership", provider: "LMS", progress: 40, date: "2026-09-28", result: "In progress" }],
        lmsCompleted: [{ id: "e2", employeeId: "BS-1001", name: "Testing", provider: "LMS", progress: 100, date: "2025-03-02", result: "Passed" }],
        freshness: { "BS-1001": { asOf: "2026-10-13T00:00:00Z", stale: false } },
      })),
    },
    audit: { recordActivityExport: audit },
  };
  return deps;
}

const reads = (deps: ReturnType<typeof fakeDeps>) => [
  ...[deps.attendance.listFor, deps.interviews.listFor, deps.training.listFor, deps.training.currentFor].map(fn => fn.mock.calls.length),
  ...recordReads(deps),
];
const NO_READS = [0, 0, 0, 0, 0, 0, 0, 0];

describe("exportActivity", () => {
  it("exports a month: rows of all four types in the period, the filename, and one audit row after every read", async () => {
    const deps = fakeDeps();
    const order: string[] = [];
    deps.training.currentFor.mockImplementationOnce(async (...args) => { order.push("read"); return fakeDeps().training.currentFor(...(args as [])); });
    deps.audit.recordActivityExport.mockImplementationOnce(async () => { order.push("audit"); });
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "month", month: "9", year: "2026" }, now);

    expect(result.filename).toBe("activity-BS-1001-2026-09-01_to_2026-09-30.csv");
    const lines = result.csv.split("\r\n");
    expect(lines[0]).toBe('﻿"employee_id","employee_name","date","type","title","details","status"');
    expect(lines.slice(1).map(l => l.split('","').slice(2, 4))).toEqual([
      ["2026-09-02", "attendance"], ["2026-09-15", "interview"], ["2026-09-20", "training"], ["2026-09-28", "enrolment"],
    ]);
    expect(lines[2]).toContain('"\'=HYPERLINK(""http://x"") — QA"');
    expect(deps.audit.recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2026-09-01", to: "2026-09-30" });
    expect(order).toEqual(["read", "audit"]);
    // Every source is read through its store with the Administrator's session.
    expect(deps.employees.getFor).toHaveBeenCalledWith(admin, "BS-1001");
    expect(deps.attendance.listFor).toHaveBeenCalledWith(admin, "BS-1001");
    expect(deps.interviews.listFor).toHaveBeenCalledWith(admin, "BS-1001");
    expect(deps.training.listFor).toHaveBeenCalledWith(admin, "BS-1001");
    expect(deps.training.currentFor).toHaveBeenCalledWith(admin, ["BS-1001"]);
  });

  it("resolves this week and last week from today in Dhaka", async () => {
    const deps = fakeDeps();
    // 2026-10-13T20:00Z is already Wednesday 14 Oct in Dhaka.
    const wednesday = new Date("2026-10-13T20:00:00Z");
    expect((await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "this-week" }, wednesday)).filename)
      .toBe("activity-BS-1001-2026-10-12_to_2026-10-18.csv");
    expect((await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "last-week" }, new Date("2026-10-12T06:00:00Z"))).filename)
      .toBe("activity-BS-1001-2026-10-05_to_2026-10-11.csv");
  });

  it.each([
    ["the employee's own freshness", { status: "ok", asOf: "2026-10-13T00:00:00Z", stale: false, freshness: { "BS-1001": { asOf: "2026-09-29T20:00:00Z", stale: true } } }],
    ["the aggregate when the employee has no freshness entry", { status: "ok", asOf: "2026-09-29T20:00:00Z", stale: true, freshness: {} }],
  ] as const)("notes stale LMS data on enrolment rows from %s", async (_name, lms) => {
    const deps = fakeDeps();
    deps.training.currentFor.mockResolvedValue({
      ...lms, freshness: { ...lms.freshness },
      inProgress: [{ id: "e1", employeeId: "BS-1001", name: "Leadership", provider: "LMS", progress: 40, date: "2026-09-28", result: "In progress" }],
      lmsCompleted: [],
    });
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "month", month: "9", year: "2026" }, now);
    const row = result.csv.split("\r\n").find(line => line.includes('"enrolment"'));
    // 2026-09-29T20:00Z is 30 Sep 2026 in Dhaka.
    expect(row).toBe('"BS-1001","Nadia Rahman","2026-09-28","enrolment","Leadership","Provider: LMS, progress 40%; LMS data as of 30 Sep 2026 (may be out of date)","In progress"');
  });

  it("returns a header-only CSV for an empty period, still audited", async () => {
    const deps = fakeDeps();
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "year", year: "2024" }, now);
    expect(result.csv).toBe('﻿"employee_id","employee_name","date","type","title","details","status"');
    expect(deps.audit.recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2024-01-01", to: "2024-12-31" });
  });

  it("resolves all time to the first and last record dates", async () => {
    const deps = fakeDeps();
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now);
    expect(result.filename).toBe("activity-BS-1001-2025-03-02_to_2026-10-01.csv");
    expect(result.csv.split("\r\n")).toHaveLength(7);
    expect(deps.audit.recordActivityExport).toHaveBeenCalledWith({ actorId, employeeId: "BS-1001", from: "2025-03-02", to: "2026-10-01" });
  });

  it("resolves all time with no records to today, header only", async () => {
    const deps = fakeDeps();
    deps.attendance.listFor.mockResolvedValue([]);
    deps.interviews.listFor.mockResolvedValue([]);
    deps.training.listFor.mockResolvedValue([]);
    deps.training.currentFor.mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now);
    expect(result.filename).toBe("activity-BS-1001-2026-10-13_to_2026-10-13.csv");
    expect(result.csv.split("\r\n")).toHaveLength(1);
  });

  it.each([
    [{ period: "custom", from: "2026-10-05", to: "2026-10-01" }, "The end date cannot be before the start date."],
    [{ period: "custom", from: "2026-10-01", to: "2026-10-14" }, "The end date cannot be in the future."],
    [{ period: "custom", from: "not-a-date", to: "2026-10-01" }, "Enter a valid start date."],
    [{ period: "custom", from: "2026-10-01" }, "Enter a valid start and end date."],
    [{ period: "month", month: "13", year: "2026" }, "Choose a month and a year."],
    [{ period: "month", year: "2026" }, "Choose a month and a year."],
    [{ period: "year", year: "26" }, "Choose a year."],
    [{ period: "forever" }, "Choose a period."],
    [{}, "Choose a period."],
  ])("rejects %j inline: no reads, no CSV, no audit", async (fields, message) => {
    const deps = fakeDeps();
    const error = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", ...fields }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityValidationError);
    expect(error.message).toBe(message);
    expect(deps.employees.getFor).not.toHaveBeenCalled();
    expect(reads(deps)).toEqual(NO_READS);
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it.each([["BS-12"], [""], [undefined]])("rejects a malformed employee id %j", async employeeId => {
    const deps = fakeDeps();
    await expect(exportActivity(deps, admin, actorId, { employeeId, period: "all" }, now)).rejects.toThrow(UNKNOWN_EMPLOYEE);
    expect(deps.employees.getFor).not.toHaveBeenCalled();
  });

  it("rejects an unknown employee: no source reads, no audit", async () => {
    const deps = fakeDeps();
    await expect(exportActivity(deps, admin, actorId, { employeeId: "BS-1999", period: "all" }, now)).rejects.toBeInstanceOf(ActivityEmployeeNotFoundError);
    expect(reads(deps)).toEqual(NO_READS);
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it("rejects a Staff session before anything is read", async () => {
    const deps = fakeDeps();
    await expect(exportActivity(deps, { role: "staff", employeeId: "BS-1001" }, actorId, { employeeId: "BS-1001", period: "all" }, now))
      .rejects.toBeInstanceOf(ActivityForbiddenError);
    expect(deps.employees.getFor).not.toHaveBeenCalled();
    expect(reads(deps)).toEqual(NO_READS);
  });

  it.each([
    ["employees", (d: ReturnType<typeof fakeDeps>) => d.employees.getFor.mockRejectedValue(new EmployeesUnavailableError())],
    ["attendance", (d: ReturnType<typeof fakeDeps>) => d.attendance.listFor.mockRejectedValue(new AttendanceUnavailableError())],
    ["interviews", (d: ReturnType<typeof fakeDeps>) => d.interviews.listFor.mockRejectedValue(new InterviewsUnavailableError())],
    ["training", (d: ReturnType<typeof fakeDeps>) => d.training.listFor.mockRejectedValue(new TrainingUnavailableError())],
    ["LMS", (d: ReturnType<typeof fakeDeps>) => d.training.currentFor.mockResolvedValue({ status: "unavailable" } as never)],
  ])("fails as a whole when %s is unavailable: no CSV, no audit", async (_name, breakSource) => {
    const deps = fakeDeps();
    breakSource(deps);
    const error = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityUnavailableError);
    expect(error.message).toBe(UNAVAILABLE);
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it("returns no CSV when the audit write fails", async () => {
    const deps = fakeDeps();
    deps.audit.recordActivityExport.mockRejectedValue(new AuditUnavailableError());
    await expect(exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now)).rejects.toBeInstanceOf(ActivityUnavailableError);
  });

  it("maps an employee removed before the audit write to unknown employee", async () => {
    const deps = fakeDeps();
    deps.audit.recordActivityExport.mockRejectedValue(new AuditEmployeeNotFoundError());
    await expect(exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now)).rejects.toBeInstanceOf(ActivityEmployeeNotFoundError);
  });

  it("maps errors to inline messages, anything unexpected to unavailable", () => {
    expect(activityErrorMessage(new ActivityForbiddenError())).toBe(NOT_ALLOWED);
    expect(activityErrorMessage(new ActivityEmployeeNotFoundError())).toBe(UNKNOWN_EMPLOYEE);
    expect(activityErrorMessage(new ActivityValidationError("Choose a year."))).toBe("Choose a year.");
    expect(activityErrorMessage(new TypeError("boom"))).toBe(UNAVAILABLE);
  });
});

/** The four Story 8.4 stores spied empty, so the actions never reach the (mocked) user client. */
function spyRecordStores() {
  return [
    vi.spyOn(assignmentsStore, "listFor").mockResolvedValue([]),
    vi.spyOn(backfilledProjectStore, "listFor").mockResolvedValue([]),
    vi.spyOn(assignmentEvaluationsStore, "listFor").mockResolvedValue([]),
    vi.spyOn(leaveStore, "listFor").mockResolvedValue([]),
  ];
}

describe("exportActivityAction", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const spies: { mockRestore(): void }[] = [];

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getActor.mockResolvedValue({ identity: admin, userId: actorId });
    recordActivityExport.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(
      ...spyRecordStores(),
      vi.spyOn(employeesStore, "getFor").mockResolvedValue(nadia),
      vi.spyOn(attendanceStore, "listFor").mockResolvedValue([entry("2026-09-02")]),
      vi.spyOn(interviewsStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "currentFor").mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} }),
    );
  });
  afterEach(() => {
    errorSpy.mockRestore();
    while (spies.length) spies.pop()!.mockRestore();
  });

  it.each([[{ identity: { role: "staff", employeeId: "BS-1001" }, userId: actorId }], [null]])("rejects actor %j with no reads and no CSV", async actor => {
    getActor.mockResolvedValue(actor);
    const result = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all" }));
    expect(result).toEqual({ error: "Only an Administrator or a department manager can export activity.", message: "" });
    expect(employeesStore.getFor).not.toHaveBeenCalled();
    expect(attendanceStore.listFor).not.toHaveBeenCalled();
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(recordActivityExport).not.toHaveBeenCalled();
  });

  it("returns the CSV and filename, auditing the session's user (never a form field) as the actor", async () => {
    const result = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all", actorId: "someone-else" }));
    expect(result).toMatchObject({ error: "", filename: "activity-BS-1001-2026-09-02_to_2026-09-02.csv" });
    expect(result.csv).toMatch(/^﻿"employee_id"/);
    expect(createAuditStore).toHaveBeenCalledWith(getServiceClient);
    expect(recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2026-09-02", to: "2026-09-02" });
  });

  it("shows the unavailable message and no CSV when a source is down", async () => {
    vi.mocked(attendanceStore.listFor).mockRejectedValue(new AttendanceUnavailableError());
    const result = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all" }));
    expect(result).toEqual({ error: UNAVAILABLE, message: "" });
    expect(recordActivityExport).not.toHaveBeenCalled();
  });

  it("shows the unavailable message and no CSV when the audit write fails", async () => {
    recordActivityExport.mockRejectedValue(new AuditUnavailableError());
    const result = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all" }));
    expect(result).toEqual({ error: UNAVAILABLE, message: "" });
  });

  it("shows validation and unknown-employee messages inline", async () => {
    expect(await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "custom", from: "2026-10-05", to: "2026-10-01" })))
      .toEqual({ error: "The end date cannot be before the start date.", message: "" });
    vi.mocked(employeesStore.getFor).mockResolvedValue(null);
    expect(await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1999", period: "all" })))
      .toEqual({ error: UNKNOWN_EMPLOYEE, message: "" });
    expect(recordActivityExport).not.toHaveBeenCalled();
  });
});

// ---- Story 8.2: bulk export of every employee ----

const HEADER = '﻿"employee_id","employee_name","date","type","title","details","status"';

const person = (id: string, name: string, archived: boolean, extra: Partial<Employee> = {}) =>
  ({ id, name, archived, interviews: [], training: [], ...extra }) as unknown as Employee;

const attendanceOf = (employeeId: string, date: string): TimesheetEntry => ({ ...entry(date), id: `a-${employeeId}-${date}`, employeeId });

function fakeBulkDeps() {
  // Listed out of id order on purpose: the export sorts by employee id.
  const list = [
    person("BS-1002", "Rafiq Hasan", false, {
      interviews: [{ id: "i2", company: "Orbit", role: "QA", date: "2026-09-10", stage: "Screening", outcome: "", feedback: "", withdrawn: false }],
    }),
    person("BS-1001", "Nadia Rahman", false, {
      training: [{ id: "t1", name: "React", provider: "Udemy", progress: 100, date: "2026-09-20", result: "Passed" }],
    }),
    person("BS-1003", "Archived Person", true, {
      training: [{ id: "t3", name: "Old course", provider: "LMS", progress: 100, date: "2025-01-03", result: "Passed" }],
    }),
  ];
  const deps = {
    ...fakeRecordStores(),
    employees: { listFor: vi.fn(async () => list.map(e => ({ ...e }))) },
    attendance: {
      listAll: vi.fn(async () => [
        attendanceOf("BS-1002", "2026-09-03"), attendanceOf("BS-1001", "2026-09-25"), attendanceOf("BS-1001", "2026-09-02"),
        attendanceOf("BS-1003", "2026-09-04"), attendanceOf("BS-1001", "2026-10-10"),
      ]),
    },
    training: {
      currentFor: vi.fn(async (_s: unknown, ids: string[]): Promise<CurrentTraining> => ({
        status: "ok" as const, asOf: "2026-10-13T00:00:00Z", stale: false,
        inProgress: [
          { id: "e1", employeeId: "BS-1001", name: "Leadership", provider: "LMS", progress: 40, date: "2026-09-28", result: "In progress" },
          { id: "e3", employeeId: "BS-1003", name: "Archived course", provider: "LMS", progress: 10, date: "2026-09-29", result: "In progress" },
        ].filter(e => ids.includes(e.employeeId)),
        lmsCompleted: [],
        freshness: Object.fromEntries(ids.map(id => [id, { asOf: "2026-10-13T00:00:00Z", stale: id === "BS-1002" }])),
      })),
    },
    audit: { recordBulkActivityExport: vi.fn(async () => {}), recordDepartmentActivityExport: vi.fn(async () => {}) },
    scope: { forManager: vi.fn(async (): Promise<ManagerScopeSet> => ({ departmentIds: new Set(), employeeIds: new Set() })) },
  };
  return deps;
}

const bulkReads = (deps: ReturnType<typeof fakeBulkDeps>) => [
  ...[deps.employees.listFor, deps.attendance.listAll, deps.training.currentFor].map(fn => fn.mock.calls.length),
  ...recordReads(deps),
];
const NO_BULK_READS = [0, 0, 0, 0, 0, 0, 0];

/** [employee_id, date, type] of each data row. */
const cells = (csv: string) => csv.split("\r\n").slice(1).map(l => l.slice(1, -1).split('","')).map(c => [c[0], c[2], c[3]]);

describe("exportAllActivity", () => {
  it("exports the active employees only, by employee id then date, with the bulk filename and one audit row", async () => {
    const deps = fakeBulkDeps();
    const order: string[] = [];
    deps.attendance.listAll.mockImplementationOnce(async () => { order.push("read"); return fakeBulkDeps().attendance.listAll(); });
    deps.audit.recordBulkActivityExport.mockImplementationOnce(async () => { order.push("audit"); });
    const result = await exportAllActivity(deps, admin, actorId, { period: "month", month: "9", year: "2026" }, now);

    expect(result.filename).toBe("activity-all-employees-2026-09-01_to_2026-09-30.csv");
    expect(result.csv.split("\r\n")[0]).toBe(HEADER);
    expect(cells(result.csv)).toEqual([
      ["BS-1001", "2026-09-02", "attendance"], ["BS-1001", "2026-09-20", "training"], ["BS-1001", "2026-09-25", "attendance"],
      ["BS-1001", "2026-09-28", "enrolment"],
      ["BS-1002", "2026-09-03", "attendance"], ["BS-1002", "2026-09-10", "interview"],
    ]);
    expect(deps.audit.recordBulkActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, includeArchived: false, from: "2026-09-01", to: "2026-09-30" });
    expect(order).toEqual(["read", "audit"]);
    // Each source is read once for the whole export, with the Administrator's session; the LMS only for the included employees.
    expect(bulkReads(deps)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(deps.employees.listFor).toHaveBeenCalledWith(admin);
    expect(deps.training.currentFor).toHaveBeenCalledWith(admin, ["BS-1001", "BS-1002"]);
  });

  it("includes archived employees and their rows when asked, auditing all-employees+archived", async () => {
    const deps = fakeBulkDeps();
    const result = await exportAllActivity(deps, admin, actorId, { period: "month", month: "9", year: "2026", includeArchived: "on" }, now);
    expect(cells(result.csv).filter(c => c[0] === "BS-1003")).toEqual([["BS-1003", "2026-09-04", "attendance"], ["BS-1003", "2026-09-29", "enrolment"]]);
    expect(cells(result.csv).map(c => c[0])).toEqual([...cells(result.csv).map(c => c[0])].sort());
    expect(deps.training.currentFor).toHaveBeenCalledWith(admin, ["BS-1001", "BS-1002", "BS-1003"]);
    expect(deps.audit.recordBulkActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, includeArchived: true, from: "2026-09-01", to: "2026-09-30" });
  });

  it("uses each employee's own LMS freshness on their enrolment rows", async () => {
    const deps = fakeBulkDeps();
    deps.training.currentFor.mockImplementationOnce(async () => ({
      status: "ok", asOf: "2026-09-29T20:00:00Z", stale: true, lmsCompleted: [],
      inProgress: [{ id: "e1", employeeId: "BS-1001", name: "Leadership", provider: "LMS", progress: 40, date: "2026-09-28", result: "In progress" }],
      freshness: { "BS-1001": { asOf: "2026-10-13T00:00:00Z", stale: false }, "BS-1002": { asOf: "2026-09-29T20:00:00Z", stale: true } },
    }));
    const result = await exportAllActivity(deps, admin, actorId, { period: "month", month: "9", year: "2026" }, now);
    expect(result.csv).toContain('"BS-1001","Nadia Rahman","2026-09-28","enrolment","Leadership","Provider: LMS, progress 40%","In progress"');
  });

  it("spans all time across the included employees only", async () => {
    const deps = fakeBulkDeps();
    const active = await exportAllActivity(deps, admin, actorId, { period: "all" }, now);
    // BS-1003's 2025-01-03 training is ignored while archived employees are excluded.
    expect(active.filename).toBe("activity-all-employees-2026-09-02_to_2026-10-10.csv");
    expect(cells(active.csv)).toHaveLength(7);
    const withArchived = await exportAllActivity(fakeBulkDeps(), admin, actorId, { period: "all", includeArchived: "on" }, now);
    expect(withArchived.filename).toBe("activity-all-employees-2025-01-03_to_2026-10-10.csv");
    expect(cells(withArchived.csv)[0]).toEqual(["BS-1001", "2026-09-02", "attendance"]);
  });

  it("resolves all time with no records to today, header only, still audited", async () => {
    const deps = fakeBulkDeps();
    deps.employees.listFor.mockResolvedValue([person("BS-1001", "Nadia Rahman", false)]);
    deps.attendance.listAll.mockResolvedValue([]);
    deps.training.currentFor.mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
    const result = await exportAllActivity(deps, admin, actorId, { period: "all" }, now);
    expect(result.filename).toBe("activity-all-employees-2026-10-13_to_2026-10-13.csv");
    expect(result.csv).toBe(HEADER);
    expect(deps.audit.recordBulkActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, includeArchived: false, from: "2026-10-13", to: "2026-10-13" });
  });

  it("uses every row a store returns, beyond one PostgREST page", async () => {
    const deps = fakeBulkDeps();
    const days = Array.from({ length: 2003 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
    deps.attendance.listAll.mockResolvedValue(days.map(d => attendanceOf("BS-1001", d)));
    deps.employees.listFor.mockResolvedValue([person("BS-1001", "Nadia Rahman", false)]);
    deps.training.currentFor.mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
    const result = await exportAllActivity(deps, admin, actorId, { period: "all" }, now);
    expect(cells(result.csv)).toHaveLength(2003);
  });

  it.each([
    [{ period: "custom", from: "2026-10-05", to: "2026-10-01" }, "The end date cannot be before the start date."],
    [{ period: "custom", from: "2026-10-01", to: "2026-10-14" }, "The end date cannot be in the future."],
    [{ period: "custom", from: "nope", to: "2026-10-01" }, "Enter a valid start date."],
    [{ period: "month", month: "13", year: "2026" }, "Choose a month and a year."],
    [{ period: "forever" }, "Choose a period."],
    [{ period: "all", includeArchived: "yes" }, "Choose whether to include archived employees."],
  ])("rejects %j inline: no reads, no CSV, no audit", async (fields, message) => {
    const deps = fakeBulkDeps();
    const error = await exportAllActivity(deps, admin, actorId, fields, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityValidationError);
    expect(error.message).toBe(message);
    expect(bulkReads(deps)).toEqual(NO_BULK_READS);
    expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it("rejects a Staff session before anything is read", async () => {
    const deps = fakeBulkDeps();
    await expect(exportAllActivity(deps, { role: "staff", employeeId: "BS-1001" }, actorId, { period: "all" }, now))
      .rejects.toBeInstanceOf(ActivityForbiddenError);
    expect(bulkReads(deps)).toEqual(NO_BULK_READS);
  });

  it.each([
    ["employees", (d: ReturnType<typeof fakeBulkDeps>) => d.employees.listFor.mockRejectedValue(new EmployeesUnavailableError())],
    ["attendance", (d: ReturnType<typeof fakeBulkDeps>) => d.attendance.listAll.mockRejectedValue(new AttendanceUnavailableError())],
    ["LMS", (d: ReturnType<typeof fakeBulkDeps>) => d.training.currentFor.mockResolvedValue({ status: "unavailable" } as never)],
    ["the LMS dedupe read (currentFor throws)", (d: ReturnType<typeof fakeBulkDeps>) => d.training.currentFor.mockRejectedValue(new TrainingUnavailableError())],
    ["stored training history (employees read)", (d: ReturnType<typeof fakeBulkDeps>) =>
      d.employees.listFor.mockRejectedValue(new EmployeesUnavailableError({ cause: new TrainingUnavailableError() }))],
  ])("fails as a whole when %s is unavailable: no CSV, no audit", async (_name, breakSource) => {
    const deps = fakeBulkDeps();
    breakSource(deps);
    const error = await exportAllActivity(deps, admin, actorId, { period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityUnavailableError);
    expect(error.message).toBe(UNAVAILABLE);
    expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it.each([[new AuditUnavailableError()], [new AuditValidationError(["to"])]])("returns no CSV when the audit write fails (%s)", async failure => {
    const deps = fakeBulkDeps();
    deps.audit.recordBulkActivityExport.mockRejectedValue(failure);
    await expect(exportAllActivity(deps, admin, actorId, { period: "all" }, now)).rejects.toBeInstanceOf(ActivityUnavailableError);
  });
});

describe("exportAllActivityAction", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const spies: { mockRestore(): void }[] = [];

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getActor.mockResolvedValue({ identity: admin, userId: actorId });
    recordBulkActivityExport.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(
      ...spyRecordStores(),
      vi.spyOn(employeesStore, "listFor").mockResolvedValue([person("BS-1001", "Nadia Rahman", false), person("BS-1003", "Archived Person", true)]),
      vi.spyOn(attendanceStore, "listAll").mockResolvedValue([attendanceOf("BS-1001", "2026-09-02"), attendanceOf("BS-1003", "2026-08-01")]),
      vi.spyOn(trainingStore, "currentFor").mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} }),
    );
  });
  afterEach(() => {
    errorSpy.mockRestore();
    while (spies.length) spies.pop()!.mockRestore();
  });

  it.each([[{ identity: { role: "staff", employeeId: "BS-1001" }, userId: actorId }], [null]])("rejects actor %j with no reads and no CSV", async actor => {
    getActor.mockResolvedValue(actor);
    const result = await exportAllActivityAction({ error: "", message: "" }, form({ period: "all" }));
    expect(result).toEqual({ error: "Only an Administrator or a department manager can export activity.", message: "" });
    expect(employeesStore.listFor).not.toHaveBeenCalled();
    expect(attendanceStore.listAll).not.toHaveBeenCalled();
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it("returns the CSV and filename, auditing the session's user as the actor", async () => {
    const result = await exportAllActivityAction({ error: "", message: "" }, form({ period: "all", actorId: "someone-else" }));
    expect(result).toMatchObject({ error: "", filename: "activity-all-employees-2026-09-02_to_2026-09-02.csv" });
    expect(result.csv).toMatch(/^﻿"employee_id"/);
    expect(createAuditStore).toHaveBeenCalledWith(getServiceClient);
    expect(recordBulkActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, includeArchived: false, from: "2026-09-02", to: "2026-09-02" });
  });

  it("passes the Include archived checkbox through", async () => {
    const result = await exportAllActivityAction({ error: "", message: "" }, form({ period: "all", includeArchived: "on" }));
    expect(result.filename).toBe("activity-all-employees-2026-08-01_to_2026-09-02.csv");
    expect(recordBulkActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, includeArchived: true, from: "2026-08-01", to: "2026-09-02" });
  });

  it("shows the unavailable message and no CSV when a source or the audit fails", async () => {
    vi.mocked(attendanceStore.listAll).mockRejectedValueOnce(new AttendanceUnavailableError());
    expect(await exportAllActivityAction({ error: "", message: "" }, form({ period: "all" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(recordBulkActivityExport).not.toHaveBeenCalled();
    recordBulkActivityExport.mockRejectedValue(new AuditUnavailableError());
    expect(await exportAllActivityAction({ error: "", message: "" }, form({ period: "all" }))).toEqual({ error: UNAVAILABLE, message: "" });
  });

  it("shows validation messages inline", async () => {
    expect(await exportAllActivityAction({ error: "", message: "" }, form({ period: "custom", from: "2026-10-05", to: "2026-10-01" })))
      .toEqual({ error: "The end date cannot be before the start date.", message: "" });
    expect(employeesStore.listFor).not.toHaveBeenCalled();
    expect(recordBulkActivityExport).not.toHaveBeenCalled();
  });
});

// ---- Story 8.3: department managers export within their department subtree ----

const manager = { role: "manager", employeeId: "BS-1009", userId: actorId } as const;
const DEPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const DEPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const subtree = (employeeIds: string[], departmentIds = [DEPT_B, DEPT_A]): ManagerScopeSet =>
  ({ departmentIds: new Set(departmentIds), employeeIds: new Set(employeeIds) });

describe("exportActivity for a department manager", () => {
  it("exports an in-subtree employee: attendance, training and enrolments, never interviews; audited against the employee", async () => {
    const deps = fakeDeps();
    const result = await exportActivity(deps, manager, actorId, { employeeId: "BS-1001", period: "month", month: "9", year: "2026" }, now);

    expect(result.filename).toBe("activity-BS-1001-2026-09-01_to_2026-09-30.csv");
    expect(result.csv.split("\r\n")[0]).toBe(HEADER);
    expect(cells(result.csv)).toEqual([
      ["BS-1001", "2026-09-02", "attendance"], ["BS-1001", "2026-09-20", "training"], ["BS-1001", "2026-09-28", "enrolment"],
    ]);
    expect(result.csv).not.toContain('"interview"');
    // The fake interviews store would return a row; it is not even asked.
    expect(deps.interviews.listFor).not.toHaveBeenCalled();
    expect(deps.employees.getFor).toHaveBeenCalledWith(manager, "BS-1001");
    expect(deps.attendance.listFor).toHaveBeenCalledWith(manager, "BS-1001");
    expect(deps.training.listFor).toHaveBeenCalledWith(manager, "BS-1001");
    expect(deps.training.currentFor).toHaveBeenCalledWith(manager, ["BS-1001"]);
    expect(deps.audit.recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2026-09-01", to: "2026-09-30" });
  });

  it.each([["outside the subtree", "BS-1002"], ["unknown", "BS-1999"]])("refuses an employee %s with the scope message: no other read, no audit", async (_name, employeeId) => {
    const deps = fakeDeps();
    deps.employees.getFor.mockResolvedValue(null);
    const error = await exportActivity(deps, manager, actorId, { employeeId, period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityForbiddenError);
    expect(error.message).toBe(OUT_OF_SCOPE);
    expect(activityErrorMessage(error)).toBe(OUT_OF_SCOPE);
    expect(reads(deps)).toEqual(NO_READS);
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it("validates the period before reading anything", async () => {
    const deps = fakeDeps();
    const error = await exportActivity(deps, manager, actorId, { employeeId: "BS-1001", period: "custom", from: "2026-10-05", to: "2026-10-01" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityValidationError);
    expect(deps.employees.getFor).not.toHaveBeenCalled();
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it.each([
    ["the scope (employees read)", (d: ReturnType<typeof fakeDeps>) => d.employees.getFor.mockRejectedValue(new EmployeesUnavailableError({ cause: new ManagerScopeUnavailableError() }))],
    ["attendance", (d: ReturnType<typeof fakeDeps>) => d.attendance.listFor.mockRejectedValue(new AttendanceUnavailableError())],
    ["training", (d: ReturnType<typeof fakeDeps>) => d.training.listFor.mockRejectedValue(new TrainingUnavailableError())],
    ["LMS", (d: ReturnType<typeof fakeDeps>) => d.training.currentFor.mockResolvedValue({ status: "unavailable" } as never)],
    ["the audit log", (d: ReturnType<typeof fakeDeps>) => d.audit.recordActivityExport.mockRejectedValue(new AuditUnavailableError())],
  ])("fails as a whole when %s is unavailable", async (_name, breakSource) => {
    const deps = fakeDeps();
    breakSource(deps);
    const error = await exportActivity(deps, manager, actorId, { employeeId: "BS-1001", period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityUnavailableError);
    expect(error.message).toBe(UNAVAILABLE);
  });
});

/** Bulk deps for a manager whose subtree holds BS-1001, BS-1002 (active) and BS-1003 (archived). */
function fakeManagerBulkDeps() {
  const deps = fakeBulkDeps();
  deps.scope.forManager.mockResolvedValue(subtree(["BS-1001", "BS-1002", "BS-1003"]));
  return deps;
}

describe("exportAllActivity for a department manager", () => {
  it("exports the subtree's active employees without interviews, auditing the subtree's department ids", async () => {
    const deps = fakeManagerBulkDeps();
    const result = await exportAllActivity(deps, manager, actorId, { period: "month", month: "9", year: "2026" }, now);

    expect(result.filename).toBe("activity-all-employees-2026-09-01_to_2026-09-30.csv");
    expect(result.csv.split("\r\n")[0]).toBe(HEADER);
    // BS-1002's stored interview (returned by the fake store) is dropped; BS-1003 is archived.
    expect(cells(result.csv)).toEqual([
      ["BS-1001", "2026-09-02", "attendance"], ["BS-1001", "2026-09-20", "training"], ["BS-1001", "2026-09-25", "attendance"],
      ["BS-1001", "2026-09-28", "enrolment"],
      ["BS-1002", "2026-09-03", "attendance"],
    ]);
    expect(result.csv).not.toContain('"interview"');
    expect(deps.employees.listFor).toHaveBeenCalledWith(manager);
    expect(deps.scope.forManager).toHaveBeenCalledExactlyOnceWith(manager);
    expect(deps.training.currentFor).toHaveBeenCalledWith(manager, ["BS-1001", "BS-1002"]);
    expect(deps.audit.recordDepartmentActivityExport).toHaveBeenCalledExactlyOnceWith({
      actorId, departmentIds: [DEPT_A, DEPT_B], includeArchived: false, from: "2026-09-01", to: "2026-09-30",
    });
    expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it("includes the subtree's archived employees when asked", async () => {
    const deps = fakeManagerBulkDeps();
    const result = await exportAllActivity(deps, manager, actorId, { period: "month", month: "9", year: "2026", includeArchived: "on" }, now);
    expect(cells(result.csv).filter(c => c[0] === "BS-1003")).toEqual([["BS-1003", "2026-09-04", "attendance"], ["BS-1003", "2026-09-29", "enrolment"]]);
    expect(deps.audit.recordDepartmentActivityExport).toHaveBeenCalledExactlyOnceWith({
      actorId, departmentIds: [DEPT_A, DEPT_B], includeArchived: true, from: "2026-09-01", to: "2026-09-30",
    });
  });

  it("never includes an employee outside the scope, whatever the employee list returned", async () => {
    const deps = fakeBulkDeps();
    deps.scope.forManager.mockResolvedValue(subtree(["BS-1001"]));
    const result = await exportAllActivity(deps, manager, actorId, { period: "month", month: "9", year: "2026" }, now);
    expect(new Set(cells(result.csv).map(c => c[0]))).toEqual(new Set(["BS-1001"]));
    expect(deps.training.currentFor).toHaveBeenCalledWith(manager, ["BS-1001"]);
  });

  it("returns a header-only CSV for a subtree with no employees, still audited", async () => {
    const deps = fakeBulkDeps();
    deps.employees.listFor.mockResolvedValue([]);
    deps.scope.forManager.mockResolvedValue(subtree([], [DEPT_A]));
    deps.training.currentFor.mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
    const result = await exportAllActivity(deps, manager, actorId, { period: "last-week" }, now);
    expect(result.csv).toBe(HEADER);
    expect(deps.audit.recordDepartmentActivityExport).toHaveBeenCalledExactlyOnceWith({
      actorId, departmentIds: [DEPT_A], includeArchived: false, from: "2026-10-05", to: "2026-10-11",
    });
  });

  it("refuses a manager whose scope has no departments with the scope message: no CSV, no audit", async () => {
    const deps = fakeBulkDeps();
    deps.employees.listFor.mockResolvedValue([]);
    deps.scope.forManager.mockResolvedValue(subtree([], []));
    deps.training.currentFor.mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
    const error = await exportAllActivity(deps, manager, actorId, { period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityForbiddenError);
    expect(error.message).toBe(OUT_OF_SCOPE);
    expect(activityErrorMessage(error)).toBe(OUT_OF_SCOPE);
    expect(deps.audit.recordDepartmentActivityExport).not.toHaveBeenCalled();
    expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it("rejects a bad period before reading anything", async () => {
    const deps = fakeManagerBulkDeps();
    await expect(exportAllActivity(deps, manager, actorId, { period: "custom", from: "2026-10-01", to: "2026-10-14" }, now))
      .rejects.toBeInstanceOf(ActivityValidationError);
    expect(deps.scope.forManager).not.toHaveBeenCalled();
    expect(bulkReads(deps)).toEqual(NO_BULK_READS);
    expect(deps.audit.recordDepartmentActivityExport).not.toHaveBeenCalled();
  });

  it.each([
    ["the scope", (d: ReturnType<typeof fakeBulkDeps>) => d.scope.forManager.mockRejectedValue(new ManagerScopeUnavailableError())],
    ["employees", (d: ReturnType<typeof fakeBulkDeps>) => d.employees.listFor.mockRejectedValue(new EmployeesUnavailableError())],
    ["attendance", (d: ReturnType<typeof fakeBulkDeps>) => d.attendance.listAll.mockRejectedValue(new AttendanceUnavailableError())],
    ["LMS", (d: ReturnType<typeof fakeBulkDeps>) => d.training.currentFor.mockResolvedValue({ status: "unavailable" } as never)],
  ])("fails as a whole when %s is unavailable: no CSV, no audit", async (_name, breakSource) => {
    const deps = fakeManagerBulkDeps();
    breakSource(deps);
    const error = await exportAllActivity(deps, manager, actorId, { period: "all" }, now).catch(e => e);
    expect(error).toBeInstanceOf(ActivityUnavailableError);
    expect(error.message).toBe(UNAVAILABLE);
    expect(deps.audit.recordDepartmentActivityExport).not.toHaveBeenCalled();
    expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it.each([[new AuditUnavailableError()], [new AuditValidationError(["departmentIds"])]])("returns no CSV when the audit write fails (%s)", async failure => {
    const deps = fakeManagerBulkDeps();
    deps.audit.recordDepartmentActivityExport.mockRejectedValue(failure);
    await expect(exportAllActivity(deps, manager, actorId, { period: "all" }, now)).rejects.toBeInstanceOf(ActivityUnavailableError);
  });

  it("leaves the Administrator's bulk export unscoped: no scope read, interviews kept, all-employees audit", async () => {
    const deps = fakeBulkDeps();
    const result = await exportAllActivity(deps, admin, actorId, { period: "month", month: "9", year: "2026" }, now);
    expect(deps.scope.forManager).not.toHaveBeenCalled();
    expect(cells(result.csv)).toContainEqual(["BS-1002", "2026-09-10", "interview"]);
    expect(deps.audit.recordDepartmentActivityExport).not.toHaveBeenCalled();
    expect(deps.audit.recordBulkActivityExport).toHaveBeenCalledOnce();
  });
});

describe("activity export actions for a department manager", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const spies: { mockRestore(): void }[] = [];

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getActor.mockResolvedValue({ identity: manager, userId: actorId });
    recordActivityExport.mockResolvedValue(undefined);
    recordDepartmentActivityExport.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(
      ...spyRecordStores(),
      vi.spyOn(employeesStore, "getFor").mockResolvedValue(nadia),
      vi.spyOn(employeesStore, "listFor").mockResolvedValue([person("BS-1001", "Nadia Rahman", false, {
        interviews: [{ id: "i9", company: "Orbit", role: "QA", date: "2026-09-02", stage: "Screening", outcome: "", feedback: "", withdrawn: false }],
      } as Partial<Employee>)]),
      vi.spyOn(attendanceStore, "listFor").mockResolvedValue([entry("2026-09-02")]),
      vi.spyOn(attendanceStore, "listAll").mockResolvedValue([attendanceOf("BS-1001", "2026-09-02")]),
      vi.spyOn(interviewsStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "currentFor").mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} }),
      vi.spyOn(managerScope, "forManager").mockResolvedValue(subtree(["BS-1001"], [DEPT_A])),
    );
  });
  afterEach(() => {
    errorSpy.mockRestore();
    while (spies.length) spies.pop()!.mockRestore();
  });

  it("exports one in-subtree employee with the manager's session, never reading interviews", async () => {
    const result = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all" }));
    expect(result).toMatchObject({ error: "", filename: "activity-BS-1001-2026-09-02_to_2026-09-02.csv" });
    expect(employeesStore.getFor).toHaveBeenCalledWith(manager, "BS-1001");
    expect(attendanceStore.listFor).toHaveBeenCalledWith(manager, "BS-1001");
    expect(interviewsStore.listFor).not.toHaveBeenCalled();
    expect(recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2026-09-02", to: "2026-09-02" });
  });

  it("refuses an employee outside the subtree inline", async () => {
    vi.mocked(employeesStore.getFor).mockResolvedValue(null);
    expect(await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1002", period: "all" })))
      .toEqual({ error: OUT_OF_SCOPE, message: "" });
    expect(attendanceStore.listFor).not.toHaveBeenCalled();
    expect(recordActivityExport).not.toHaveBeenCalled();
  });

  it("bulk-exports the subtree without interviews and audits the departments", async () => {
    const result = await exportAllActivityAction({ error: "", message: "" }, form({ period: "all" }));
    expect(result).toMatchObject({ error: "", filename: "activity-all-employees-2026-09-02_to_2026-09-02.csv" });
    expect(result.csv).not.toContain('"interview"');
    expect(managerScope.forManager).toHaveBeenCalledWith(manager);
    expect(createAuditStore).toHaveBeenCalledWith(getServiceClient);
    expect(recordDepartmentActivityExport).toHaveBeenCalledExactlyOnceWith({
      actorId, departmentIds: [DEPT_A], includeArchived: false, from: "2026-09-02", to: "2026-09-02",
    });
    expect(recordBulkActivityExport).not.toHaveBeenCalled();
  });

  it("shows the unavailable message when the scope cannot be read", async () => {
    vi.mocked(managerScope.forManager).mockRejectedValue(new ManagerScopeUnavailableError());
    expect(await exportAllActivityAction({ error: "", message: "" }, form({ period: "all" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(recordDepartmentActivityExport).not.toHaveBeenCalled();
  });
});

// ---- Story 8.4: assignments, backfilled projects, evaluations and leave ----

const assignmentRecord = (employeeId: string, over: Partial<Assignment> = {}): Assignment => ({
  id: `as-${employeeId}`, employeeId, departmentId: DEPT_A, client: "Acme Bank", projectName: "Core banking", role: "Frontend lead",
  allocation: 100, startDate: "2026-09-01", latestUpdate: "", status: "open", completionDate: null, createdAt: "2026-09-01T03:00:00Z",
  closedAt: null, provenance: "assignment", ...over,
});

const backfilledRecord = (employeeId: string, over: Partial<BackfilledProject> = {}): BackfilledProject => ({
  id: `bf-${employeeId}`, employeeId, departmentId: DEPT_A, departmentName: "Engineering", client: "Old Co", projectName: "Legacy portal",
  completionDate: "2025-06-30", outcome: "Delivered", status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  withdrawnAt: null, provenance: "backfilled", ...over,
});

const evaluationRecord = (employeeId: string, over: Partial<AssignmentEvaluation> = {}): AssignmentEvaluation => ({
  id: `ev-${employeeId}`, assignmentId: `as-${employeeId}`, employeeId, departmentId: DEPT_A, evaluation: "Strong delivery",
  clientFeedback: "Would hire again", createdBy: "u1", createdByName: "Farhana Ahmed", createdByRole: "manager", createdAt: "2026-10-05T20:00:00Z",
  authoredBy: "u1", authoredByName: "Farhana Ahmed", authoredByRole: "manager", updatedAt: "2026-10-05T20:00:00Z", ...over,
});

const leaveRecord = (employeeId: string, over: Partial<LeaveRecord> = {}): LeaveRecord => ({
  id: `lv-${employeeId}`, employeeId, startDate: "2026-09-29", endDate: "2026-10-02", workingDays: 4, category: "FOUR_TO_FOURTEEN",
  calendarVersionId: "cal-1", cancelledAt: null, createdAt: "2026-09-20T00:00:00Z", ...over,
});

/** Fills the four stores with one record of each kind per employee id. */
function fillRecordStores(deps: ReturnType<typeof fakeRecordStores>, ids: string[]) {
  deps.assignments.listFor.mockResolvedValue(ids.map(id => assignmentRecord(id, { status: "closed", completionDate: "2026-10-03" })));
  deps.backfilledProjects.listFor.mockResolvedValue(ids.map(id => backfilledRecord(id)));
  deps.evaluations.listFor.mockResolvedValue(ids.map(id => evaluationRecord(id)));
  deps.leave.listFor.mockResolvedValue(ids.map(id => leaveRecord(id)));
}

/** [date, type, title, details, status] of each data row. */
const fullCells = (csv: string) => csv.split("\r\n").slice(1).map(l => l.slice(1, -1).split('","')).map(c => c.slice(2));

describe("exportActivity with assignments, evaluations and leave (Story 8.4)", () => {
  it("reads each new store with the session and the employee, and adds assignment, evaluation and leave rows", async () => {
    const deps = fakeDeps();
    fillRecordStores(deps, ["BS-1001"]);
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "month", month: "10", year: "2026" }, now);
    for (const fn of [deps.assignments.listFor, deps.backfilledProjects.listFor, deps.evaluations.listFor, deps.leave.listFor]) {
      expect(fn).toHaveBeenCalledExactlyOnceWith(admin, "BS-1001");
    }
    expect(fullCells(result.csv)).toEqual([
      ["2026-09-01", "assignment", "Core banking — Acme Bank", "Role: Frontend lead; start: 2026-09-01; end: 2026-10-03; provenance: assignment", "Closed"],
      ["2026-09-29", "leave", "4–14 working days", "From 2026-09-29 to 2026-10-02; 4 working days", "Recorded"],
      ["2026-10-01", "attendance", "Attendance", "Clock in 09:00, clock out 17:00, break 0 min, Office", "Completed"],
      ["2026-10-06", "evaluation", "Evaluation — Core banking (Acme Bank)", "Evaluator: Farhana Ahmed; outcome: Strong delivery; client feedback: Would hire again", "Written"],
    ]);
    expect(deps.audit.recordActivityExport).toHaveBeenCalledExactlyOnceWith({ actorId, employeeId: "BS-1001", from: "2026-10-01", to: "2026-10-31" });
  });

  it("includes backfilled past projects in their completion period, withdrawn ones as Withdrawn", async () => {
    const deps = fakeDeps();
    deps.backfilledProjects.listFor.mockResolvedValue([backfilledRecord("BS-1001"), backfilledRecord("BS-1001", { id: "bf2", projectName: "Kiosk", status: "withdrawn" })]);
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "year", year: "2025" }, now);
    expect(fullCells(result.csv).filter(c => c[1] === "assignment")).toEqual([
      ["2025-06-30", "assignment", "Kiosk — Old Co", "Self-reported past project; completed: 2025-06-30; outcome: Delivered; provenance: backfilled", "Withdrawn"],
      ["2025-06-30", "assignment", "Legacy portal — Old Co", "Self-reported past project; completed: 2025-06-30; outcome: Delivered; provenance: backfilled", "Self-reported"],
    ]);
  });

  it("drops any record of another employee a store returns", async () => {
    const deps = fakeDeps();
    fillRecordStores(deps, ["BS-1001", "BS-1002"]);
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "month", month: "10", year: "2026" }, now);
    expect(fullCells(result.csv).filter(c => c[1] !== "attendance")).toHaveLength(3);
  });

  it("gives a manager the client feedback too, but never interviews", async () => {
    const deps = fakeDeps();
    fillRecordStores(deps, ["BS-1001"]);
    const result = await exportActivity(deps, manager, actorId, { employeeId: "BS-1001", period: "month", month: "10", year: "2026" }, now);
    expect(result.csv).toContain("client feedback: Would hire again");
    expect(result.csv).not.toContain('"interview"');
    expect(deps.leave.listFor).toHaveBeenCalledWith(manager, "BS-1001");
  });

  it("spans all time across the new records too (an open assignment ends today)", async () => {
    const deps = fakeDeps();
    deps.leave.listFor.mockResolvedValue([leaveRecord("BS-1001", { startDate: "2024-03-10", endDate: "2024-03-12", workingDays: 3 })]);
    deps.assignments.listFor.mockResolvedValue([assignmentRecord("BS-1001")]);
    const result = await exportActivity(deps, admin, actorId, { employeeId: "BS-1001", period: "all" }, now);
    expect(result.filename).toBe("activity-BS-1001-2024-03-10_to_2026-10-13.csv");
  });

  it.each([
    ["assignments", (d: ReturnType<typeof fakeDeps>) => d.assignments.listFor.mockRejectedValue(new AssignmentsUnavailableError())],
    ["backfilled projects", (d: ReturnType<typeof fakeDeps>) => d.backfilledProjects.listFor.mockRejectedValue(new BackfillUnavailableError())],
    ["evaluations", (d: ReturnType<typeof fakeDeps>) => d.evaluations.listFor.mockRejectedValue(new EvaluationsUnavailableError())],
    ["leave", (d: ReturnType<typeof fakeDeps>) => d.leave.listFor.mockRejectedValue(new LeaveUnavailableError())],
  ])("fails as a whole when %s is unavailable: no CSV, no audit", async (_name, breakSource) => {
    for (const session of [admin, manager]) {
      const deps = fakeDeps();
      breakSource(deps);
      const error = await exportActivity(deps, session, actorId, { employeeId: "BS-1001", period: "all" }, now).catch(e => e);
      expect(error).toBeInstanceOf(ActivityUnavailableError);
      expect(error.message).toBe(UNAVAILABLE);
      expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
    }
  });
});

describe("exportAllActivity with assignments, evaluations and leave (Story 8.4)", () => {
  it("reads each new store once for the whole export with the session, grouped by employee", async () => {
    const deps = fakeBulkDeps();
    fillRecordStores(deps, ["BS-1002", "BS-1001", "BS-1003"]);
    const result = await exportAllActivity(deps, admin, actorId, { period: "month", month: "10", year: "2026" }, now);
    for (const fn of [deps.assignments.listFor, deps.backfilledProjects.listFor, deps.evaluations.listFor, deps.leave.listFor]) {
      expect(fn).toHaveBeenCalledExactlyOnceWith(admin);
    }
    // BS-1003 is archived and left out.
    expect(cells(result.csv)).toEqual([
      ["BS-1001", "2026-09-01", "assignment"], ["BS-1001", "2026-09-29", "leave"], ["BS-1001", "2026-10-06", "evaluation"],
      ["BS-1001", "2026-10-10", "attendance"],
      ["BS-1002", "2026-09-01", "assignment"], ["BS-1002", "2026-09-29", "leave"], ["BS-1002", "2026-10-06", "evaluation"],
    ]);
    expect(result.csv).toContain("client feedback: Would hire again");
  });

  it("spans all time across the new records of the included employees", async () => {
    const deps = fakeBulkDeps();
    deps.leave.listFor.mockResolvedValue([leaveRecord("BS-1002", { startDate: "2024-03-10", endDate: "2024-03-12", workingDays: 3 }), leaveRecord("BS-1003", { startDate: "2020-01-06", endDate: "2020-01-06", workingDays: 1 })]);
    const result = await exportAllActivity(deps, admin, actorId, { period: "all" }, now);
    expect(result.filename).toBe("activity-all-employees-2024-03-10_to_2026-10-10.csv");
  });

  it("gives a manager only the subtree's rows of the new types, with no interviews", async () => {
    const deps = fakeBulkDeps();
    deps.scope.forManager.mockResolvedValue(subtree(["BS-1001"]));
    fillRecordStores(deps, ["BS-1001", "BS-1002"]);
    const result = await exportAllActivity(deps, manager, actorId, { period: "month", month: "10", year: "2026" }, now);
    expect(new Set(cells(result.csv).map(c => c[0]))).toEqual(new Set(["BS-1001"]));
    expect(cells(result.csv).map(c => c[2])).toEqual(["assignment", "leave", "evaluation", "attendance"]);
    expect(result.csv).not.toContain('"interview"');
    expect(deps.evaluations.listFor).toHaveBeenCalledExactlyOnceWith(manager);
    expect(deps.audit.recordDepartmentActivityExport).toHaveBeenCalledOnce();
  });

  it.each([
    ["assignments", (d: ReturnType<typeof fakeBulkDeps>) => d.assignments.listFor.mockRejectedValue(new AssignmentsUnavailableError())],
    ["backfilled projects", (d: ReturnType<typeof fakeBulkDeps>) => d.backfilledProjects.listFor.mockRejectedValue(new BackfillUnavailableError())],
    ["evaluations", (d: ReturnType<typeof fakeBulkDeps>) => d.evaluations.listFor.mockRejectedValue(new EvaluationsUnavailableError())],
    ["leave", (d: ReturnType<typeof fakeBulkDeps>) => d.leave.listFor.mockRejectedValue(new LeaveUnavailableError())],
  ])("fails as a whole when %s is unavailable: no CSV, no audit", async (_name, breakSource) => {
    for (const session of [admin, manager]) {
      const deps = fakeManagerBulkDeps();
      breakSource(deps);
      const error = await exportAllActivity(deps, session, actorId, { period: "all" }, now).catch(e => e);
      expect(error).toBeInstanceOf(ActivityUnavailableError);
      expect(deps.audit.recordBulkActivityExport).not.toHaveBeenCalled();
      expect(deps.audit.recordDepartmentActivityExport).not.toHaveBeenCalled();
    }
  });
});

describe("activity export actions read the Story 8.4 stores", () => {
  const spies: { mockRestore(): void }[] = [];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getActor.mockResolvedValue({ identity: admin, userId: actorId });
    recordActivityExport.mockResolvedValue(undefined);
    recordBulkActivityExport.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(
      vi.spyOn(assignmentsStore, "listFor").mockResolvedValue([assignmentRecord("BS-1001")]),
      vi.spyOn(backfilledProjectStore, "listFor").mockResolvedValue([]),
      vi.spyOn(assignmentEvaluationsStore, "listFor").mockResolvedValue([]),
      vi.spyOn(leaveStore, "listFor").mockResolvedValue([leaveRecord("BS-1001")]),
      vi.spyOn(employeesStore, "getFor").mockResolvedValue(nadia),
      vi.spyOn(employeesStore, "listFor").mockResolvedValue([person("BS-1001", "Nadia Rahman", false)]),
      vi.spyOn(attendanceStore, "listFor").mockResolvedValue([]),
      vi.spyOn(attendanceStore, "listAll").mockResolvedValue([]),
      vi.spyOn(interviewsStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "listFor").mockResolvedValue([]),
      vi.spyOn(trainingStore, "currentFor").mockResolvedValue({ status: "ok", asOf: "", stale: false, inProgress: [], lmsCompleted: [], freshness: {} }),
    );
  });
  afterEach(() => {
    errorSpy.mockRestore();
    while (spies.length) spies.pop()!.mockRestore();
  });

  it("wires the real stores into the single and the bulk export", async () => {
    const single = await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "month", month: "10", year: "2026" }));
    expect(single.csv).toContain('"assignment"');
    expect(single.csv).toContain('"leave"');
    expect(leaveStore.listFor).toHaveBeenCalledWith(admin, "BS-1001");
    const bulk = await exportAllActivityAction({ error: "", message: "" }, form({ period: "month", month: "10", year: "2026" }));
    expect(bulk.csv).toContain('"leave"');
    expect(assignmentsStore.listFor).toHaveBeenCalledWith(admin);
  });

  it("shows the unavailable message when a new store is down", async () => {
    vi.mocked(leaveStore.listFor).mockRejectedValue(new LeaveUnavailableError());
    expect(await exportActivityAction({ error: "", message: "" }, form({ employeeId: "BS-1001", period: "all" }))).toEqual({ error: UNAVAILABLE, message: "" });
    expect(recordActivityExport).not.toHaveBeenCalled();
  });
});
