import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../src/data/employees";
import type { TimesheetEntry } from "../src/domain/timesheet";
import type { CurrentTraining } from "../src/server/training-store";

const { getActor, getServiceClient, recordActivityExport, createAuditStore } = vi.hoisted(() => {
  const recordActivityExport = vi.fn();
  return {
    getActor: vi.fn(),
    getServiceClient: vi.fn(() => ({ fake: "service client" })),
    recordActivityExport,
    createAuditStore: vi.fn(() => ({ recordActivityExport })),
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
  exportActivity, NOT_ADMIN, UNAVAILABLE, UNKNOWN_EMPLOYEE,
} = await import("../src/server/activity-export");
const { exportActivityAction } = await import("../src/server/activity-actions");
const { AttendanceUnavailableError, attendanceStore } = await import("../src/server/attendance-store");
const { InterviewsUnavailableError, interviewsStore } = await import("../src/server/interviews-store");
const { TrainingUnavailableError, trainingStore } = await import("../src/server/training-store");
const { EmployeesUnavailableError, employeesStore } = await import("../src/server/employees-store");
const { AuditEmployeeNotFoundError, AuditUnavailableError } = await import("../src/server/audit-store");

const admin = { role: "admin" } as const;
const actorId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-13T06:00:00Z"); // 13 Oct 2026 in Dhaka

const nadia = { id: "BS-1001", name: "Nadia Rahman" } as Employee;

const entry = (date: string): TimesheetEntry => ({
  id: `a-${date}`, employeeId: "BS-1001", date, clockIn: `${date}T03:00:00Z`, clockOut: `${date}T11:00:00Z`, breakMinutes: 0,
  workMode: "Office", log: null,
});

function fakeDeps() {
  const audit = vi.fn(async () => {});
  const deps = {
    employees: { getFor: vi.fn(async (_s: unknown, id: string) => (id === "BS-1001" ? nadia : null)) },
    attendance: { listForEmployee: vi.fn(async () => [entry("2026-09-02"), entry("2026-10-01")]) },
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
  deps.attendance.listForEmployee, deps.interviews.listFor, deps.training.listFor, deps.training.currentFor,
].map(fn => fn.mock.calls.length);

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
    expect(deps.attendance.listForEmployee).toHaveBeenCalledWith("BS-1001");
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
    deps.attendance.listForEmployee.mockResolvedValue([]);
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
    expect(reads(deps)).toEqual([0, 0, 0, 0]);
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
    expect(reads(deps)).toEqual([0, 0, 0, 0]);
    expect(deps.audit.recordActivityExport).not.toHaveBeenCalled();
  });

  it("rejects a Staff session before anything is read", async () => {
    const deps = fakeDeps();
    await expect(exportActivity(deps, { role: "staff", employeeId: "BS-1001" }, actorId, { employeeId: "BS-1001", period: "all" }, now))
      .rejects.toBeInstanceOf(ActivityForbiddenError);
    expect(deps.employees.getFor).not.toHaveBeenCalled();
    expect(reads(deps)).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["employees", (d: ReturnType<typeof fakeDeps>) => d.employees.getFor.mockRejectedValue(new EmployeesUnavailableError())],
    ["attendance", (d: ReturnType<typeof fakeDeps>) => d.attendance.listForEmployee.mockRejectedValue(new AttendanceUnavailableError())],
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
    expect(activityErrorMessage(new ActivityForbiddenError())).toBe(NOT_ADMIN);
    expect(activityErrorMessage(new ActivityEmployeeNotFoundError())).toBe(UNKNOWN_EMPLOYEE);
    expect(activityErrorMessage(new ActivityValidationError("Choose a year."))).toBe("Choose a year.");
    expect(activityErrorMessage(new TypeError("boom"))).toBe(UNAVAILABLE);
  });
});

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
      vi.spyOn(employeesStore, "getFor").mockResolvedValue(nadia),
      vi.spyOn(attendanceStore, "listForEmployee").mockResolvedValue([entry("2026-09-02")]),
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
    expect(result).toEqual({ error: "Only an Administrator can export activity.", message: "" });
    expect(employeesStore.getFor).not.toHaveBeenCalled();
    expect(attendanceStore.listForEmployee).not.toHaveBeenCalled();
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
    vi.mocked(attendanceStore.listForEmployee).mockRejectedValue(new AttendanceUnavailableError());
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
