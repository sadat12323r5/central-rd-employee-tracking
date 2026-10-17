import { describe, expect, it } from "vitest";
import {
  activityBulkFilename, activityFilename, ActivityPeriodError, buildTimeline, recordSpan, resolvePeriod, TIMELINE_HEADER, timelineCsv,
  type ActivityAssignment, type ActivityBackfilledProject, type ActivityEvaluation, type ActivityLeave, type ActivitySources, type ActivityTraining,
} from "../src/domain/activity";
import type { TimesheetEntry } from "../src/domain/timesheet";

const employee = { id: "BS-1001", name: "Nadia Rahman" };
const now = new Date("2026-10-13T06:00:00Z"); // 12:00 in Dhaka, 13 Oct 2026

function attendance(over: Partial<TimesheetEntry> = {}): TimesheetEntry {
  return {
    id: "a1", employeeId: "BS-1001", date: "2026-09-10", clockIn: "2026-09-10T03:05:00Z", clockOut: "2026-09-10T12:00:00Z",
    breakMinutes: 30, workMode: "Office", log: null, ...over,
  };
}

const interview = (over: Partial<ActivitySources["interviews"][number]> = {}) => ({
  company: "Northstar Labs", role: "Frontend Engineer", date: "2026-09-12", stage: "Technical", outcome: "Scheduled",
  feedback: "", withdrawn: false, ...over,
});

const course = (over: Partial<ActivityTraining> = {}): ActivityTraining => ({
  name: "React · practical foundations", provider: "Udemy", date: "2026-09-05", result: "Passed", progress: 100, ...over,
});

const empty = (): ActivitySources => ({
  attendance: [], interviews: [], training: [], enrolments: { entries: [], stale: false },
  assignments: [], backfilledProjects: [], evaluations: [], leave: [],
});

const assignment = (over: Partial<ActivityAssignment> = {}): ActivityAssignment => ({
  id: "as1", client: "Acme Bank", projectName: "Core banking", role: "Frontend lead", startDate: "2026-09-01", status: "open",
  completionDate: null, provenance: "assignment", ...over,
});

const pastProject = (over: Partial<ActivityBackfilledProject> = {}): ActivityBackfilledProject => ({
  client: "Old Co", projectName: "Legacy portal", completionDate: "2025-06-30", outcome: "Delivered on time", status: "active",
  provenance: "backfilled", ...over,
});

const evaluation = (over: Partial<ActivityEvaluation> = {}): ActivityEvaluation => ({
  assignmentId: "as1", evaluation: "Exceeded expectations", clientFeedback: "Great partner",
  createdBy: "u1", createdByName: "Farhana Ahmed", createdByRole: "manager", createdAt: "2026-10-05T20:00:00Z",
  authoredBy: "u1", authoredByName: "Farhana Ahmed", authoredByRole: "manager", updatedAt: "2026-10-05T20:00:00Z", ...over,
});

const leave = (over: Partial<ActivityLeave> = {}): ActivityLeave => ({
  startDate: "2026-09-29", endDate: "2026-10-02", workingDays: 4, cancelledAt: null, ...over,
});

const october = { from: "2026-10-01", to: "2026-10-31" };

describe("resolvePeriod", () => {
  it("resolves this week Monday to Sunday (today Wednesday 2026-10-14)", () => {
    expect(resolvePeriod({ period: "this-week" }, "2026-10-14")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });

  it("resolves this week when today is the Monday and when it is the Sunday", () => {
    expect(resolvePeriod({ period: "this-week" }, "2026-10-12")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(resolvePeriod({ period: "this-week" }, "2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });

  it("resolves last week Monday to Sunday (today Monday 2026-10-12)", () => {
    expect(resolvePeriod({ period: "last-week" }, "2026-10-12")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });

  it("resolves last week across a year boundary", () => {
    expect(resolvePeriod({ period: "last-week" }, "2026-01-01")).toEqual({ from: "2025-12-22", to: "2025-12-28" });
  });

  it("resolves a month, including February in leap and common years", () => {
    expect(resolvePeriod({ period: "month", year: 2026, month: 9 }, "2026-10-13")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolvePeriod({ period: "month", year: 2028, month: 2 }, "2026-10-13")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(resolvePeriod({ period: "month", year: 2026, month: 2 }, "2026-10-13")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePeriod({ period: "month", year: 2026, month: 12 }, "2026-10-13")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("resolves a year", () => {
    expect(resolvePeriod({ period: "year", year: 2025 }, "2026-10-13")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("resolves an inclusive custom range ending today", () => {
    expect(resolvePeriod({ period: "custom", from: "2026-10-01", to: "2026-10-13" }, "2026-10-13")).toEqual({ from: "2026-10-01", to: "2026-10-13" });
    expect(resolvePeriod({ period: "custom", from: "2026-10-13", to: "2026-10-13" }, "2026-10-13")).toEqual({ from: "2026-10-13", to: "2026-10-13" });
  });

  it.each([
    [{ period: "custom", from: "2026-10-05", to: "2026-10-01" }, "The end date cannot be before the start date."],
    [{ period: "custom", from: "2026-10-01", to: "2026-10-14" }, "The end date cannot be in the future."],
    [{ period: "custom", from: "2026-02-30", to: "2026-03-01" }, "Enter a valid start and end date."],
    [{ period: "custom", from: "yesterday", to: "2026-10-01" }, "Enter a valid start and end date."],
    [{ period: "month", year: 2026, month: 13 }, "Choose a month and a year."],
    [{ period: "year", year: 0 }, "Choose a year."],
  ] as const)("rejects %j with ActivityPeriodError", (input, message) => {
    expect(() => resolvePeriod(input, "2026-10-13")).toThrow(new ActivityPeriodError(message));
  });

  it("resolves all time to the span, or to today when there are no records", () => {
    expect(resolvePeriod({ period: "all" }, "2026-10-13", { from: "2025-03-02", to: "2026-10-10" })).toEqual({ from: "2025-03-02", to: "2026-10-10" });
    expect(resolvePeriod({ period: "all" }, "2026-10-13", null)).toEqual({ from: "2026-10-13", to: "2026-10-13" });
  });
});

describe("recordSpan", () => {
  it("spans the first to the last record date across every source", () => {
    const sources: ActivitySources = { ...empty(),
      attendance: [attendance({ date: "2026-10-10" })],
      interviews: [interview({ date: "2025-03-02" })],
      training: [course({ date: "2026-01-15" })],
      enrolments: { entries: [course({ date: "2026-06-01", result: "In progress", progress: 40 }), course({ date: "" })], stale: false },
    };
    expect(recordSpan(sources, "2026-10-13")).toEqual({ from: "2025-03-02", to: "2026-10-10" });
  });

  it("is null with no records", () => {
    expect(recordSpan(empty(), "2026-10-13")).toBeNull();
  });

  it("covers a leave record when it is the only record (Story 8.4)", () => {
    expect(recordSpan({ ...empty(), leave: [leave({ startDate: "2026-03-09", endDate: "2026-03-12" })] }, "2026-10-13"))
      .toEqual({ from: "2026-03-09", to: "2026-03-12" });
  });

  it("covers assignment start and end (an open one ends today), backfilled completion and the evaluation's Dhaka date", () => {
    expect(recordSpan({ ...empty(), assignments: [assignment({ startDate: "2026-05-01" })] }, "2026-10-13"))
      .toEqual({ from: "2026-05-01", to: "2026-10-13" });
    expect(recordSpan({ ...empty(), assignments: [assignment({ startDate: "2026-01-01", completionDate: "2026-02-01", status: "closed" })] }, "2026-10-13"))
      .toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(recordSpan({ ...empty(), backfilledProjects: [pastProject()] }, "2026-10-13")).toEqual({ from: "2025-06-30", to: "2025-06-30" });
    expect(recordSpan({ ...empty(), evaluations: [evaluation()] }, "2026-10-13")).toEqual({ from: "2026-10-06", to: "2026-10-06" });
  });
});

describe("buildTimeline", () => {
  const september = { from: "2026-09-01", to: "2026-09-30" };

  it("builds one row per event of all four types within the inclusive period, sorted by date", () => {
    const sources: ActivitySources = { ...empty(),
      attendance: [attendance(), attendance({ id: "a0", date: "2026-08-31", clockIn: "2026-08-31T03:00:00Z" })],
      interviews: [interview({ date: "2026-09-30" }), interview({ date: "2026-10-01" })],
      training: [course({ date: "2026-09-01" })],
      enrolments: { entries: [course({ name: "Leadership", provider: "LMS", date: "2026-09-28", result: "In progress", progress: 40 })], stale: false },
    };
    const rows = buildTimeline(employee, sources, september, now);
    expect(rows.map(r => [r.date, r.type])).toEqual([
      ["2026-09-01", "training"], ["2026-09-10", "attendance"], ["2026-09-28", "enrolment"], ["2026-09-30", "interview"],
    ]);
    expect(rows.every(r => r.employeeId === "BS-1001" && r.employeeName === "Nadia Rahman")).toBe(true);
  });

  it("describes attendance with Dhaka clock times, break, mode, log and status", () => {
    const sources = { ...empty(), attendance: [
      attendance({ log: { summary: "Built the export", tasks: [], blockers: "", updatedAt: "" } }),
      attendance({ id: "a2", date: "2026-09-11", clockIn: "2026-09-11T02:30:00Z", clockOut: null, workMode: "Remote", breakMinutes: 0 }),
    ] };
    const [done, open] = buildTimeline(employee, sources, september, now);
    expect(done).toMatchObject({
      type: "attendance", title: "Attendance", time: "09:05",
      details: "Clock in 09:05, clock out 18:00, break 30 min, Office; log: Built the export", status: "Completed",
    });
    expect(open).toMatchObject({ details: "Clock in 08:30, clock out not recorded, break 0 min, Remote", status: "Missing clock-out" });
  });

  it("describes interviews: title, stage and feedback, status Withdrawn, the outcome or Reported", () => {
    const sources = { ...empty(), interviews: [
      interview({ feedback: "Strong system design" }),
      interview({ company: "Acme", date: "2026-09-13", withdrawn: true }),
      interview({ company: "Beta", date: "2026-09-14", outcome: "" }),
    ] };
    const rows = buildTimeline(employee, sources, september, now);
    expect(rows[0]).toMatchObject({ title: "Northstar Labs — Frontend Engineer", details: "Stage: Technical; feedback: Strong system design", status: "Scheduled" });
    expect(rows[1]).toMatchObject({ details: "Stage: Technical", status: "Withdrawn" });
    expect(rows[2]).toMatchObject({ status: "Reported" });
  });

  it("describes stored training and LMS enrolments (in progress and LMS-completed)", () => {
    const sources: ActivitySources = { ...empty(),
      training: [course()],
      enrolments: { entries: [
        course({ name: "Leadership", provider: "LMS", date: "2026-09-28", result: "In progress", progress: 40 }),
        course({ name: "Testing", provider: "LMS", date: "2026-09-20", result: "Completed · passed" }),
      ], stale: false },
    };
    const rows = buildTimeline(employee, sources, september, now);
    expect(rows).toEqual([
      expect.objectContaining({ type: "training", title: "React · practical foundations", details: "Provider: Udemy", status: "Passed" }),
      expect.objectContaining({ type: "enrolment", title: "Testing", details: "Provider: LMS", status: "Completed · passed" }),
      expect.objectContaining({ type: "enrolment", title: "Leadership", details: "Provider: LMS, progress 40%", status: "In progress" }),
    ]);
  });

  it("notes stale LMS data in the enrolment details, as a Dhaka date", () => {
    const sources: ActivitySources = { ...empty(),
      enrolments: { entries: [course({ name: "Leadership", date: "2026-09-28", result: "In progress", progress: 40 })], asOf: "2026-09-29T20:00:00Z", stale: true },
    };
    const [row] = buildTimeline(employee, sources, september, now);
    expect(row.details).toBe("Provider: Udemy, progress 40%; LMS data as of 30 Sep 2026 (may be out of date)");
  });

  it("sorts by date, then time (rows without a time first), then type, then title", () => {
    const day = "2026-09-10";
    const sources: ActivitySources = { ...empty(),
      attendance: [attendance({ date: day })],
      interviews: [interview({ date: day, company: "Zeta" }), interview({ date: day, company: "Alpha" })],
      training: [course({ date: day })],
      enrolments: { entries: [course({ date: day, name: "B course" })], stale: false },
    };
    const rows = buildTimeline(employee, sources, september, now);
    expect(rows.map(r => [r.type, r.title])).toEqual([
      ["enrolment", "B course"], ["interview", "Alpha — Frontend Engineer"], ["interview", "Zeta — Frontend Engineer"],
      ["training", "React · practical foundations"], ["attendance", "Attendance"],
    ]);
  });

  it("returns no rows for an empty period", () => {
    expect(buildTimeline(employee, { ...empty(), attendance: [attendance()] }, { from: "2026-10-01", to: "2026-10-31" }, now)).toEqual([]);
  });
});

describe("buildTimeline: assignments, evaluations and leave (Story 8.4)", () => {
  it("includes an open assignment that started before the period, dated by its start", () => {
    const rows = buildTimeline(employee, { ...empty(), assignments: [assignment()] }, october, now);
    expect(rows).toEqual([{
      employeeId: "BS-1001", employeeName: "Nadia Rahman", date: "2026-09-01", time: "", type: "assignment",
      title: "Core banking — Acme Bank", details: "Role: Frontend lead; start: 2026-09-01; end: open; provenance: assignment", status: "Open",
    }]);
  });

  it("leaves out an assignment closed before the period and a future open one; keeps one closed inside it", () => {
    const sources = { ...empty(), assignments: [
      assignment({ id: "x", startDate: "2026-01-01", completionDate: "2026-02-01", status: "closed" as const }),
      assignment({ id: "y", startDate: "2026-10-20" }), // starts after "today" (13 Oct): open to today, so no overlap with 1-15 Oct
      assignment({ id: "z", projectName: "Payments", startDate: "2026-08-01", completionDate: "2026-10-01", status: "closed" as const }),
    ] };
    const rows = buildTimeline(employee, sources, { from: "2026-10-01", to: "2026-10-15" }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-08-01", title: "Payments — Acme Bank", status: "Closed",
      details: "Role: Frontend lead; start: 2026-08-01; end: 2026-10-01; provenance: assignment",
    });
  });

  it("includes an open assignment up to today only", () => {
    const sources = { ...empty(), assignments: [assignment({ startDate: "2026-09-01" })] };
    expect(buildTimeline(employee, sources, { from: "2026-10-14", to: "2026-10-31" }, now)).toEqual([]);
    expect(buildTimeline(employee, sources, { from: "2026-10-13", to: "2026-10-13" }, now)).toHaveLength(1);
  });

  it("includes a backfilled past project in its completion year, marked by provenance; withdrawn kept as Withdrawn", () => {
    const year2025 = { from: "2025-01-01", to: "2025-12-31" };
    const [row] = buildTimeline(employee, { ...empty(), backfilledProjects: [pastProject()] }, year2025, now);
    expect(row).toMatchObject({
      date: "2025-06-30", type: "assignment", title: "Legacy portal — Old Co", status: "Self-reported",
      details: "Self-reported past project; completed: 2025-06-30; outcome: Delivered on time; provenance: backfilled",
    });
    const [withdrawn] = buildTimeline(employee, { ...empty(), backfilledProjects: [pastProject({ status: "withdrawn" })] }, year2025, now);
    expect(withdrawn.status).toBe("Withdrawn");
    expect(buildTimeline(employee, { ...empty(), backfilledProjects: [pastProject()] }, october, now)).toEqual([]);
  });

  it("dates an evaluation by the Dhaka date of createdAt, with evaluator, outcome and the assignment's project", () => {
    const sources = { ...empty(), assignments: [assignment({ startDate: "2026-01-01", completionDate: "2026-02-01", status: "closed" as const })], evaluations: [evaluation()] };
    const rows = buildTimeline(employee, sources, { from: "2026-10-06", to: "2026-10-06" }, now);
    expect(rows).toEqual([expect.objectContaining({
      date: "2026-10-06", type: "evaluation", title: "Evaluation — Core banking (Acme Bank)",
      details: "Evaluator: Farhana Ahmed; outcome: Exceeded expectations", status: "Written",
    })]);
    // 2026-10-05T20:00Z is not 5 Oct in Dhaka.
    expect(buildTimeline(employee, sources, { from: "2026-10-05", to: "2026-10-05" }, now)).toEqual([]);
  });

  it("adds client feedback only when asked (Administrator or manager exporter) and when non-empty", () => {
    const sources = { ...empty(), evaluations: [evaluation(), evaluation({ assignmentId: "gone", clientFeedback: "  " })] };
    const rows = buildTimeline(employee, sources, october, now, { clientFeedback: true });
    // Same date, type and title: the stable sort keeps the store's order.
    expect(rows.map(r => [r.title, r.details])).toEqual([
      ["Evaluation", "Evaluator: Farhana Ahmed; outcome: Exceeded expectations; client feedback: Great partner"],
      ["Evaluation", "Evaluator: Farhana Ahmed; outcome: Exceeded expectations"],
    ]);
    expect(buildTimeline(employee, sources, october, now).every(r => !r.details.includes("client feedback"))).toBe(true);
  });

  it("marks an amended evaluation and names its latest author; the role words when there is no stored name", () => {
    const [row] = buildTimeline(employee, { ...empty(), evaluations: [evaluation({
      authoredBy: "u2", authoredByName: null, authoredByRole: "admin", updatedAt: "2026-10-07T04:00:00Z",
    })] }, october, now);
    expect(row).toMatchObject({ status: "Amended", details: "Evaluator: the Administrator; outcome: Exceeded expectations" });
  });

  it("includes leave touching the period, dated by its start, with category, dates and working days", () => {
    const rows = buildTimeline(employee, { ...empty(), leave: [leave()] }, october, now);
    expect(rows).toEqual([{
      employeeId: "BS-1001", employeeName: "Nadia Rahman", date: "2026-09-29", time: "", type: "leave",
      title: "4–14 working days", details: "From 2026-09-29 to 2026-10-02; 4 working days", status: "Recorded",
    }]);
    // Touching on the last day of the period, and a single working day.
    const [one] = buildTimeline(employee, { ...empty(), leave: [leave({ startDate: "2026-10-31", endDate: "2026-11-02", workingDays: 1 })] }, october, now);
    expect(one).toMatchObject({ title: "1–3 working days", details: "From 2026-10-31 to 2026-11-02; 1 working day" });
    expect(buildTimeline(employee, { ...empty(), leave: [leave({ startDate: "2026-09-21", endDate: "2026-09-30" })] }, october, now)).toEqual([]);
  });

  it("includes cancelled leave with status Cancelled", () => {
    const [row] = buildTimeline(employee, { ...empty(), leave: [leave({ cancelledAt: "2026-10-01T05:00:00Z" })] }, october, now);
    expect(row.status).toBe("Cancelled");
  });
});

describe("timelineCsv", () => {
  it("is the BOM and the header only when there are no rows", () => {
    expect(timelineCsv([])).toBe('﻿"employee_id","employee_name","date","type","title","details","status"');
    expect(TIMELINE_HEADER).toEqual(["employee_id", "employee_name", "date", "type", "title", "details", "status"]);
  });

  it("quotes every field in column order and guards injected formulas", () => {
    const rows = buildTimeline(employee, { ...empty(), interviews: [interview({ company: '=HYPERLINK("http://x","y")', role: "QA" })] },
      { from: "2026-09-01", to: "2026-09-30" }, now);
    expect(timelineCsv(rows).split("\r\n")[1]).toBe(
      '"BS-1001","Nadia Rahman","2026-09-12","interview","\'=HYPERLINK(""http://x"",""y"") — QA","Stage: Technical","Scheduled"',
    );
  });

  it.each(["+1", "-1", "@SUM(A1)"])("guards a cell starting with %s", value => {
    const rows = buildTimeline(employee, { ...empty(), training: [course({ result: value })] }, { from: "2026-09-01", to: "2026-09-30" }, now);
    expect(timelineCsv(rows).split("\r\n")[1].endsWith(`,"'${value}"`)).toBe(true);
  });
});

describe("activityFilename", () => {
  it("names the employee and the inclusive period", () => {
    expect(activityFilename("BS-1001", { from: "2026-09-01", to: "2026-09-30" })).toBe("activity-BS-1001-2026-09-01_to_2026-09-30.csv");
  });
});

describe("activityBulkFilename", () => {
  it("names all employees and the inclusive period", () => {
    expect(activityBulkFilename({ from: "2026-09-01", to: "2026-09-30" })).toBe("activity-all-employees-2026-09-01_to_2026-09-30.csv");
  });
});
