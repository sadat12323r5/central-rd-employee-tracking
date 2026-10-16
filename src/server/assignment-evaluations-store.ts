import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentEvaluation } from "@/data/employees";
import { ASSIGNMENT_COLUMNS, type AssignmentRow } from "./assignments-store";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope, type ManagerScopeSet } from "./manager-scope";
import { readAllPages } from "./paging";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 4.6: the single writer of the `assignment_evaluations` table (AD-2). An evaluation is a separate
// record about one closed assignment: this module only ever reads `assignments` (never writes it, never
// force-closes one).
//
// - Reads (`listFor`): every evaluation for an Administrator; for a manager, those whose assignment's
//   department is in their subtree or whose employee is (manager-scope, computed fresh on each call);
//   only the session's own for Staff.
// - Writes: the Administrator always; a manager only when the **assignment's** department is in their
//   subtree (AD-4: the assignment's department's manager chain); Staff never, not even on their own
//   assignment. `create` refuses a missing/invisible or open assignment and a second evaluation; `amend`
//   changes the texts of the existing one. The subject employee and department come from the assignment
//   (the database trigger copies them); the author always comes from the session JWT through the trigger.
//   There is no delete.
//
// Every query goes through a per-request client carrying the signed-in user's JWT, so the RLS policies
// (admin, manages_department, manages_employee, own read) bound the same rows; the checks here are the
// store-level layer. This module never uses the service role.

export type { AssignmentEvaluation } from "@/data/employees";

/** What a writer chooses: the evaluation and the client's feedback (relayed; may be empty). */
export type EvaluationInput = { evaluation: string; clientFeedback: string };

export const EVALUATION_MAX = 4000;
export const CLIENT_FEEDBACK_MAX = 2000;

export interface AssignmentEvaluationsStore {
  /**
   * The evaluations the session may see. `employeeId` narrows to one employee (Staff: only their own;
   * anything else is `[]`, without a query).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<AssignmentEvaluation[]>;
  /** The first evaluation of a closed assignment. A second one is refused (amend it instead). */
  create(session: SessionIdentity, assignmentId: string, input: EvaluationInput): Promise<AssignmentEvaluation>;
  /** Replaces the texts of the assignment's existing evaluation; the amender becomes its latest author. */
  amend(session: SessionIdentity, assignmentId: string, input: EvaluationInput): Promise<AssignmentEvaluation>;
}

const FORBIDDEN = "Only the Administrator or a manager over this assignment's department can evaluate it.";

/** The session may not evaluate this assignment (Staff, a manager outside the subtree, or an assignment it cannot see). */
export class EvaluationForbiddenError extends Error {
  constructor() {
    super(FORBIDDEN);
    this.name = "EvaluationForbiddenError";
  }
}

/** The assignment is still open: only closed assignments are evaluated (and this store never closes one). */
export class EvaluationAssignmentOpenError extends Error {
  constructor() {
    super("Close the assignment before evaluating it.");
    this.name = "EvaluationAssignmentOpenError";
  }
}

/** The assignment already has its evaluation (one per assignment): amend it instead. */
export class EvaluationExistsError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This assignment already has an evaluation. Amend it instead.", options);
    this.name = "EvaluationExistsError";
  }
}

/** An amendment of an assignment that has no evaluation yet. */
export class EvaluationNotFoundError extends Error {
  constructor() {
    super("Write the evaluation first.");
    this.name = "EvaluationNotFoundError";
  }
}

/** The values are not valid (or the database refused the change as a locked-field or state violation). */
export class EvaluationInvalidError extends Error {
  constructor(message = "Check the evaluation.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvaluationInvalidError";
  }
}

/** The evaluations database is unreachable or returned an error. Never treat this as "no evaluations". */
export class EvaluationsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Assignment evaluations are temporarily unavailable.", options);
    this.name = "EvaluationsUnavailableError";
  }
}

export type AssignmentEvaluationRow = {
  id: string; assignment_id: string; employee_id: string; department_id: string; evaluation: string; client_feedback: string;
  created_by: string; created_at: string; authored_by: string; updated_at: string;
};

const TABLE = "assignment_evaluations";
const COLUMNS = "id,assignment_id,employee_id,department_id,evaluation,client_feedback,created_by,created_at,authored_by,updated_at";

export function toAssignmentEvaluation(row: AssignmentEvaluationRow): AssignmentEvaluation {
  return {
    id: row.id, assignmentId: row.assignment_id, employeeId: row.employee_id, departmentId: row.department_id,
    evaluation: row.evaluation, clientFeedback: row.client_feedback ?? "", createdBy: row.created_by, createdAt: row.created_at,
    authoredBy: row.authored_by, updatedAt: row.updated_at,
  };
}

/** The store-level checks of an evaluation's texts; trimmed values, or EvaluationInvalidError. */
export function validateEvaluationInput(input: EvaluationInput): EvaluationInput {
  const evaluation = typeof input?.evaluation === "string" ? input.evaluation.trim() : "";
  if (evaluation.length < 1 || evaluation.length > EVALUATION_MAX) {
    throw new EvaluationInvalidError(`Enter the evaluation (1 to ${EVALUATION_MAX} characters).`);
  }
  const raw = input?.clientFeedback ?? "";
  if (typeof raw !== "string") throw new EvaluationInvalidError("Enter the client feedback as text.");
  const clientFeedback = raw.trim();
  if (clientFeedback.length > CLIENT_FEEDBACK_MAX) {
    throw new EvaluationInvalidError(`Keep the client feedback to ${CLIENT_FEEDBACK_MAX} characters or fewer.`);
  }
  return { evaluation, clientFeedback };
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string };
type Table = ReturnType<SupabaseClient["from"]>;

const codeOf = (error: unknown) => (typeof error === "object" && error !== null ? (error as DbError).code : undefined);

/** The database refused the write: a known refusal becomes its typed error; anything else is unavailable. */
function refused(error: unknown): Error {
  switch (codeOf(error)) {
    case "23505": return new EvaluationExistsError({ cause: error });
    case "23514": return new EvaluationInvalidError("The evaluation can't be changed that way.", { cause: error });
    case "42501": return new EvaluationForbiddenError();
    default: return new EvaluationsUnavailableError({ cause: error });
  }
}

export type AssignmentEvaluationsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createAssignmentEvaluationsStore({ userClient, scope = managerScope }: AssignmentEvaluationsStoreClients): AssignmentEvaluationsStore {
  async function client(): Promise<SupabaseClient> {
    try {
      return await userClient();
    } catch (cause) {
      throw new EvaluationsUnavailableError({ cause });
    }
  }

  async function execute<T>(table: string, query: (t: Table) => PromiseLike<Result<T>>): Promise<Result<T>> {
    try {
      return await query((await client()).from(table));
    } catch (cause) {
      if (cause instanceof EvaluationsUnavailableError) throw cause;
      throw new EvaluationsUnavailableError({ cause });
    }
  }

  /** A read: an error is EvaluationsUnavailableError. */
  async function read<T>(table: string, query: (t: Table) => PromiseLike<Result<T>>): Promise<T | null> {
    const result = await execute(table, query);
    if (result.error) throw new EvaluationsUnavailableError({ cause: result.error });
    return result.data ?? null;
  }

  /** A write to the evaluations table: a database refusal becomes its typed error (refused). */
  async function write<T>(query: (t: Table) => PromiseLike<Result<T>>): Promise<T | null> {
    const result = await execute(TABLE, query);
    if (result.error) throw refused(result.error);
    return result.data ?? null;
  }

  /** A manager's subtree; a scope that cannot be read is unavailable, never a partial list. */
  async function scopeOf(session: ManagerIdentity): Promise<ManagerScopeSet> {
    try {
      return await scope.forManager(session);
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EvaluationsUnavailableError({ cause });
      throw cause;
    }
  }

  /** The Administrator always; a manager only over the assignment's own department; Staff never. */
  async function authorize(session: SessionIdentity, departmentId: string): Promise<void> {
    if (session.role === "admin") return;
    if (session.role === "manager" && (await scopeOf(session)).departmentIds.has(departmentId)) return;
    throw new EvaluationForbiddenError();
  }

  type Filter = { column: "employee_id" | "department_id"; values: string[] } | undefined;

  async function readRows(filter: Filter): Promise<AssignmentEvaluationRow[]> {
    // Paged (Story 8.2): one request is capped at PostgREST's max_rows; id makes the order total.
    return readAllPages(async (from, to) => {
      const page = await read<AssignmentEvaluationRow[]>(TABLE, t => {
        const query = t.select(COLUMNS);
        const filtered = filter === undefined ? query
          : filter.values.length === 1 ? query.eq(filter.column, filter.values[0]) : query.in(filter.column, filter.values);
        return filtered.order("created_at", { ascending: false }).order("id").range(from, to).returns<AssignmentEvaluationRow[]>();
      });
      if (!page) throw new EvaluationsUnavailableError({ cause: "no data returned" });
      return page;
    });
  }

  /**
   * The assignment a write targets, authorized against its own department. One the session cannot see
   * (missing, or hidden by RLS) is refused the same way as one outside the scope. Read only.
   */
  async function assignmentFor(session: SessionIdentity, assignmentId: string): Promise<AssignmentRow> {
    if (session.role === "staff") throw new EvaluationForbiddenError();
    const row = await read<AssignmentRow>("assignments", t => t.select(ASSIGNMENT_COLUMNS).eq("id", assignmentId).maybeSingle<AssignmentRow>());
    if (!row) throw new EvaluationForbiddenError();
    return row;
  }

  async function existing(assignmentId: string): Promise<{ id: string } | null> {
    return read<{ id: string }>(TABLE, t => t.select("id").eq("assignment_id", assignmentId).maybeSingle<{ id: string }>());
  }

  return {
    async listFor(session, employeeId) {
      if (session.role === "manager") {
        const { departmentIds, employeeIds } = await scopeOf(session);
        if (departmentIds.size === 0 && employeeIds.size === 0) return [];
        const inScope = (r: AssignmentEvaluationRow) => departmentIds.has(r.department_id) || employeeIds.has(r.employee_id);
        let rows: AssignmentEvaluationRow[];
        if (employeeId !== undefined) {
          rows = await readRows({ column: "employee_id", values: [employeeId] });
        } else {
          const [byDepartment, byEmployee] = await Promise.all([
            departmentIds.size ? readRows({ column: "department_id", values: [...departmentIds] }) : Promise.resolve([]),
            employeeIds.size ? readRows({ column: "employee_id", values: [...employeeIds] }) : Promise.resolve([]),
          ]);
          rows = [...new Map([...byDepartment, ...byEmployee].map(r => [r.id, r])).values()];
        }
        // Defence in depth: only in-scope rows (and only the employee asked for).
        return rows.filter(r => inScope(r) && (employeeId === undefined || r.employee_id === employeeId)).map(toAssignmentEvaluation);
      }
      // Staff only ever see their own; asking for anyone else's returns nothing, without a query.
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const only = session.role === "admin" ? employeeId : session.employeeId;
      const rows = await readRows(only === undefined ? undefined : { column: "employee_id", values: [only] });
      return rows.filter(r => only === undefined || r.employee_id === only).map(toAssignmentEvaluation);
    },

    async create(session, assignmentId, input) {
      if (session.role === "staff") throw new EvaluationForbiddenError();
      const values = validateEvaluationInput(input);
      const assignment = await assignmentFor(session, assignmentId);
      // Never closes the assignment: an open one is refused as it is.
      if (assignment.status !== "closed") throw new EvaluationAssignmentOpenError();
      await authorize(session, assignment.department_id);
      if (await existing(assignmentId)) throw new EvaluationExistsError();
      // The trigger copies employee_id and department_id from the assignment (whatever is sent) and sets
      // created_by / authored_by from the JWT: the author is never sent.
      const row = await write<AssignmentEvaluationRow>(t => t.insert({
        assignment_id: assignmentId, employee_id: assignment.employee_id, department_id: assignment.department_id,
        evaluation: values.evaluation, client_feedback: values.clientFeedback,
      }).select(COLUMNS).single<AssignmentEvaluationRow>());
      if (!row) throw new EvaluationsUnavailableError({ cause: "no data returned" });
      return toAssignmentEvaluation(row);
    },

    async amend(session, assignmentId, input) {
      if (session.role === "staff") throw new EvaluationForbiddenError();
      const values = validateEvaluationInput(input);
      const assignment = await assignmentFor(session, assignmentId);
      await authorize(session, assignment.department_id);
      if (!(await existing(assignmentId))) throw new EvaluationNotFoundError();
      const row = await write<AssignmentEvaluationRow>(t => t.update({ evaluation: values.evaluation, client_feedback: values.clientFeedback })
        .eq("assignment_id", assignmentId).select(COLUMNS).maybeSingle<AssignmentEvaluationRow>());
      // Matched nothing: refused by RLS (the pre-check saw the row).
      if (!row) throw new EvaluationForbiddenError();
      return toAssignmentEvaluation(row);
    },
  };
}

export const assignmentEvaluationsStore: AssignmentEvaluationsStore = createAssignmentEvaluationsStore({ userClient: getUserClient });
