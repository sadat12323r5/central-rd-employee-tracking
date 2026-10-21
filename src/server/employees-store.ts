import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Employee, LeaveRecord } from "@/data/employees";
import {
  derivedFields, invalidEmployeeDetailsFields, invalidNewEmployeeFields, normalizeEmployeeDetails, normalizeNewEmployee,
  type EmployeeDetailsInput, type NewEmployeeField, type NewEmployeeInput,
} from "@/domain/employee-input";
import {
  assessmentsStore, AssessmentsUnavailableError, createAssessmentsStore, type Assessments, type AssessmentsStore,
} from "./assessments-store";
import {
  assignmentEvaluationsStore, EvaluationsUnavailableError, type AssignmentEvaluation, type AssignmentEvaluationsStore,
} from "./assignment-evaluations-store";
import { assignmentsStore, AssignmentsUnavailableError, type Assignment, type AssignmentsStore } from "./assignments-store";
import {
  backfilledProjectStore, BackfillUnavailableError, type BackfilledProject, type BackfilledProjectStore,
} from "./backfilled-project-store";
import {
  createEmploymentHistoryStore, employmentHistoryStore, EmploymentHistoryUnavailableError, type EmploymentHistoryEntry,
  type EmploymentHistoryStore,
} from "./employment-history-store";
import { createLeaveStore, leaveStore, LeaveUnavailableError, type LeaveStore } from "./leave-store";
import { interviewsStore, InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "./interviews-store";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import type { ManagerIdentity, SessionIdentity, StaffIdentity } from "./session";
import { readAllPages } from "./paging";
import { getUserClient } from "./supabase";
import { trainingStore, TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "./training-store";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table, external interviews from the `external_interviews` table (through interviews-store,
// Story 2.1), training through training-store (Story 3.1), assignments through assignments-store
// (Story 4.5), skills and the evaluation (`review`) through assessments-store (Story 7.4) and employment
// history through employment-history-store (Story 7.3, active entries, newest first) and leave through
// leave-store (Story 5.2, newest start first, cancelled periods included and marked). The attendance
// summary is not part of a profile: it is computed from real records by attendance-summary (Story 5.4).
// The fixture's interviews, training, former "current work", skills, review and history are never read here.
//
// Every read (Administrator and Staff, Story 1.3) goes through a per-request client carrying the
// signed-in user's Supabase JWT, so the employees RLS policies are the enforced rule: an admin
// reads every row, a staff member only the row linked to their auth user (`auth_user_id`). The
// staff-own scoping below is kept as defence in depth. This module never uses the service role.
// Archived employees (Story 1.4, `archived_at` set) stay readable by Administrators, who see the
// `archived` flag; `isActive` lets auth.ts end an archived Staff member's session on every request.
//
// Story 4.3: a department manager reads the employees in their department subtree (manager-scope,
// computed fresh on each call), archived ones included and flagged, with their department; never
// `auth_user_id` and never interviews. RLS (employees_select_managed) bounds the same rows.
// Story 4.5: every role's profiles carry their assignments (scoped the same way by assignments-store).
// Story 4.6: and the evaluations of those assignments (scoped by assignment-evaluations-store).
// Story 4.7: and the employee's self-reported past projects (scoped by backfilled-project-store).
//
// Story 7.1: `create` adds a new employee through the same per-request client (never the service role).
// The Administrator may add to any department, a manager only to a department in their subtree (checked
// here against manager-scope, and again by the employees_insert_* RLS policies); Staff never. The
// department is required. Status, initials, avatar colour and summary are derived, never taken from the
// input, and the row never carries an account link or an archived flag: accounts come only from
// accounts-store (Story 1.3). Story 9.1: a server-side caller (the simulator) may pass a `summary` create
// option instead of the derived empty one; employee-actions never passes it.
//
// Story 7.2: `updateDetails` edits an existing employee's title, team, reporting manager, office and
// employment type through the per-request client's rpc to public.update_employee_details (a SECURITY
// DEFINER function that names only those five columns; there is no update policy on employees). The
// Administrator may edit anyone, a manager only employees in their subtree (checked here against
// manager-scope before the rpc, and again by the function); Staff never, not even their own record.
// The department never changes here: only through a transfer.
//
// Story 4.8: transfer() (FR-11) is the only way the app changes an employee's department. It calls the
// SECURITY DEFINER function `transfer_employee` through the actor's own JWT (Administrator and manager
// alike, never the service role), which takes the actor from auth.uid(), re-checks authority over both
// departments, refuses a transfer while an assignment is open, and writes the change and one audit row in
// one transaction. Staff are refused before any call; managers are pre-checked against their scope here.
export interface EmployeesStore {
  /** Every employee for an admin; the department subtree's employees for a manager; only the caller's own record for staff. */
  listFor(session: SessionIdentity): Promise<Employee[]>;
  /** The employee, or null when it does not exist or is outside the caller's scope. */
  getFor(session: SessionIdentity, id: string): Promise<Employee | null>;
  /**
   * True when the staff session's own employee row is visible to its JWT (RLS) and not archived.
   * False when the row is missing, unlinked or archived. Throws EmployeesUnavailableError on a read error.
   */
  isActive(session: StaffIdentity): Promise<boolean>;
  /**
   * Story 7.1: adds a new employee. Throws EmployeeForbiddenError (Staff, or a department outside a
   * manager's subtree), EmployeeValidationError (bad input, unknown department), EmployeeExistsError
   * (duplicate Employee ID or email) or EmployeesUnavailableError. Never creates a sign-in account.
   */
  create(session: SessionIdentity, input: NewEmployeeInput, options?: EmployeeCreateOptions): Promise<{ employeeId: string; name: string }>;
  /**
   * Story 7.2: saves an employee's title, team, reporting manager, office and employment type (nothing
   * else). Throws EmployeeForbiddenError (Staff, or an employee outside a manager's subtree),
   * EmployeeValidationError (bad input), EmployeeNotFoundError (no such employee) or EmployeesUnavailableError.
   */
  updateDetails(session: SessionIdentity, employeeId: string, input: EmployeeDetailsInput): Promise<{ employeeId: string; name: string }>;
  /**
   * Story 4.10: the employee id linked to an auth user (`auth_user_id`), read through the signed-in user's
   * JWT (RLS). Null when no row is linked or the linked row is archived. Throws EmployeesUnavailableError
   * on a read error (including more than one linked row).
   */
  linkedEmployeeId(userId: string): Promise<string | null>;
  /**
   * Story 4.8: moves the employee to another department and records one audit row, in one transaction.
   * Throws TransferInvalidError (bad id format), TransferForbiddenError (Staff, out of a manager's scope, or
   * refused by the database), TransferNotFoundError, TransferDepartmentError (unknown destination),
   * TransferSameDepartmentError, TransferOpenAssignmentError, or EmployeesUnavailableError for anything else.
   */
  transfer(session: SessionIdentity, employeeId: string, toDepartmentId: string): Promise<TransferResult>;
}

/** The longest `summary` a server-side caller may set on create (Story 9.1). */
export const EMPLOYEE_SUMMARY_MAX = 500;

/**
 * Story 9.1: server-only create options. `summary` (trimmed, at most EMPLOYEE_SUMMARY_MAX characters) replaces
 * the derived empty summary; the simulator uses it for its cohort label. No HTTP path passes it.
 */
export type EmployeeCreateOptions = { summary?: string };

/** The caller may not add or edit this employee: a Staff session, or outside a manager's subtree. */
export class EmployeeForbiddenError extends Error {
  constructor() {
    super("Only an Administrator, or a manager for their own department subtree, can add or edit employees.");
    this.name = "EmployeeForbiddenError";
  }
}

/**
 * The input failed validation. `fields` names the offending inputs; values are never included.
 * `"details"` means the database function refused the basic details without naming a field (Story 7.2);
 * `"summary"` is the server-only create option (Story 9.1).
 */
export class EmployeeValidationError extends Error {
  readonly fields: (NewEmployeeField | "details" | "summary")[];
  constructor(fields: (NewEmployeeField | "details" | "summary")[]) {
    super(`Invalid employee details: ${fields.join(", ")}.`);
    this.name = "EmployeeValidationError";
    this.fields = fields;
  }
}

/** An employee with this Employee ID or primary email already exists. */
export class EmployeeExistsError extends Error {
  readonly field: "employeeId" | "email";
  constructor(field: "employeeId" | "email") {
    super(field === "employeeId" ? "An employee with this Employee ID already exists." : "An employee with this email already exists.");
    this.name = "EmployeeExistsError";
    this.field = field;
  }
}

/** Story 7.2: there is no employee with this Employee ID. */
export class EmployeeNotFoundError extends Error {
  constructor() {
    super("No employee has this Employee ID.");
    this.name = "EmployeeNotFoundError";
  }
}

/** The outcome of a transfer. `fromDepartmentId` was read before the change and is informational only. */
export type TransferResult = { employeeId: string; name: string; fromDepartmentId: string | null; toDepartmentId: string };

/** The transfer input is malformed. `fields` names the offending inputs. */
export class TransferInvalidError extends Error {
  readonly fields: ("employeeId" | "toDepartmentId")[];
  constructor(fields: ("employeeId" | "toDepartmentId")[]) {
    super(`Invalid transfer: ${fields.join(", ")}.`);
    this.name = "TransferInvalidError";
    this.fields = fields;
  }
}

/** The caller has no authority over the employee's department or the destination (or is Staff). */
export class TransferForbiddenError extends Error {
  constructor() {
    super("Not allowed to move this employee to that department.");
    this.name = "TransferForbiddenError";
  }
}

/** No such employee. */
export class TransferNotFoundError extends Error {
  constructor() {
    super("Employee not found.");
    this.name = "TransferNotFoundError";
  }
}

/** The destination department does not exist. */
export class TransferDepartmentError extends Error {
  constructor() {
    super("No such department.");
    this.name = "TransferDepartmentError";
  }
}

/** The destination is the employee's current department. */
export class TransferSameDepartmentError extends Error {
  constructor() {
    super("The employee is already in that department.");
    this.name = "TransferSameDepartmentError";
  }
}

/** The employee has an open assignment; it must be closed before a transfer. */
export class TransferOpenAssignmentError extends Error {
  constructor() {
    super("The employee has an open assignment.");
    this.name = "TransferOpenAssignmentError";
  }
}

const transferInput = z.object({
  employeeId: z.string().trim().regex(/^BS-\d{4}$/),
  toDepartmentId: z.string().trim().pipe(z.uuid()),
});

/** The employee database is unreachable or returned an error. Never treat this as "no employees". */
export class EmployeesUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Employee records are temporarily unavailable.", options);
    this.name = "EmployeesUnavailableError";
  }
}

export type EmployeeRow = {
  employee_id: string; name: string; title: string; team: string; employment_type: string; email: string;
  joined_on: string; manager: string; office: string; status: Employee["status"]; initials: string;
  avatar_color: string; summary: string;
  /** Selected on Administrator reads only (never for managers); mapped to `hasAccount`. */
  auth_user_id?: string | null;
  /** Selected on Administrator and manager reads; mapped to `archived`. */
  archived_at?: string | null;
  /** Selected on Administrator and manager reads; mapped to `departmentId` (Story 4.1). */
  department_id?: string | null;
};

const COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary";
/**
 * Administrators also see whether each employee has a linked sign-in account, whether it is archived,
 * and its department (Story 4.1; names are read separately through departments-store, never embedded).
 */
const ADMIN_COLUMNS = `${COLUMNS},auth_user_id,archived_at,department_id`;
/** Story 4.3: managers see each employee's department and whether it is archived, never the sign-in account link. */
const MANAGER_COLUMNS = `${COLUMNS},department_id,archived_at`;

/** Which extra fields a read maps: Administrator (account, archived, department), manager (archived, department) or none. */
export type EmployeeView = "admin" | "manager" | "basic";

/** No evaluation recorded yet: every field empty (the UI says so rather than showing a blank date). */
export const emptyReview = (): Employee["review"] => ({ date: "", reviewer: "", readiness: "", strengths: "", next: "" });

/** The skills of one employee, in the store's order (strongest first), without the store's `employeeId`. */
const skillsOf = (all: Assessments, employeeId: string): Employee["skills"] =>
  all.skills.filter(s => s.employeeId === employeeId).map(({ name, level, evidence }) => ({ name, level, evidence }));

/** The evaluation of one employee as the profile's `review`; none yet → all empty. */
const reviewOf = (all: Assessments, employeeId: string): Employee["review"] => {
  const evaluation = all.evaluations.find(e => e.employeeId === employeeId);
  return evaluation
    ? { date: evaluation.reviewedOn, reviewer: evaluation.reviewer, readiness: evaluation.readiness, strengths: evaluation.strengths, next: evaluation.developmentPriorities }
    : emptyReview();
};

/**
 * Maps a row to an Employee with the given interviews (from interviews-store), training (from
 * training-store), assignments (from assignments-store, Story 4.5), assignment evaluations (Story 4.6), backfilled projects (Story 4.7), and skills and review (from assessments-store, Story 7.4), and employment history (from employment-history-store, Story 7.3), and leave (from leave-store, Story 5.2). The `admin` view (`true` is the same) adds `hasAccount` from `auth_user_id`,
 * `archived` from `archived_at` and `departmentId` from `department_id`; the `manager` view (Story 4.3)
 * adds `archived` and `departmentId` only.
 */
export function toEmployee(
  row: EmployeeRow, view: EmployeeView | boolean = "basic", interviews: Employee["interviews"] = [], training: Employee["training"] = [],
  assignments: Employee["assignments"] = [], evaluations: Employee["evaluations"] = [],
  backfilledProjects: Employee["backfilledProjects"] = [],
  skills: Employee["skills"] = [], review: Employee["review"] = emptyReview(),
  history: Employee["history"] = [],
  leave: Employee["leave"] = [],
): Employee {
  const mode = view === true ? "admin" : view === false ? "basic" : view;
  return {
    id: row.employee_id, name: row.name, title: row.title, team: row.team, type: row.employment_type, email: row.email,
    joined: row.joined_on, manager: row.manager, location: row.office, status: row.status, initials: row.initials,
    color: row.avatar_color, summary: row.summary,
    ...(mode === "admin" ? { hasAccount: Boolean(row.auth_user_id) } : {}),
    ...(mode !== "basic" ? { archived: Boolean(row.archived_at), departmentId: row.department_id ?? null } : {}),
    skills,
    review,
    history,
    training,
    interviews,
    assignments,
    evaluations,
    backfilledProjects,
    leave,
  };
}

/** The interviews of one employee, without the store's `employeeId` (implied by the profile). */
const interviewsOf = (all: ExternalInterview[], employeeId: string): Employee["interviews"] =>
  all.filter(i => i.employeeId === employeeId).map(({ employeeId: _, ...interview }) => interview);

/** The training of one employee, in the store's order, without the store's `employeeId`. */
const trainingOf = (all: TrainingEntry[], employeeId: string): Employee["training"] =>
  all.filter(t => t.employeeId === employeeId).map(({ employeeId: _, ...entry }) => entry);

/** The assignments of one employee, in the store's order (open first, then history). */
const assignmentsOf = (all: Assignment[], employeeId: string): Employee["assignments"] =>
  all.filter(a => a.employeeId === employeeId);

/** The assignment evaluations of one employee (Story 4.6). */
const evaluationsOf = (all: AssignmentEvaluation[], employeeId: string): Employee["evaluations"] =>
  all.filter(e => e.employeeId === employeeId);

/** The backfilled projects of one employee, in the store's order (newest completion first; Story 4.7). */
const backfilledOf = (all: BackfilledProject[], employeeId: string): Employee["backfilledProjects"] =>
  all.filter(b => b.employeeId === employeeId);

/** The employment history of one employee, in the store's order (newest first), without the store's extra fields. */
const historyOf = (all: EmploymentHistoryEntry[], employeeId: string): Employee["history"] =>
  all.filter(h => h.employeeId === employeeId).map(({ employeeId: _, createdAt: __, ...entry }) => entry);

/** The leave periods of one employee, in the store's order (newest start first; Story 5.2). */
const leaveOf = (all: LeaveRecord[], employeeId: string): Employee["leave"] =>
  all.filter(l => l.employeeId === employeeId);

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string; details?: string };

/** Maps an insert refusal to the store's typed errors; anything unrecognised is "unavailable". */
function insertRefusal(error: DbError): Error {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "23505") {
    if (/employees_pkey|\(employee_id\)/.test(text)) return new EmployeeExistsError("employeeId");
    if (/employees_email_key|\(email\)/.test(text)) return new EmployeeExistsError("email");
  }
  // 23503: no such department; 22P02: not even a valid department id.
  if (error.code === "23503" || error.code === "22P02") return new EmployeeValidationError(["departmentId"]);
  if (error.code === "42501") return new EmployeeForbiddenError();
  return new EmployeesUnavailableError({ cause: error });
}

/** Story 7.2: maps an update_employee_details refusal to the store's typed errors; anything else is "unavailable". */
function detailsRefusal(error: DbError): Error {
  switch (error.message) {
    case "not_authorized": return new EmployeeForbiddenError();
    case "invalid_input": return new EmployeeValidationError(["details"]);
    case "employee_not_found": return new EmployeeNotFoundError();
    default: return new EmployeesUnavailableError({ cause: error });
  }
}

export type EmployeesStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every read. */
  userClient: () => Promise<SupabaseClient>;
  /** Where profile interviews come from (RLS-scoped through the same per-request JWT). */
  interviews: Pick<InterviewsStore, "listFor">;
  /** Where profile training comes from (RLS-scoped through the same per-request JWT). */
  training: Pick<TrainingStore, "listFor">;
  /** Story 4.5: where profile assignments come from (RLS-scoped through the same per-request JWT). */
  assignments: Pick<AssignmentsStore, "listFor">;
  /** Story 4.6: where profile assignment evaluations come from (RLS-scoped through the same per-request JWT). */
  evaluations: Pick<AssignmentEvaluationsStore, "listFor">;
  /** Story 4.7: where profile backfilled projects come from (RLS-scoped through the same per-request JWT). */
  backfilled: Pick<BackfilledProjectStore, "listFor">;
  /** Story 7.4: where profile skills and the evaluation come from (default: an assessments-store on the same `userClient` and `scope`). */
  assessments?: Pick<AssessmentsStore, "listFor">;
  /**
   * Story 7.3: where profile employment history comes from (RLS-scoped through the same per-request JWT;
   * default: an employment-history-store on the same `userClient` and `scope`, like `assessments`).
   */
  history?: Pick<EmploymentHistoryStore, "listFor">;
  /**
   * Story 5.2: where profile leave comes from (RLS-scoped through the same per-request JWT; default: a
   * leave-store on the same `userClient` and `scope`, like `history`).
   */
  leave?: Pick<LeaveStore, "listFor">;
  /** Story 4.3: a manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createEmployeesStore({
  userClient, interviews, training, assignments, evaluations, backfilled, scope = managerScope,
  assessments = createAssessmentsStore({ userClient, scope }),
  history = createEmploymentHistoryStore({ userClient, scope }),
  leave = createLeaveStore({ userClient, scope }),
}: EmployeesStoreClients): EmployeesStore {
  async function run<T>(query: (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from("employees"));
    } catch (cause) {
      throw new EmployeesUnavailableError({ cause });
    }
    if (result.error) throw new EmployeesUnavailableError({ cause: result.error });
    return result.data;
  }

  /** A failed interviews read makes the whole record unavailable: never a profile with missing interviews. */
  async function interviewsFor(session: SessionIdentity, employeeId?: string): Promise<ExternalInterview[]> {
    try {
      return await interviews.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof InterviewsUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed training read makes the whole record unavailable: never a profile with missing training. */
  async function trainingFor(session: SessionIdentity, employeeId?: string): Promise<TrainingEntry[]> {
    try {
      return await training.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof TrainingUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed assignments read makes the whole record unavailable: never a profile with missing assignments. */
  async function assignmentsFor(session: SessionIdentity, employeeId?: string): Promise<Assignment[]> {
    try {
      return await assignments.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof AssignmentsUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed evaluations read makes the whole record unavailable: never a profile with missing evaluations. */
  async function evaluationsFor(session: SessionIdentity, employeeId?: string): Promise<AssignmentEvaluation[]> {
    try {
      return await evaluations.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof EvaluationsUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed backfilled-projects read makes the whole record unavailable: never a profile with missing past projects. */
  async function backfilledFor(session: SessionIdentity, employeeId?: string): Promise<BackfilledProject[]> {
    try {
      return await backfilled.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof BackfillUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed skills or evaluation read makes the whole record unavailable: never a profile with missing assessments. */
  async function assessmentsFor(session: SessionIdentity, employeeId?: string): Promise<Assessments> {
    try {
      return await assessments.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof AssessmentsUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed history read makes the whole record unavailable: never a profile with missing history. */
  async function historyFor(session: SessionIdentity, employeeId?: string): Promise<EmploymentHistoryEntry[]> {
    try {
      return await history.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof EmploymentHistoryUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed leave read makes the whole record unavailable: never a profile with missing leave. */
  async function leaveFor(session: SessionIdentity, employeeId?: string): Promise<LeaveRecord[]> {
    try {
      return await leave.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof LeaveUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  const columnsFor = (session: SessionIdentity) => (session.role === "admin" ? ADMIN_COLUMNS : COLUMNS);

  /** The employee ids in a manager's subtree. A scope that cannot be read makes the records unavailable: never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** Story 4.3: the manager's subtree, archived employees included and flagged. Interviews are always `[]`. */
  async function listForManager(session: ManagerIdentity): Promise<Employee[]> {
    const ids = await managedEmployeeIds(session);
    if (ids.size === 0) return [];
    const [rows, allTraining, allAssignments, allEvaluations, allBackfilled, allAssessments, allHistory, allLeave] = await Promise.all([
      // Paged (Story 8.2) like the Administrator list: employee_id is the primary key, so the order is total.
      readAllPages(async (from, to) => {
        const page = await run<EmployeeRow[]>(t => t.select(MANAGER_COLUMNS).in("employee_id", [...ids])
          .order("employee_id").range(from, to).returns<EmployeeRow[]>());
        if (!page) throw new EmployeesUnavailableError({ cause: "no data returned" });
        return page;
      }),
      trainingFor(session),
      assignmentsFor(session),
      evaluationsFor(session),
      backfilledFor(session),
      assessmentsFor(session),
      historyFor(session),
      leaveFor(session),
    ]);
    // Defence in depth: never a row outside the scope, whatever the query returned.
    return rows.filter(row => ids.has(row.employee_id))
      .map(row => toEmployee(
        row, "manager", [], trainingOf(allTraining, row.employee_id), assignmentsOf(allAssignments, row.employee_id),
        evaluationsOf(allEvaluations, row.employee_id), backfilledOf(allBackfilled, row.employee_id),
        skillsOf(allAssessments, row.employee_id), reviewOf(allAssessments, row.employee_id), historyOf(allHistory, row.employee_id),
        leaveOf(allLeave, row.employee_id),
      ));
  }

  async function getForManager(session: ManagerIdentity, id: string): Promise<Employee | null> {
    // Outside the subtree: null, without reading the employee.
    if (!(await managedEmployeeIds(session)).has(id)) return null;
    const row = await run<EmployeeRow>(t => t.select(MANAGER_COLUMNS).eq("employee_id", id).maybeSingle<EmployeeRow>());
    if (!row) return null;
    const [ownTraining, ownAssignments, ownEvaluations, ownBackfilled, own, ownHistory, ownLeave] = await Promise.all([
      trainingFor(session, id), assignmentsFor(session, id), evaluationsFor(session, id), backfilledFor(session, id),
      assessmentsFor(session, id), historyFor(session, id), leaveFor(session, id),
    ]);
    return toEmployee(
      row, "manager", [], trainingOf(ownTraining, id), assignmentsOf(ownAssignments, id), evaluationsOf(ownEvaluations, id),
      backfilledOf(ownBackfilled, id), skillsOf(own, id), reviewOf(own, id), historyOf(ownHistory, id), leaveOf(ownLeave, id),
    );
  }

  /** Story 7.1: the departments a manager may add employees to. Scope failure: unavailable, never "allowed". */
  async function managedDepartmentIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).departmentIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  return {
    async create(session, input, options = {}) {
      // Staff never add employees: refused before any query.
      if (session.role !== "admin" && session.role !== "manager") throw new EmployeeForbiddenError();
      const employee = normalizeNewEmployee(input);
      const invalid: (NewEmployeeField | "summary")[] = invalidNewEmployeeFields(employee);
      const summary = options.summary === undefined ? undefined : String(options.summary).trim();
      if (summary !== undefined && summary.length > EMPLOYEE_SUMMARY_MAX) invalid.push("summary");
      if (invalid.length > 0) throw new EmployeeValidationError(invalid);
      if (session.role === "manager" && !(await managedDepartmentIds(session)).has(employee.departmentId)) {
        throw new EmployeeForbiddenError();
      }
      const derived = derivedFields(employee);
      let result: { error: DbError | null };
      try {
        // No .select(): nothing is read back, so only the insert policies apply.
        result = await (await userClient()).from("employees").insert({
          employee_id: employee.employeeId, name: employee.name, title: employee.title, team: employee.team,
          employment_type: employee.employmentType, email: employee.email, joined_on: employee.joinedOn,
          manager: employee.manager, office: employee.office, department_id: employee.departmentId,
          status: derived.status, initials: derived.initials, avatar_color: derived.avatarColor, summary: summary ?? derived.summary,
        });
      } catch (cause) {
        throw new EmployeesUnavailableError({ cause });
      }
      if (result.error) throw insertRefusal(result.error);
      return { employeeId: employee.employeeId, name: employee.name };
    },
    async updateDetails(session, employeeId, input) {
      // Staff never edit basic details, not even their own: refused before any query.
      if (session.role !== "admin" && session.role !== "manager") throw new EmployeeForbiddenError();
      // Outside a manager's subtree: refused without calling the function.
      if (session.role === "manager" && !(await managedEmployeeIds(session)).has(employeeId)) {
        throw new EmployeeForbiddenError();
      }
      const details = normalizeEmployeeDetails(input);
      const invalid = invalidEmployeeDetailsFields(details);
      if (invalid.length > 0) throw new EmployeeValidationError(invalid);
      let result: { data: unknown; error: DbError | null };
      try {
        // Only the five basic-details fields are sent; the function updates nothing else.
        result = await (await userClient()).rpc("update_employee_details", {
          p_employee_id: employeeId, p_title: details.title, p_team: details.team, p_manager: details.manager,
          p_office: details.office, p_employment_type: details.employmentType,
        });
      } catch (cause) {
        throw new EmployeesUnavailableError({ cause });
      }
      if (result.error) throw detailsRefusal(result.error);
      if (typeof result.data !== "string") throw new EmployeesUnavailableError({ cause: "no employee name returned" });
      return { employeeId, name: result.data };
    },
    async listFor(session) {
      if (session.role === "manager") return listForManager(session);
      // One interviews, training, assignments, evaluations, backfilled-projects, assessments and history read for the whole list: everyone's for an admin, the caller's own for staff.
      const [rows, all, allTraining, allAssignments, allEvaluations, allBackfilled, allAssessments, allHistory, allLeave] = await Promise.all([
        // Paged (Story 8.2): one request is capped at PostgREST's max_rows. employee_id is the primary
        // key, so ordering by it alone is total.
        readAllPages(async (from, to) => {
          const page = await run<EmployeeRow[]>(t => {
            const query = t.select(columnsFor(session));
            return (session.role === "admin" ? query : query.eq("employee_id", session.employeeId))
              .order("employee_id").range(from, to).returns<EmployeeRow[]>();
          });
          if (!page) throw new EmployeesUnavailableError({ cause: "no data returned" });
          return page;
        }),
        interviewsFor(session),
        trainingFor(session),
        assignmentsFor(session),
        evaluationsFor(session),
        backfilledFor(session),
        assessmentsFor(session),
        historyFor(session),
        leaveFor(session),
      ]);
      return rows.map(row => toEmployee(
        row, session.role === "admin", interviewsOf(all, row.employee_id), trainingOf(allTraining, row.employee_id),
        assignmentsOf(allAssignments, row.employee_id), evaluationsOf(allEvaluations, row.employee_id),
        backfilledOf(allBackfilled, row.employee_id),
        skillsOf(allAssessments, row.employee_id), reviewOf(allAssessments, row.employee_id),
        historyOf(allHistory, row.employee_id), leaveOf(allLeave, row.employee_id),
      ));
    },
    async getFor(session, id) {
      if (session.role === "manager") return getForManager(session, id);
      if (session.role !== "admin" && id !== session.employeeId) return null;
      const row = await run<EmployeeRow>(t => t.select(columnsFor(session)).eq("employee_id", id).maybeSingle<EmployeeRow>());
      if (!row) return null;
      const [own, ownTraining, ownAssignments, ownEvaluations, ownBackfilled, ownAssessments, ownHistory, ownLeave] = await Promise.all([
        interviewsFor(session, id), trainingFor(session, id), assignmentsFor(session, id), evaluationsFor(session, id),
        backfilledFor(session, id), assessmentsFor(session, id), historyFor(session, id), leaveFor(session, id),
      ]);
      return toEmployee(
        row, session.role === "admin", interviewsOf(own, id), trainingOf(ownTraining, id), assignmentsOf(ownAssignments, id),
        evaluationsOf(ownEvaluations, id), backfilledOf(ownBackfilled, id),
        skillsOf(ownAssessments, id), reviewOf(ownAssessments, id), historyOf(ownHistory, id), leaveOf(ownLeave, id),
      );
    },
    async isActive(session) {
      const row = await run<{ archived_at: string | null }>(t => t.select("archived_at").eq("employee_id", session.employeeId).maybeSingle<{ archived_at: string | null }>());
      return row !== null && !row.archived_at;
    },
    async linkedEmployeeId(userId) {
      type LinkRow = { employee_id: string; archived_at: string | null };
      const row = await run<LinkRow>(t => t.select("employee_id,archived_at").eq("auth_user_id", userId).maybeSingle<LinkRow>());
      return row && !row.archived_at ? row.employee_id : null;
    },
    async transfer(session, employeeId, toDepartmentId) {
      const parsed = transferInput.safeParse({ employeeId, toDepartmentId });
      if (!parsed.success) {
        throw new TransferInvalidError([...new Set(parsed.error.issues.map(i => String(i.path[0]) as "employeeId" | "toDepartmentId"))]);
      }
      const { employeeId: id, toDepartmentId: to } = parsed.data;
      if (session.role === "staff") throw new TransferForbiddenError();
      // Store-level checks first for managers (defence in depth); the database function repeats them from auth.uid().
      if (session.role === "manager") {
        let inScope: Awaited<ReturnType<ManagerScope["forManager"]>>;
        try {
          inScope = await scope.forManager(session);
        } catch (cause) {
          throw new EmployeesUnavailableError({ cause });
        }
        if (!inScope.employeeIds.has(id) || !inScope.departmentIds.has(to)) throw new TransferForbiddenError();
      }

      // Informational only (best effort): the department before the change. A failed read never blocks the
      // transfer; the database function is the authority and records the real source in the audit row.
      let fromDepartmentId: string | null = null;
      try {
        const before = await run<{ department_id: string | null }>(t => t.select("department_id").eq("employee_id", id)
          .maybeSingle<{ department_id: string | null }>());
        fromDepartmentId = before?.department_id ?? null;
      } catch {
        fromDepartmentId = null;
      }

      let result: { data: unknown; error: { message?: string; code?: string } | null };
      try {
        result = await (await userClient()).rpc("transfer_employee", { p_employee_id: id, p_to_department_id: to });
      } catch (cause) {
        throw new EmployeesUnavailableError({ cause });
      }
      if (result.error) {
        if (result.error.code === "42501") throw new TransferForbiddenError();
        switch (result.error.message) {
          case "not_authorized": throw new TransferForbiddenError();
          case "employee_not_found": throw new TransferNotFoundError();
          case "department_not_found": throw new TransferDepartmentError();
          case "same_department": throw new TransferSameDepartmentError();
          case "open_assignment": throw new TransferOpenAssignmentError();
          default: throw new EmployeesUnavailableError({ cause: result.error });
        }
      }
      if (typeof result.data !== "string") throw new EmployeesUnavailableError({ cause: "no employee name returned" });
      return { employeeId: id, name: result.data, fromDepartmentId, toDepartmentId: to };
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore({
  userClient: getUserClient, interviews: interviewsStore, training: trainingStore, assignments: assignmentsStore,
  evaluations: assignmentEvaluationsStore, backfilled: backfilledProjectStore, assessments: assessmentsStore,
  history: employmentHistoryStore, leave: leaveStore,
});
