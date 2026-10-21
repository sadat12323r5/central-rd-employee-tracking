import type { z } from "zod";
import type { AssessmentsStore } from "@/server/assessments-store";
import type { AssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import type { AssignmentsStore } from "@/server/assignments-store";
import type { AttendanceStore } from "@/server/attendance-store";
import type { AuditStore } from "@/server/audit-store";
import type { BackfilledProjectStore } from "@/server/backfilled-project-store";
import type { DepartmentsStore } from "@/server/departments-store";
import type { EmployeesStore } from "@/server/employees-store";
import type { EmploymentHistoryStore } from "@/server/employment-history-store";
import type { InterviewsStore } from "@/server/interviews-store";
import type { LeaveStore } from "@/server/leave-store";
import type { ManagerScope } from "@/server/manager-scope";
import type { TrainingStore } from "@/server/training-store";
import type { CohortMember } from "../cohort";
import type { PersonaRole } from "../personas";
import type { Timeline } from "../timeline";

// Story 9.2: the SDK-agnostic persona tool layer's types. A tool is a strict zod input plus a `run` that
// calls one app store method under the persona's own session, with the persona's own stores (its own JWT
// client, so RLS applies) and the simulated clock. Nothing here knows about any model SDK.

/** The simulated clock: every "now" and "today" a tool uses. */
export type SimClock = {
  now(): Date;
  /** The ISO date (YYYY-MM-DD) of `now()` in Asia/Dhaka. */
  today(): string;
};

export type { PersonaRole };

/** The app stores a persona's tools call, each built on that persona's own signed-in client. */
export type ToolStores = {
  employees: Pick<EmployeesStore, "getFor" | "listFor" | "transfer">;
  leave: Pick<LeaveStore, "record" | "update" | "cancel" | "listFor">;
  interviews: Pick<InterviewsStore, "add" | "update" | "withdraw" | "listFor">;
  backfilled: Pick<BackfilledProjectStore, "add" | "listFor" | "departmentOptions">;
  history: Pick<EmploymentHistoryStore, "add" | "update" | "remove">;
  assignments: Pick<AssignmentsStore, "create" | "updateNote" | "close" | "listFor">;
  evaluations: Pick<AssignmentEvaluationsStore, "create" | "listFor">;
  assessments: Pick<AssessmentsStore, "rateSkill" | "saveEvaluation">;
  departments: Pick<DepartmentsStore, "create" | "update" | "setManager">;
  /** Export reads only (attendance writes go through the member's attendance commands). */
  attendance: Pick<AttendanceStore, "listFor" | "listAll">;
  training: Pick<TrainingStore, "listFor" | "currentFor">;
  scope: Pick<ManagerScope, "forManager">;
};

/** The export audit store: the one service-role writer (as in activity-actions.ts). */
export type ServiceAudit = Pick<AuditStore, "recordActivityExport" | "recordBulkActivityExport" | "recordDepartmentActivityExport">;

export type ToolContext = {
  member: CohortMember;
  stores: ToolStores;
  clock: SimClock;
  timeline: Pick<Timeline, "record">;
  serviceAudit: ServiceAudit;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodObject = z.ZodObject<any>;

export type SimTool<Input extends AnyZodObject = AnyZodObject> = {
  name: string;
  description: string;
  /** The roles whose tool set includes this tool. */
  roles: readonly PersonaRole[];
  /** A strict object: unknown keys are refused; every property is required (optional ones are nullable). */
  input: Input;
  /** Calls one app store method; returns the success text, throws the app's error on a refusal. */
  run(ctx: ToolContext, input: z.infer<Input>): Promise<string>;
};

/** A tool call's result, in the app's `{ error, message }` action shape. */
export type ToolOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string; message: string; code?: string; cause?: string };
