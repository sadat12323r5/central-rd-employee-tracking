import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAttendanceCommands } from "@/server/attendance-commands";
import { exportActivity, exportAllActivity } from "@/server/activity-export";
import { TransferOpenAssignmentError } from "@/server/employees-store";
import {
  LeaveCalendarMissingError, LeaveForbiddenError, LeaveOverlapError, LeaveUnavailableError, LeaveValidationFailedError,
} from "@/server/leave-store";
import { describeError } from "../sim/errors";
import { TimesheetValidationError } from "@/domain/timesheet";
import { csvRowCount, TOOLS, toolsFor } from "../sim/tools/catalog";
import { createSimClock } from "../sim/tools/clock";
import { INVALID_TOOL_INPUT, RECORDED_INPUT_MAX, runTool, TOOL_NOT_ALLOWED, TOOL_TEXT_MAX } from "../sim/tools/run";
import type { SimTool } from "../sim/tools/types";
import { createMemoryAttendanceStore } from "./support/memory-attendance-store";
import { ADMIN_SESSION, fakeToolContext, MANAGER_SESSION, STAFF_SESSION } from "./support/sim-tool-fakes";

// Story 9.2: the persona tool catalogue, offline: fake stores record every call, so each tool is checked to
// call the right store method with the persona's own session and the simulated clock.

const EXPORT = { csv: "\uFEFF\"h1\",\"h2\"\r\n\"a\",\"b\"\r\n\"c\",\"multi\r\nline\"", filename: "activity-all-employees-2026-08-01_to_2026-08-31.csv", from: "2026-08-01", to: "2026-08-31" };

vi.mock("@/server/activity-export", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/activity-export")>()),
  exportActivity: vi.fn(async () => EXPORT),
  exportAllActivity: vi.fn(async () => EXPORT),
}));

beforeEach(() => {
  vi.mocked(exportActivity).mockClear();
  vi.mocked(exportAllActivity).mockClear();
});

const STAFF_TOOLS = [
  "clock_in", "clock_out", "save_work_log", "record_leave", "edit_leave", "cancel_leave", "add_interview", "update_interview",
  "withdraw_interview", "backfill_project", "add_employment_history", "edit_employment_history", "remove_employment_history", "read_my_record",
];
const MANAGER_TOOLS = [
  "read_team", "create_assignment", "update_assignment_note", "close_assignment", "evaluate_assignment", "rate_skill", "save_evaluation",
  "record_team_leave", "transfer_employee", "export_department_activity",
];
const ADMIN_ONLY = ["create_department", "update_department", "set_department_manager", "export_all_activity"];

const byName = (name: string): SimTool => {
  const found = TOOLS.find(t => t.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
};

const LEAVE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const DEPT_ID = "de9a0000-0000-4000-8000-000000000002";
const NOW = createSimClock("2026-08-10", "10:00").now();

describe("toolsFor (Story 9.2)", () => {
  it("gives each role exactly its own tools", () => {
    expect(toolsFor("staff").map(t => t.name)).toEqual(STAFF_TOOLS);
    expect(toolsFor("manager").map(t => t.name)).toEqual(MANAGER_TOOLS);
    expect(toolsFor("admin").map(t => t.name)).toEqual([...MANAGER_TOOLS, ...ADMIN_ONLY]);
    expect(STAFF_TOOLS.filter(n => MANAGER_TOOLS.includes(n) || ADMIN_ONLY.includes(n))).toEqual([]);
    expect(new Set(TOOLS.map(t => t.name)).size).toBe(28);
  });

  it("uses strict input objects whose properties are all required", () => {
    for (const tool of TOOLS) {
      expect(tool.input.safeParse({ ...Object.fromEntries(Object.keys(tool.input.shape).map(k => [k, undefined])), extra: 1 }).success, tool.name).toBe(false);
      for (const [key, field] of Object.entries(tool.input.shape)) {
        expect((field as { safeParse(v: unknown): { success: boolean } }).safeParse(undefined).success, `${tool.name}.${key}`).toBe(false);
      }
    }
  });
});

type Case = {
  tool: string;
  role: "admin" | "manager" | "staff";
  input: Record<string, unknown>;
  calls: { store: string; method: string; args: unknown[] }[];
};

const MAPPINGS: Case[] = [
  { tool: "clock_in", role: "staff", input: { workMode: "Office" }, calls: [{ store: "attendance-commands", method: "clockIn", args: ["BS-2003", { workMode: "Office" }, NOW] }] },
  { tool: "clock_out", role: "staff", input: { breakMinutes: 30 }, calls: [{ store: "attendance-commands", method: "clockOut", args: ["BS-2003", { breakMinutes: 30 }, NOW] }] },
  {
    tool: "save_work_log", role: "staff",
    input: { summary: "Built the API.", blockers: "", tasks: [{ description: "API", hours: 1.5, link: null }, { description: "Docs", hours: 1, link: "https://x.example" }] },
    calls: [{
      store: "attendance-commands", method: "saveLog",
      args: ["BS-2003", { summary: "Built the API.", blockers: "", tasks: [{ description: "API", hours: "1.5", link: "" }, { description: "Docs", hours: "1", link: "https://x.example" }] }, NOW],
    }],
  },
  {
    tool: "record_leave", role: "staff", input: { startDate: "2026-08-24", endDate: "2026-08-25" },
    calls: [{ store: "leave", method: "record", args: [STAFF_SESSION, "BS-2003", { startDate: "2026-08-24", endDate: "2026-08-25" }] }],
  },
  {
    tool: "edit_leave", role: "staff", input: { leaveId: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-27" },
    calls: [{ store: "leave", method: "update", args: [STAFF_SESSION, LEAVE_ID, { startDate: "2026-08-24", endDate: "2026-08-27" }] }],
  },
  { tool: "cancel_leave", role: "staff", input: { leaveId: LEAVE_ID }, calls: [{ store: "leave", method: "cancel", args: [STAFF_SESSION, LEAVE_ID] }] },
  {
    tool: "add_interview", role: "staff", input: { company: "Acme", role: "SRE", date: "2026-08-12", stage: "Phone screen", outcome: null },
    calls: [{ store: "interviews", method: "add", args: [STAFF_SESSION, { company: "Acme", role: "SRE", date: "2026-08-12", stage: "Phone screen", outcome: "" }] }],
  },
  {
    tool: "update_interview", role: "staff", input: { interviewId: OTHER_ID, stage: "Onsite", outcome: "Passed", feedback: null },
    calls: [{ store: "interviews", method: "update", args: [STAFF_SESSION, OTHER_ID, { stage: "Onsite", outcome: "Passed", feedback: "" }] }],
  },
  { tool: "withdraw_interview", role: "staff", input: { interviewId: OTHER_ID }, calls: [{ store: "interviews", method: "withdraw", args: [STAFF_SESSION, OTHER_ID] }] },
  {
    tool: "backfill_project", role: "staff",
    input: { departmentId: DEPT_ID, client: "Bank", projectName: "Ledger", completionDate: "2025-12-01", outcome: "Shipped." },
    calls: [{ store: "backfilled", method: "add", args: [STAFF_SESSION, { departmentId: DEPT_ID, client: "Bank", projectName: "Ledger", completionDate: "2025-12-01", outcome: "Shipped." }] }],
  },
  {
    tool: "add_employment_history", role: "staff", input: { role: "Engineer", employer: "Acme", period: "2021 - 2023", detail: null },
    calls: [{ store: "history", method: "add", args: [STAFF_SESSION, "BS-2003", { role: "Engineer", employer: "Acme", period: "2021 - 2023", detail: "" }] }],
  },
  {
    tool: "edit_employment_history", role: "staff", input: { entryId: OTHER_ID, role: "Engineer", employer: "Acme", period: "2021 - 2024", detail: "Payments." },
    calls: [{ store: "history", method: "update", args: [STAFF_SESSION, OTHER_ID, { role: "Engineer", employer: "Acme", period: "2021 - 2024", detail: "Payments." }] }],
  },
  { tool: "remove_employment_history", role: "staff", input: { entryId: OTHER_ID }, calls: [{ store: "history", method: "remove", args: [STAFF_SESSION, OTHER_ID] }] },
  {
    tool: "read_my_record", role: "staff", input: {},
    calls: [{ store: "employees", method: "getFor", args: [STAFF_SESSION, "BS-2003"] }],
  },
  { tool: "read_team", role: "manager", input: {}, calls: [{ store: "employees", method: "listFor", args: [MANAGER_SESSION] }] },
  { tool: "read_team", role: "admin", input: {}, calls: [{ store: "employees", method: "listFor", args: [ADMIN_SESSION] }] },
  {
    tool: "create_assignment", role: "manager",
    input: { employeeId: "BS-2004", client: "Bank", projectName: "Ledger", role: "Backend", allocation: 80, startDate: null },
    calls: [{ store: "assignments", method: "create", args: [MANAGER_SESSION, "BS-2004", { client: "Bank", projectName: "Ledger", role: "Backend", allocation: 80, startDate: "2026-08-10" }] }],
  },
  {
    tool: "update_assignment_note", role: "manager", input: { assignmentId: OTHER_ID, note: "On track." },
    calls: [{ store: "assignments", method: "updateNote", args: [MANAGER_SESSION, OTHER_ID, "On track."] }],
  },
  {
    tool: "close_assignment", role: "manager", input: { assignmentId: OTHER_ID, completionDate: null },
    calls: [{ store: "assignments", method: "close", args: [MANAGER_SESSION, OTHER_ID, "2026-08-10"] }],
  },
  {
    tool: "close_assignment", role: "admin", input: { assignmentId: OTHER_ID, completionDate: "2026-08-07" },
    calls: [{ store: "assignments", method: "close", args: [ADMIN_SESSION, OTHER_ID, "2026-08-07"] }],
  },
  {
    tool: "evaluate_assignment", role: "manager", input: { assignmentId: OTHER_ID, evaluation: "Strong delivery.", clientFeedback: null },
    calls: [{ store: "evaluations", method: "create", args: [MANAGER_SESSION, OTHER_ID, { evaluation: "Strong delivery.", clientFeedback: "" }] }],
  },
  {
    tool: "rate_skill", role: "manager", input: { employeeId: "BS-2004", name: "TypeScript", level: 4, evidence: "Led the API." },
    calls: [{ store: "assessments", method: "rateSkill", args: [MANAGER_SESSION, "BS-2004", { name: "TypeScript", level: 4, evidence: "Led the API." }] }],
  },
  {
    tool: "save_evaluation", role: "manager", input: { employeeId: "BS-2004", strengths: "Ownership.", developmentPriorities: "Mentoring.", readiness: "Ready for senior" },
    calls: [{ store: "assessments", method: "saveEvaluation", args: [MANAGER_SESSION, "BS-2004", { strengths: "Ownership.", developmentPriorities: "Mentoring.", readiness: "Ready for senior" }] }],
  },
  {
    tool: "record_team_leave", role: "manager", input: { employeeId: "BS-2004", startDate: "2026-09-03", endDate: "2026-09-07" },
    calls: [{ store: "leave", method: "record", args: [MANAGER_SESSION, "BS-2004", { startDate: "2026-09-03", endDate: "2026-09-07" }] }],
  },
  {
    tool: "transfer_employee", role: "manager", input: { employeeId: "BS-2004", toDepartmentId: DEPT_ID },
    calls: [{ store: "employees", method: "transfer", args: [MANAGER_SESSION, "BS-2004", DEPT_ID] }],
  },
  {
    tool: "create_department", role: "admin", input: { name: "Platform", parentId: null },
    calls: [{ store: "departments", method: "create", args: [ADMIN_SESSION, { name: "Platform", parentId: null }] }],
  },
  {
    tool: "update_department", role: "admin", input: { departmentId: OTHER_ID, name: "Platform", parentId: DEPT_ID },
    calls: [{ store: "departments", method: "update", args: [ADMIN_SESSION, OTHER_ID, { name: "Platform", parentId: DEPT_ID }] }],
  },
  {
    tool: "set_department_manager", role: "admin", input: { departmentId: OTHER_ID, employeeId: null },
    calls: [{ store: "departments", method: "setManager", args: [ADMIN_SESSION, OTHER_ID, null] }],
  },
];

describe("tool to store mapping (Story 9.2)", () => {
  it.each(MAPPINGS.map(c => [`${c.tool} as ${c.role}`, c] as const))("%s", async (_label, c) => {
    expect(toolsFor(c.role).map(t => t.name)).toContain(c.tool);
    const { ctx, calls, events } = fakeToolContext(c.role, {
      results: { "employees.getFor": null, "employees.listFor": [], "backfilled.departmentOptions": [] },
    });
    const outcome = await runTool(byName(c.tool), ctx, c.input);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(calls.filter(call => call.method !== "departmentOptions")).toEqual(c.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "action", actor: ctx.member.persona.name, day: "2026-08-10", at: NOW.toISOString(), detail: { tool: c.tool } });
  });

  it("covers every tool", () => {
    expect(new Set([...MAPPINGS.map(c => c.tool), "export_department_activity", "export_all_activity"])).toEqual(new Set(TOOLS.map(t => t.name)));
  });

  it("dates a real clock-in at the simulated instant", async () => {
    const { ctx } = fakeToolContext("staff");
    const store = createMemoryAttendanceStore();
    ctx.member.attendance = createAttendanceCommands(store);
    expect(await runTool(byName("clock_in"), ctx, { workMode: "Remote" })).toEqual({ ok: true, text: "Clocked in." });
    const [entry] = await store.listForEmployee("BS-2003");
    expect(entry).toMatchObject({ date: "2026-08-10", clockIn: NOW.toISOString(), workMode: "Remote" });
  });

  it("returns a compact own record with the backfill departments", async () => {
    const { ctx } = fakeToolContext("staff", {
      results: {
        "employees.getFor": {
          id: "BS-2003", name: "Rafiq Ahmed", title: "Senior Software Engineer", summary: "x".repeat(400),
          leave: [{ id: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-25", workingDays: 2, cancelledAt: null }, { id: OTHER_ID, startDate: "2026-08-01", endDate: "2026-08-01", workingDays: 0, cancelledAt: "x" }],
          interviews: [], history: [], backfilledProjects: [], assignments: [], skills: [{ name: "Go", level: 3, evidence: "long" }],
        },
        "backfilled.departmentOptions": [{ id: DEPT_ID, name: "Central R&D" }],
      },
    });
    const outcome = await runTool(byName("read_my_record"), ctx, {});
    expect(outcome.ok).toBe(true);
    const record = JSON.parse(outcome.ok ? outcome.text : "{}");
    expect(record.leave).toEqual([{ id: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-25", workingDays: 2 }]);
    expect(record.backfillDepartments).toEqual([{ id: DEPT_ID, name: "Central R&D" }]);
    expect(record.skills).toEqual([{ name: "Go", level: 3 }]);
    expect(record.summary).toBeUndefined();
  });

  it("reads the team compactly: open assignment, closed ones still to evaluate, active leave, archived flag", async () => {
    const assignment = (id: string, status: "open" | "closed", completionDate: string | null) => ({
      id, employeeId: "BS-2004", departmentId: DEPT_ID, client: "Bank", projectName: `Project ${id.slice(0, 1)}`, role: "Backend",
      allocation: 50, startDate: "2026-08-03", latestUpdate: "", status, completionDate, createdAt: "x", closedAt: null, provenance: "assignment",
    });
    const open = "aaaaaaaa-0000-4000-8000-000000000001";
    const evaluatedId = "bbbbbbbb-0000-4000-8000-000000000002";
    const toEvaluate = "cccccccc-0000-4000-8000-000000000003";
    const { ctx } = fakeToolContext("manager", {
      results: {
        "employees.listFor": [{
          id: "BS-2004", name: "Nusrat Jahan", title: "QA Engineer", archived: true, departmentId: DEPT_ID,
          assignments: [assignment(open, "open", null), assignment(evaluatedId, "closed", "2026-08-07"), assignment(toEvaluate, "closed", "2026-08-06")],
          evaluations: [{ assignmentId: evaluatedId }],
          leave: [
            { id: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-25", cancelledAt: null },
            { id: OTHER_ID, startDate: "2026-08-12", endDate: "2026-08-12", cancelledAt: "2026-08-05T00:00:00Z" },
          ],
        }],
      },
    });
    const outcome = await runTool(byName("read_team"), ctx, {});
    const [member] = JSON.parse(outcome.ok ? outcome.text : "[]");
    expect(member).toMatchObject({ id: "BS-2004", archived: true, departmentId: DEPT_ID });
    expect(member.openAssignment).toEqual({ id: open, client: "Bank", projectName: "Project a", role: "Backend", allocation: 50, startDate: "2026-08-03" });
    expect(member.closedToEvaluate).toEqual([{ id: toEvaluate, projectName: "Project c", completionDate: "2026-08-06" }]);
    expect(member.leave).toEqual([{ id: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-25" }]);
  });

  it("shrinks a long list read to valid JSON within 4000 characters", async () => {
    const employee = (n: number) => ({
      id: `BS-${2000 + n}`, name: `Person ${n}`, title: "Engineer", assignments: [], evaluations: [],
      leave: [{ id: LEAVE_ID, startDate: "2026-08-24", endDate: "2026-08-25", cancelledAt: null }],
    });
    const { ctx } = fakeToolContext("admin", { results: { "employees.listFor": Array.from({ length: 200 }, (_, n) => employee(n)) } });
    const outcome = await runTool(byName("read_team"), ctx, {});
    const text = outcome.ok ? outcome.text : "";
    expect(text.length).toBeLessThanOrEqual(TOOL_TEXT_MAX);
    const read = JSON.parse(text);
    expect(read).toMatchObject({ truncated: true, total: 200 });
    expect(read.items).toHaveLength(read.shown);
    expect(read.shown).toBeGreaterThan(0);
    expect(read.items[0].id).toBe("BS-2000");
  });

  it("exports through the app's export functions with the service audit store, the actor and the simulated now", async () => {
    const { ctx, stores, serviceAudit } = fakeToolContext("manager");
    const period = { period: "month", month: "8", year: "2026", from: null, to: null };
    const bulk = await runTool(byName("export_department_activity"), ctx, { employeeId: null, ...period });
    expect(bulk).toEqual({ ok: true, text: `Exported ${EXPORT.filename} (2 rows, 2026-08-01 to 2026-08-31).` });
    expect(exportAllActivity).toHaveBeenCalledWith(
      expect.objectContaining({ audit: serviceAudit, employees: stores.employees, scope: stores.scope, leave: stores.leave }),
      MANAGER_SESSION, "user-manager", { period: "month", month: "8", year: "2026", from: undefined, to: undefined, includeArchived: "" }, NOW,
    );
    const single = await runTool(byName("export_department_activity"), ctx, { employeeId: "BS-2004", ...period });
    expect(single.ok).toBe(true);
    expect(exportActivity).toHaveBeenCalledWith(
      expect.objectContaining({ audit: serviceAudit, interviews: stores.interviews }),
      MANAGER_SESSION, "user-manager", { employeeId: "BS-2004", period: "month", month: "8", year: "2026", from: undefined, to: undefined }, NOW,
    );

    const admin = fakeToolContext("admin");
    const all = await runTool(byName("export_all_activity"), admin.ctx, { period: "all", month: null, year: null, from: null, to: null, includeArchived: true });
    expect(all.ok && all.text).not.toContain("\"a\"");
    expect(exportAllActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ audit: admin.serviceAudit }), ADMIN_SESSION, "user-admin",
      { period: "all", month: undefined, year: undefined, from: undefined, to: undefined, includeArchived: "on" }, NOW,
    );
  });

  it("refuses an export for a session the app's export gate refuses", async () => {
    const { ctx, calls } = fakeToolContext("manager");
    ctx.member.session = STAFF_SESSION;
    const period = { period: "all", month: null, year: null, from: null, to: null };
    expect(await runTool(byName("export_department_activity"), ctx, { employeeId: null, ...period }))
      .toMatchObject({ ok: false, error: "ActivityForbiddenError", message: "Only an Administrator or a department manager can export activity." });
    const admin = fakeToolContext("admin");
    admin.ctx.member.session = STAFF_SESSION;
    expect(await runTool(byName("export_all_activity"), admin.ctx, { ...period, includeArchived: false })).toMatchObject({ ok: false, error: "ActivityForbiddenError" });
    expect(exportActivity).not.toHaveBeenCalled();
    expect(exportAllActivity).not.toHaveBeenCalled();
    expect([...calls, ...admin.calls]).toEqual([]);
  });

  it("trims text inputs, so blank text is refused", async () => {
    const { ctx, calls } = fakeToolContext("staff");
    const input = { company: "  Acme  ", role: "SRE", date: "2026-08-12", stage: "   ", outcome: null };
    expect(await runTool(byName("add_interview"), ctx, input)).toMatchObject({ ok: false, error: INVALID_TOOL_INPUT });
    await runTool(byName("add_interview"), ctx, { ...input, stage: " Screen " });
    expect(calls[0].args[1]).toMatchObject({ company: "Acme", stage: "Screen" });
  });

  it.each([
    ["hours that are not quarter hours", { description: "API", hours: 1.3, link: null }, /tasks\.0\.hours/],
    ["a link that is not http(s)", { description: "API", hours: 1, link: "ftp://x.example" }, /tasks\.0\.link/],
  ])("refuses a work log with %s", async (_label, task, path) => {
    const { ctx, calls } = fakeToolContext("staff");
    const outcome = await runTool(byName("save_work_log"), ctx, { summary: "s", blockers: "", tasks: [task] });
    expect(outcome).toMatchObject({ ok: false, error: INVALID_TOOL_INPUT });
    expect(!outcome.ok && outcome.message).toMatch(path);
    expect(calls).toEqual([]);
  });

  it("counts CSV data rows, quoted line breaks included", () => {
    expect(csvRowCount(EXPORT.csv)).toBe(2);
    expect(csvRowCount("\uFEFF\"h\"")).toBe(0);
    expect(csvRowCount("")).toBe(0);
  });
});

describe("createSimClock (Story 9.2)", () => {
  it("rejects unreal dates and fractional minutes", () => {
    const clock = createSimClock("2026-08-10", "09:00");
    expect(() => createSimClock("2026-02-30")).toThrow(/Invalid simulated date/);
    expect(() => clock.set("2026-02-30")).toThrow(/Invalid simulated date/);
    expect(() => clock.advance(1.5)).toThrow(/whole minutes/);
    clock.advance(90);
    expect(clock.now().toISOString()).toBe("2026-08-10T04:30:00.000Z");
    clock.set("2026-08-11", "23:30");
    clock.advance(60);
    expect(clock.today()).toBe("2026-08-12");
  });
});

describe("refusals (Story 9.2)", () => {
  it.each([
    ["an unknown key", "record_leave", { startDate: "2026-08-24", endDate: "2026-08-25", employeeId: "BS-1001" }, /unrecognized/i],
    ["a wrong enum value", "clock_in", { workMode: "Beach" }, /workMode/],
    ["over-length text", "add_interview", { company: "x".repeat(201), role: "SRE", date: "2026-08-12", stage: "Screen", outcome: null }, /company/],
    ["a missing property", "add_interview", { company: "Acme", role: "SRE", date: "2026-08-12", stage: "Screen" }, /outcome/],
    ["an unreal date", "record_leave", { startDate: "2026-02-30", endDate: "2026-03-01" }, /startDate/],
    ["a nested unknown key", "save_work_log", { summary: "s", blockers: "", tasks: [{ description: "d", hours: 1, link: null, extra: 1 }] }, /tasks\.0/],
    ["a period without a year", "add_employment_history", { role: "r", employer: "e", period: "recently", detail: null }, /period/],
  ])("refuses %s before any store call", async (_label, name, input, path) => {
    const { ctx, calls, events } = fakeToolContext("staff");
    const outcome = await runTool(byName(name), ctx, input);
    expect(outcome).toMatchObject({ ok: false, error: INVALID_TOOL_INPUT });
    expect(!outcome.ok && outcome.message).toMatch(path);
    expect(calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ kind: "refusal", text: expect.stringContaining(name), detail: expect.objectContaining({ tool: name, error: INVALID_TOOL_INPUT }) })]);
  });

  it.each([
    ["leave overlap", "staff", "record_leave", { startDate: "2026-08-24", endDate: "2026-08-25" }, "leave.record", new LeaveOverlapError({ startDate: "2026-08-20", endDate: "2026-08-24" }), "LeaveOverlapError"],
    ["a transfer blocked by an open assignment", "manager", "transfer_employee", { employeeId: "BS-2004", toDepartmentId: DEPT_ID }, "employees.transfer", new TransferOpenAssignmentError(), "TransferOpenAssignmentError"],
    ["an authority refusal", "manager", "record_team_leave", { employeeId: "BS-1001", startDate: "2026-08-24", endDate: "2026-08-25" }, "leave.record", new LeaveForbiddenError(), "LeaveForbiddenError"],
    ["no holiday calendar", "staff", "record_leave", { startDate: "2026-08-24", endDate: "2026-08-25" }, "leave.record", new LeaveCalendarMissingError(), "LeaveCalendarMissingError"],
    ["a year the calendar does not cover", "staff", "record_leave", { startDate: "2027-01-04", endDate: "2027-01-05" }, "leave.record", new LeaveValidationFailedError("UNSUPPORTED_YEAR", { year: 2027, supportedYearStart: 2026, supportedYearEnd: 2026 }), "LeaveValidationFailedError"],
    ["a timesheet rule", "staff", "clock_in", { workMode: "Office" }, "attendance-commands.clockIn", new TimesheetValidationError("ALREADY_CLOCKED_IN", "You are already clocked in today."), "TimesheetValidationError"],
  ] as const)("returns the app's refusal for %s without throwing", async (_label, role, name, input, failing, error, className) => {
    const { ctx, calls, events } = fakeToolContext(role, { failures: { [failing]: error } });
    const outcome = await runTool(byName(name), ctx, input);
    expect(outcome).toMatchObject({ ok: false, error: className, message: error.message });
    if ("code" in error) expect(outcome).toMatchObject({ code: String(error.code) });
    expect(calls).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ kind: "refusal", text: `${name}: ${error.message}`, detail: expect.objectContaining({ tool: name, error: className }) })]);
  });

  it("carries the database cause of an unavailable (RLS) refusal", async () => {
    const error = new LeaveUnavailableError({ cause: { code: "42501", message: "new row violates row-level security policy" } });
    const { ctx, events } = fakeToolContext("staff", { failures: { "leave.record": error } });
    const outcome = await runTool(byName("record_leave"), ctx, { startDate: "2026-08-24", endDate: "2026-08-25" });
    expect(outcome).toEqual({
      ok: false, error: "LeaveUnavailableError", message: `${error.message} (42501 new row violates row-level security policy)`,
      cause: "42501 new row violates row-level security policy",
    });
    expect(events[0]).toMatchObject({ kind: "refusal", text: `record_leave: ${error.message}`, detail: { cause: "42501 new row violates row-level security policy" } });
  });

  it("refuses a tool outside the persona's role before parsing, as a wiring error", async () => {
    const { ctx, calls, events } = fakeToolContext("staff");
    const outcome = await runTool(byName("transfer_employee"), ctx, { not: "even valid" });
    expect(outcome).toEqual({ ok: false, error: TOOL_NOT_ALLOWED, message: "transfer_employee is not one of the staff tools." });
    expect(calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ kind: "refusal", detail: expect.objectContaining({ error: TOOL_NOT_ALLOWED }) })]);
    const manager = fakeToolContext("manager");
    expect(await runTool(byName("clock_in"), manager.ctx, { workMode: "Office" })).toMatchObject({ ok: false, error: TOOL_NOT_ALLOWED });
    const admin = fakeToolContext("admin");
    expect(await runTool(byName("read_my_record"), admin.ctx, {})).toMatchObject({ ok: false, error: TOOL_NOT_ALLOWED });
    expect(await runTool(byName("create_department"), manager.ctx, { name: "X", parentId: null })).toMatchObject({ ok: false, error: TOOL_NOT_ALLOWED });
  });

  it("names the tool once in an invalid-input refusal", async () => {
    const { ctx, events } = fakeToolContext("staff");
    await runTool(byName("clock_in"), ctx, { workMode: "Beach" });
    expect(events[0].text).toMatch(/^clock_in: Invalid input: workMode: /);
    expect(events[0].text.match(/clock_in/g)).toHaveLength(1);
  });

  it("keeps the outcome when the timeline write fails, and caps a long recorded input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = fakeToolContext("staff");
    failing.ctx.timeline = { record: () => { throw new Error("disk full"); } };
    expect(await runTool(byName("cancel_leave"), failing.ctx, { leaveId: LEAVE_ID })).toMatchObject({ ok: true });
    expect(failing.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    warn.mockRestore();

    const { ctx, events } = fakeToolContext("staff");
    await runTool(byName("add_interview"), ctx, { company: "x".repeat(5000), role: "r", date: "2026-08-12", stage: "s", outcome: null });
    const recorded = events[0].detail?.input;
    expect(typeof recorded).toBe("string");
    expect((recorded as string).length).toBeLessThanOrEqual(RECORDED_INPUT_MAX);
    expect(events[0].day).toBe("2026-08-10");
  });

  it("describes non-Error refusals and null codes sensibly", () => {
    expect(describeError({ message: "plain object", code: null })).toEqual({ error: "Error", message: "plain object" });
    expect(describeError(Object.assign(new Error("boom"), { code: undefined }))).toEqual({ error: "Error", message: "boom" });
    expect(describeError(Object.assign(new Error("boom"), { code: "P0001" }))).toMatchObject({ code: "P0001" });
    expect(describeError("text")).toEqual({ error: "Error", message: "text" });
  });

  it("refuses an attendance tool for a persona without attendance commands", async () => {
    const { ctx } = fakeToolContext("staff", { withAttendance: false });
    expect(await runTool(byName("clock_out"), ctx, { breakMinutes: 0 })).toMatchObject({ ok: false, error: "NoAttendanceError" });
  });
});
