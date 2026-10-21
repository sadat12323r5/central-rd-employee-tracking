import { z } from "zod";
import type { Employee } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";
import { PERIODS } from "@/domain/activity";
import { EVALUATION_TEXT_MAX, READINESS_MAX, SKILL_EVIDENCE_MAX, SKILL_NAME_MAX } from "@/domain/assessment-input";
import { DEPARTMENT_NAME_MAX } from "@/domain/departments";
import { EMPLOYEE_ID_PATTERN } from "@/domain/employee-input";
import { DETAIL_MAX, EMPLOYER_MAX, hasPeriodYear, PERIOD_MAX, ROLE_MAX } from "@/domain/employment-history";
import { WORK_MODES } from "@/domain/timesheet";
import { ActivityForbiddenError, exportActivity, exportAllActivity, mayExport, type ActivityExport } from "@/server/activity-export";
import { CLIENT_FEEDBACK_MAX, EVALUATION_MAX } from "@/server/assignment-evaluations-store";
import { ASSIGNMENT_NOTE_MAX, ASSIGNMENT_TEXT_MAX } from "@/server/assignments-store";
import { BACKFILL_OUTCOME_MAX, BACKFILL_TEXT_MAX } from "@/server/backfilled-project-store";
import { ownRecordIdentity, type StaffIdentity } from "@/server/session";
import { fitJsonList } from "./run";
import type { AnyZodObject, PersonaRole, SimTool, ToolContext } from "./types";

// Story 9.2: the persona tool catalogue. Each tool mirrors exactly one thing the persona's role can do in
// the web app and calls the same store the server action calls (never the "use server" action, which
// needs the Next request cookie), under the persona's own session and stores, with the simulated clock.
// Inputs are strict zod objects whose limits and formats mirror the actions' (every property required,
// optional ones nullable). Staff-form tools (attendance, interviews, backfill, own record) act as
// ownRecordIdentity(session). The only service-role write is the export audit row (ctx.serviceAudit).

/** This persona has no employee record of its own (an unlinked Administrator) for an own-record tool. */
export class NoOwnRecordError extends Error {
  constructor() {
    super("This persona has no employee record of its own, so there is nothing to record here.");
    this.name = "NoOwnRecordError";
  }
}

/** This persona's tools have no attendance commands (it has no employee record). */
export class NoAttendanceError extends Error {
  constructor() {
    super("This persona has no attendance record to clock in or out against.");
    this.name = "NoAttendanceError";
  }
}

// ---- input building blocks (limits mirror the server actions' zod rules) ----

const text = (max: number, min = 1) => z.string().trim().min(min).max(max);
const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `Enter the ${what} as YYYY-MM-DD.`)
  .refine(isCalendarDate, `Enter the ${what} as a real date (YYYY-MM-DD).`);
const id = () => z.uuid();
const employeeId = () => z.string().regex(EMPLOYEE_ID_PATTERN, "Use an Employee ID like BS-1234.");
const periodFields = {
  period: z.enum(PERIODS),
  month: z.string().regex(/^(0?[1-9]|1[0-2])$/, "A month is 1 to 12.").nullable(),
  year: z.string().regex(/^\d{4}$/, "A year is four digits.").nullable(),
  from: isoDate("start date").nullable(),
  to: isoDate("end date").nullable(),
};

function tool<Input extends AnyZodObject>(definition: SimTool<Input>): SimTool {
  return definition as unknown as SimTool;
}

const STAFF: readonly PersonaRole[] = ["staff"];
const MANAGERS: readonly PersonaRole[] = ["manager", "admin"];
const ADMIN: readonly PersonaRole[] = ["admin"];

function own(ctx: ToolContext): StaffIdentity {
  const identity = ownRecordIdentity(ctx.member.session);
  if (!identity) throw new NoOwnRecordError();
  return identity;
}

const json = (value: unknown) => JSON.stringify(value);

/** The export actions' gate (activity-actions.ts): only an Administrator or a department manager exports. */
function exporter(ctx: ToolContext) {
  if (!mayExport(ctx.member.session)) throw new ActivityForbiddenError();
  return ctx.member.session;
}

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
const said = (sentence: string, value: unknown) => `${sentence} ${json(value)}`;

/** The number of data rows in an export CSV (every cell is quoted; rows end in CRLF; the header excluded). */
export function csvRowCount(csv: string): number {
  if (csv.replace(/^\uFEFF/, "") === "") return 0;
  let rows = 1;
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "\n") rows++;
  }
  return Math.max(0, rows - 1);
}

const exported = (result: ActivityExport) =>
  `Exported ${result.filename} (${csvRowCount(result.csv)} rows, ${result.from} to ${result.to}).`;

const periodInput = (input: { period: string; month: string | null; year: string | null; from: string | null; to: string | null }) => ({
  period: input.period, month: input.month ?? undefined, year: input.year ?? undefined, from: input.from ?? undefined, to: input.to ?? undefined,
});

/** The compact own-record view returned by read_my_record. */
function myRecord(employee: Employee, departments: { id: string; name: string }[]) {
  return {
    id: employee.id, name: employee.name, title: employee.title,
    leave: employee.leave.filter(l => !l.cancelledAt).map(l => ({ id: l.id, startDate: l.startDate, endDate: l.endDate, workingDays: l.workingDays })),
    interviews: employee.interviews.filter(i => !i.withdrawn)
      .map(i => ({ id: i.id, company: i.company, role: i.role, date: i.date, stage: i.stage, outcome: i.outcome })),
    history: employee.history.map(h => ({ id: h.id, role: h.role, employer: h.company, period: h.period })),
    pastProjects: employee.backfilledProjects.filter(p => p.status === "active")
      .map(p => ({ id: p.id, client: p.client, projectName: p.projectName, completionDate: p.completionDate })),
    assignments: employee.assignments.map(a => ({ id: a.id, client: a.client, projectName: a.projectName, status: a.status })),
    skills: employee.skills.map(s => ({ name: s.name, level: s.level })),
    backfillDepartments: departments,
  };
}

/** The compact team view returned by read_team. */
function teamMember(employee: Employee) {
  const open = employee.assignments.find(a => a.status === "open");
  const evaluated = new Set(employee.evaluations.map(e => e.assignmentId));
  return {
    id: employee.id, name: employee.name, title: employee.title, archived: employee.archived === true,
    ...(employee.departmentId !== undefined ? { departmentId: employee.departmentId } : {}),
    openAssignment: open ? { id: open.id, client: open.client, projectName: open.projectName, role: open.role, allocation: open.allocation, startDate: open.startDate } : null,
    closedToEvaluate: employee.assignments.filter(a => a.status === "closed" && !evaluated.has(a.id))
      .map(a => ({ id: a.id, projectName: a.projectName, completionDate: a.completionDate })),
    leave: employee.leave.filter(l => !l.cancelledAt).map(l => ({ id: l.id, startDate: l.startDate, endDate: l.endDate })),
  };
}

// ---- staff tools ----

const staffTools: SimTool[] = [
  tool({
    name: "clock_in", roles: STAFF,
    description: "Clock in for today at the current time, choosing where you work today.",
    input: z.object({ workMode: z.enum(WORK_MODES) }).strict(),
    async run(ctx, { workMode }) {
      const { employeeId: me } = own(ctx);
      if (!ctx.member.attendance) throw new NoAttendanceError();
      return ctx.member.attendance.clockIn(me, { workMode }, ctx.clock.now());
    },
  }),
  tool({
    name: "clock_out", roles: STAFF,
    description: "Clock out for today at the current time, with your total break in whole minutes (0 for none).",
    input: z.object({ breakMinutes: z.number().int().min(0).max(1440) }).strict(),
    async run(ctx, { breakMinutes }) {
      const { employeeId: me } = own(ctx);
      if (!ctx.member.attendance) throw new NoAttendanceError();
      return ctx.member.attendance.clockOut(me, { breakMinutes }, ctx.clock.now());
    },
  }),
  tool({
    name: "save_work_log",
    roles: STAFF,
    description: "Save today's work log (you must be clocked in): a summary, blockers (empty for none) and 1 to 8 tasks with hours in quarter hours and an optional http(s) link. Task hours may not exceed the time worked.",
    input: z.object({
      summary: text(2000),
      blockers: text(1000, 0),
      tasks: z.array(z.object({
        description: text(300),
        hours: z.number().positive().max(24).multipleOf(0.25),
        link: z.string().trim().max(2000).refine(isHttpUrl, "A link must start with http:// or https://.").nullable(),
      }).strict()).min(1).max(8),
    }).strict(),
    async run(ctx, { summary, blockers, tasks }) {
      const { employeeId: me } = own(ctx);
      if (!ctx.member.attendance) throw new NoAttendanceError();
      return ctx.member.attendance.saveLog(me, {
        summary, blockers, tasks: tasks.map(t => ({ description: t.description, hours: String(t.hours), link: t.link ?? "" })),
      }, ctx.clock.now());
    },
  }),
  tool({
    name: "record_leave", roles: STAFF,
    description: "Record your own leave from startDate to endDate (inclusive). Weekends and public holidays are not counted; overlapping leave is refused.",
    input: z.object({ startDate: isoDate("start date"), endDate: isoDate("end date") }).strict(),
    async run(ctx, input) {
      const leave = await ctx.stores.leave.record(ctx.member.session, own(ctx).employeeId, input);
      return said("Leave recorded.", { id: leave.id, startDate: leave.startDate, endDate: leave.endDate, workingDays: leave.workingDays, category: leave.category });
    },
  }),
  tool({
    name: "edit_leave", roles: STAFF,
    description: "Change the dates of one of your recorded (not cancelled) leave periods.",
    input: z.object({ leaveId: id(), startDate: isoDate("start date"), endDate: isoDate("end date") }).strict(),
    async run(ctx, { leaveId, startDate, endDate }) {
      const leave = await ctx.stores.leave.update(ctx.member.session, leaveId, { startDate, endDate });
      return said("Leave changed.", { id: leave.id, startDate: leave.startDate, endDate: leave.endDate, workingDays: leave.workingDays });
    },
  }),
  tool({
    name: "cancel_leave", roles: STAFF,
    description: "Cancel one of your recorded leave periods (it stays in history, marked cancelled).",
    input: z.object({ leaveId: id() }).strict(),
    async run(ctx, { leaveId }) {
      const leave = await ctx.stores.leave.cancel(ctx.member.session, leaveId);
      return said("Leave cancelled.", { id: leave.id, startDate: leave.startDate, endDate: leave.endDate });
    },
  }),
  tool({
    name: "add_interview", roles: STAFF,
    description: "Record an external job interview you had. Company, role and date cannot be changed afterwards. Visible only to you and the Administrator.",
    input: z.object({
      company: text(200), role: text(200), date: isoDate("interview date"), stage: text(200), outcome: text(200, 0).nullable(),
    }).strict(),
    async run(ctx, input) {
      const interview = await ctx.stores.interviews.add(own(ctx), { ...input, outcome: input.outcome ?? "" });
      return said("Interview added.", { id: interview.id, company: interview.company, role: interview.role, date: interview.date, stage: interview.stage });
    },
  }),
  tool({
    name: "update_interview", roles: STAFF,
    description: "Update the stage, outcome and feedback of one of your interviews (company, role and date are locked).",
    input: z.object({ interviewId: id(), stage: text(200), outcome: text(200, 0).nullable(), feedback: text(2000, 0).nullable() }).strict(),
    async run(ctx, { interviewId, stage, outcome, feedback }) {
      const interview = await ctx.stores.interviews.update(own(ctx), interviewId, { stage, outcome: outcome ?? "", feedback: feedback ?? "" });
      return said("Interview updated.", { id: interview.id, stage: interview.stage, outcome: interview.outcome });
    },
  }),
  tool({
    name: "withdraw_interview", roles: STAFF,
    description: "Withdraw one of your interviews (it stays in history, marked withdrawn).",
    input: z.object({ interviewId: id() }).strict(),
    async run(ctx, { interviewId }) {
      const interview = await ctx.stores.interviews.withdraw(own(ctx), interviewId);
      return said("Interview withdrawn.", { id: interview.id, company: interview.company });
    },
  }),
  tool({
    name: "backfill_project", roles: STAFF,
    description: "Add a past project you completed before this system existed. departmentId must be one of the backfillDepartments in read_my_record; the completion date may not be in the future.",
    input: z.object({
      departmentId: id(), client: text(BACKFILL_TEXT_MAX), projectName: text(BACKFILL_TEXT_MAX),
      completionDate: isoDate("completion date"), outcome: text(BACKFILL_OUTCOME_MAX),
    }).strict(),
    async run(ctx, input) {
      const project = await ctx.stores.backfilled.add(own(ctx), input);
      return said("Past project added.", { id: project.id, projectName: project.projectName, completionDate: project.completionDate });
    },
  }),
  tool({
    name: "add_employment_history", roles: STAFF,
    description: "Add an entry to your own employment history. The period must contain a four-digit year, like \"2021 - 2023\" or \"Mar 2023 - Present\".",
    input: z.object({
      role: text(ROLE_MAX), employer: text(EMPLOYER_MAX),
      period: text(PERIOD_MAX).refine(hasPeriodYear, "Include a four-digit year in the period."),
      detail: text(DETAIL_MAX, 0).nullable(),
    }).strict(),
    async run(ctx, input) {
      const me = own(ctx);
      const entry = await ctx.stores.history.add(me, me.employeeId, { ...input, detail: input.detail ?? "" });
      return said("Employment history entry added.", { id: entry.id, role: entry.role, employer: entry.company, period: entry.period });
    },
  }),
  tool({
    name: "edit_employment_history", roles: STAFF,
    description: "Change one of your employment history entries (all fields are replaced).",
    input: z.object({
      entryId: id(), role: text(ROLE_MAX), employer: text(EMPLOYER_MAX),
      period: text(PERIOD_MAX).refine(hasPeriodYear, "Include a four-digit year in the period."),
      detail: text(DETAIL_MAX, 0).nullable(),
    }).strict(),
    async run(ctx, { entryId, ...input }) {
      const entry = await ctx.stores.history.update(own(ctx), entryId, { ...input, detail: input.detail ?? "" });
      return said("Employment history entry changed.", { id: entry.id, role: entry.role, employer: entry.company, period: entry.period });
    },
  }),
  tool({
    name: "remove_employment_history", roles: STAFF,
    description: "Remove one of your employment history entries.",
    input: z.object({ entryId: id() }).strict(),
    async run(ctx, { entryId }) {
      const entry = await ctx.stores.history.remove(own(ctx), entryId);
      return said("Employment history entry removed.", { id: entry.id, role: entry.role, employer: entry.company });
    },
  }),
  tool({
    name: "read_my_record", roles: STAFF,
    description: "Read your own record: leave, interviews, employment history, past projects, assignments, skills, and the departments a past project can be filed under.",
    input: z.object({}).strict(),
    async run(ctx) {
      const me = own(ctx);
      const employee = await ctx.stores.employees.getFor(me, me.employeeId);
      if (!employee) return json({ found: false });
      return json(myRecord(employee, await ctx.stores.backfilled.departmentOptions()));
    },
  }),
];

// ---- manager tools (the Administrator gets them too; the stores scope them org-wide) ----

const managerTools: SimTool[] = [
  tool({
    name: "read_team", roles: MANAGERS,
    description: "Read the employees you manage: open assignment, closed assignments still to evaluate, and recorded leave.",
    input: z.object({}).strict(),
    async run(ctx) {
      return fitJsonList((await ctx.stores.employees.listFor(ctx.member.session)).map(teamMember));
    },
  }),
  tool({
    name: "create_assignment", roles: MANAGERS,
    description: "Assign an employee to a client project. An employee can have only one open assignment. startDate null means today.",
    input: z.object({
      employeeId: employeeId(), client: text(ASSIGNMENT_TEXT_MAX), projectName: text(ASSIGNMENT_TEXT_MAX), role: text(ASSIGNMENT_TEXT_MAX),
      allocation: z.number().int().min(0).max(100), startDate: isoDate("start date").nullable(),
    }).strict(),
    async run(ctx, { employeeId: target, startDate, ...input }) {
      const assignment = await ctx.stores.assignments.create(ctx.member.session, target, { ...input, startDate: startDate ?? ctx.clock.today() });
      return said("Assignment created.", { id: assignment.id, employeeId: assignment.employeeId, projectName: assignment.projectName, startDate: assignment.startDate });
    },
  }),
  tool({
    name: "update_assignment_note", roles: MANAGERS,
    description: "Replace the latest-update note of an open assignment.",
    input: z.object({ assignmentId: id(), note: text(ASSIGNMENT_NOTE_MAX, 0) }).strict(),
    async run(ctx, { assignmentId, note }) {
      const assignment = await ctx.stores.assignments.updateNote(ctx.member.session, assignmentId, note);
      return said("Assignment note updated.", { id: assignment.id, latestUpdate: assignment.latestUpdate });
    },
  }),
  tool({
    name: "close_assignment", roles: MANAGERS,
    description: "Close an open assignment on its completion date (null means today).",
    input: z.object({ assignmentId: id(), completionDate: isoDate("completion date").nullable() }).strict(),
    async run(ctx, { assignmentId, completionDate }) {
      const assignment = await ctx.stores.assignments.close(ctx.member.session, assignmentId, completionDate ?? ctx.clock.today());
      return said("Assignment closed.", { id: assignment.id, completionDate: assignment.completionDate });
    },
  }),
  tool({
    name: "evaluate_assignment", roles: MANAGERS,
    description: "Write the evaluation of a closed assignment, with optional client feedback. One evaluation per assignment.",
    input: z.object({ assignmentId: id(), evaluation: text(EVALUATION_MAX), clientFeedback: text(CLIENT_FEEDBACK_MAX, 0).nullable() }).strict(),
    async run(ctx, { assignmentId, evaluation, clientFeedback }) {
      const result = await ctx.stores.evaluations.create(ctx.member.session, assignmentId, { evaluation, clientFeedback: clientFeedback ?? "" });
      return said("Assignment evaluated.", { id: result.id, assignmentId: result.assignmentId, employeeId: result.employeeId });
    },
  }),
  tool({
    name: "rate_skill", roles: MANAGERS,
    description: "Rate one of an employee's skills from 1 (foundational) to 5 (expert), with the supporting evidence.",
    input: z.object({
      employeeId: employeeId(), name: text(SKILL_NAME_MAX), level: z.number().int().min(1).max(5), evidence: text(SKILL_EVIDENCE_MAX),
    }).strict(),
    async run(ctx, { employeeId: target, ...input }) {
      const result = await ctx.stores.assessments.rateSkill(ctx.member.session, target, input);
      return said("Skill rated.", { employeeId: result.employeeId, skill: input.name, level: input.level });
    },
  }),
  tool({
    name: "save_evaluation", roles: MANAGERS,
    description: "Save an employee's evaluation summary: strengths, development priorities and readiness.",
    input: z.object({
      employeeId: employeeId(), strengths: text(EVALUATION_TEXT_MAX), developmentPriorities: text(EVALUATION_TEXT_MAX), readiness: text(READINESS_MAX),
    }).strict(),
    async run(ctx, { employeeId: target, ...input }) {
      const result = await ctx.stores.assessments.saveEvaluation(ctx.member.session, target, input);
      return said("Evaluation saved.", { employeeId: result.employeeId });
    },
  }),
  tool({
    name: "record_team_leave", roles: MANAGERS,
    description: "Record leave for an employee you manage, from startDate to endDate (inclusive).",
    input: z.object({ employeeId: employeeId(), startDate: isoDate("start date"), endDate: isoDate("end date") }).strict(),
    async run(ctx, { employeeId: target, ...input }) {
      const leave = await ctx.stores.leave.record(ctx.member.session, target, input);
      return said("Leave recorded.", { id: leave.id, employeeId: leave.employeeId, startDate: leave.startDate, endDate: leave.endDate, workingDays: leave.workingDays });
    },
  }),
  tool({
    name: "transfer_employee", roles: MANAGERS,
    description: "Move an employee to another department. You need authority over both departments, and an employee with an open assignment cannot be moved.",
    input: z.object({ employeeId: employeeId(), toDepartmentId: id() }).strict(),
    async run(ctx, { employeeId: target, toDepartmentId }) {
      return said("Employee transferred.", await ctx.stores.employees.transfer(ctx.member.session, target, toDepartmentId));
    },
  }),
  tool({
    name: "export_department_activity", roles: MANAGERS,
    description: "Export an activity timeline CSV for one employee you manage (employeeId) or for everyone you manage (employeeId null). period: this-week, last-week, month (month and year), year (year), custom (from and to) or all; unused fields are null. Returns the filename and row count.",
    input: z.object({ employeeId: employeeId().nullable(), ...periodFields }).strict(),
    async run(ctx, { employeeId: target, ...period }) {
      const session = exporter(ctx);
      const { stores, member } = ctx;
      const records = { assignments: stores.assignments, backfilledProjects: stores.backfilled, evaluations: stores.evaluations, leave: stores.leave };
      const result = target
        ? await exportActivity(
          { ...records, employees: stores.employees, attendance: stores.attendance, interviews: stores.interviews, training: stores.training, audit: ctx.serviceAudit },
          session, member.userId, { employeeId: target, ...periodInput(period) }, ctx.clock.now(),
        )
        : await exportAllActivity(
          { ...records, employees: stores.employees, attendance: stores.attendance, training: stores.training, audit: ctx.serviceAudit, scope: stores.scope },
          session, member.userId, { ...periodInput(period), includeArchived: "" }, ctx.clock.now(),
        );
      return exported(result);
    },
  }),
];

// ---- Administrator-only tools ----

const adminTools: SimTool[] = [
  tool({
    name: "create_department", roles: ADMIN,
    description: "Create a department, under parentId (null for a top-level department). Names are unique.",
    input: z.object({ name: text(DEPARTMENT_NAME_MAX), parentId: id().nullable() }).strict(),
    async run(ctx, input) {
      const department = await ctx.stores.departments.create(ctx.member.session, input);
      return said("Department created.", { id: department.id, name: department.name, parentId: department.parentId });
    },
  }),
  tool({
    name: "update_department", roles: ADMIN,
    description: "Rename a department and/or move it under another parent (null for top level).",
    input: z.object({ departmentId: id(), name: text(DEPARTMENT_NAME_MAX), parentId: id().nullable() }).strict(),
    async run(ctx, { departmentId, ...input }) {
      const department = await ctx.stores.departments.update(ctx.member.session, departmentId, input);
      return said("Department updated.", { id: department.id, name: department.name, parentId: department.parentId });
    },
  }),
  tool({
    name: "set_department_manager", roles: ADMIN,
    description: "Set a department's manager to an employee with a sign-in account, or remove the manager (employeeId null).",
    input: z.object({ departmentId: id(), employeeId: employeeId().nullable() }).strict(),
    async run(ctx, { departmentId, employeeId: manager }) {
      const department = await ctx.stores.departments.setManager(ctx.member.session, departmentId, manager);
      return said(manager ? "Department manager set." : "Department manager removed.", { id: department.id, managerEmployeeId: department.managerEmployeeId });
    },
  }),
  tool({
    name: "export_all_activity", roles: ADMIN,
    description: "Export the activity timeline CSV of every employee (archived ones too when includeArchived). Period fields as in export_department_activity. Returns the filename and row count.",
    input: z.object({ ...periodFields, includeArchived: z.boolean() }).strict(),
    async run(ctx, { includeArchived, ...period }) {
      const session = exporter(ctx);
      const { stores, member } = ctx;
      const result = await exportAllActivity(
        {
          employees: stores.employees, attendance: stores.attendance, training: stores.training, audit: ctx.serviceAudit, scope: stores.scope,
          assignments: stores.assignments, backfilledProjects: stores.backfilled, evaluations: stores.evaluations, leave: stores.leave,
        },
        session, member.userId, { ...periodInput(period), includeArchived: includeArchived ? "on" : "" }, ctx.clock.now(),
      );
      return exported(result);
    },
  }),
];

/** Every persona tool, in catalogue order. */
export const TOOLS: readonly SimTool[] = [...staffTools, ...managerTools, ...adminTools];

/** Exactly the tools of one role (staff 14, manager 10, admin 14). */
export function toolsFor(role: PersonaRole): SimTool[] {
  return TOOLS.filter(t => t.roles.includes(role));
}
