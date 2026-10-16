import type { SupabaseClient } from "@supabase/supabase-js";
import type { Assignment } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import { readAllPages } from "./paging";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 4.5: the single writer of the `assignments` table (AD-2): nothing else in the app writes an
// assignment, its status or its completion date.
//
// - Reads (`listFor`): every assignment for an Administrator; the department subtree's for a manager
//   (manager-scope, computed fresh on each call); only the session's own for Staff. The open assignment
//   comes first, then closed ones by completion date, newest first.
// - Writes: the Administrator always; a manager only for an employee in their subtree; Staff never.
//   `create` copies the employee's department (never caller-chosen; the database trigger is
//   authoritative and overwrites whatever is sent). `updateNote` changes only the latest-update note of
//   an open assignment, and `close` moves an open one into history with a completion date. The subject
//   employee of a note edit or a close is read from the target row, never taken from the caller. There
//   is no delete.
//
// Every query goes through a per-request client carrying the signed-in user's JWT, so the RLS policies
// (admin, manages_employee, own read) bound the same rows; the checks here are the store-level layer.
// This module never uses the service role.

export type { Assignment } from "@/data/employees";

/** What a creator chooses. The department is never part of it. */
export type AssignmentInput = { client: string; projectName: string; role: string; allocation: number; startDate: string };

export const ASSIGNMENT_TEXT_MAX = 200;
export const ASSIGNMENT_NOTE_MAX = 2000;

export interface AssignmentsStore {
  /**
   * The assignments the session may see, open first, then closed by completion date (newest first).
   * `employeeId` narrows to one employee (Staff: only their own; manager: only in-scope ids; anything
   * else is `[]`, without a query).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<Assignment[]>;
  /** A new open assignment for the employee, under the employee's own department. */
  create(session: SessionIdentity, employeeId: string, input: AssignmentInput): Promise<Assignment>;
  /** Replaces the latest-update note of an open assignment. */
  updateNote(session: SessionIdentity, id: string, note: string): Promise<Assignment>;
  /** Closes an open assignment with a completion date (on or after its start date). */
  close(session: SessionIdentity, id: string, completionDate: string): Promise<Assignment>;
}

const FORBIDDEN = "Only the Administrator or a manager over this employee's department can manage assignments.";

/** The session may not manage this employee's assignments (Staff, or a manager outside the subtree). */
export class AssignmentsForbiddenError extends Error {
  constructor() {
    super(FORBIDDEN);
    this.name = "AssignmentsForbiddenError";
  }
}

/** The employee does not exist (or is not visible to the session). */
export class AssignmentEmployeeNotFoundError extends Error {
  constructor(employeeId: string) {
    super(`Employee ${employeeId} was not found.`);
    this.name = "AssignmentEmployeeNotFoundError";
  }
}

/** The employee is not placed in a department, so the assignment would have none. */
export class AssignmentNoDepartmentError extends Error {
  constructor() {
    super("Place this employee in a department first.");
    this.name = "AssignmentNoDepartmentError";
  }
}

/** The employee already has an open assignment (at most one at a time). */
export class AssignmentAlreadyOpenError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This employee already has an open assignment. Close it first.", options);
    this.name = "AssignmentAlreadyOpenError";
  }
}

/** The assignment is closed: it can no longer be changed. */
export class AssignmentClosedError extends Error {
  constructor() {
    super("This assignment is closed and can't be changed.");
    this.name = "AssignmentClosedError";
  }
}

/** The values are not valid (or the database refused the change as a locked-field or state violation). */
export class AssignmentInvalidError extends Error {
  constructor(message = "Check the assignment details.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssignmentInvalidError";
  }
}

/** The assignments database is unreachable or returned an error. Never treat this as "no assignments". */
export class AssignmentsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Assignment records are temporarily unavailable.", options);
    this.name = "AssignmentsUnavailableError";
  }
}

export type AssignmentRow = {
  id: string; employee_id: string; department_id: string; client: string; project_name: string; role: string;
  allocation: number; start_date: string; latest_update: string; status: "open" | "closed";
  completion_date: string | null; created_at: string; closed_at: string | null;
};

const TABLE = "assignments";
const COLUMNS = "id,employee_id,department_id,client,project_name,role,allocation,start_date,latest_update,status,completion_date,created_at,closed_at";
/** The assignment columns, for read-only lookups elsewhere (Story 4.6: the evaluations store reads its target assignment). */
export const ASSIGNMENT_COLUMNS = COLUMNS;

export function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id, employeeId: row.employee_id, departmentId: row.department_id, client: row.client,
    projectName: row.project_name, role: row.role, allocation: row.allocation, startDate: row.start_date,
    latestUpdate: row.latest_update, status: row.status, completionDate: row.completion_date ?? null,
    createdAt: row.created_at, closedAt: row.closed_at ?? null,
    // Story 4.7: materialized here, so views never infer a row's origin from the list it came from.
    provenance: "assignment",
  };
}

/** Open first; then closed by completion date, newest first; ties by creation time (newest first), then id. */
export function compareAssignments(a: Assignment, b: Assignment): number {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  const byCompletion = (b.completionDate ?? "").localeCompare(a.completionDate ?? "");
  if (byCompletion !== 0) return byCompletion;
  const byCreated = b.createdAt.localeCompare(a.createdAt);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

const sorted = (list: Assignment[]) => [...list].sort(compareAssignments);

/** The store-level checks of a new assignment's values; trimmed values, or AssignmentInvalidError. */
export function validateAssignmentInput(input: AssignmentInput): AssignmentInput {
  const text = (value: unknown, label: string) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length < 1 || trimmed.length > ASSIGNMENT_TEXT_MAX) {
      throw new AssignmentInvalidError(`Enter the ${label} (1 to ${ASSIGNMENT_TEXT_MAX} characters).`);
    }
    return trimmed;
  };
  const client = text(input.client, "client");
  const projectName = text(input.projectName, "project name");
  const role = text(input.role, "role");
  if (!Number.isInteger(input.allocation) || input.allocation < 0 || input.allocation > 100) {
    throw new AssignmentInvalidError("Enter the allocation as a whole number from 0 to 100.");
  }
  if (typeof input.startDate !== "string" || !isCalendarDate(input.startDate)) {
    throw new AssignmentInvalidError("Enter a valid start date.");
  }
  return { client, projectName, role, allocation: input.allocation, startDate: input.startDate };
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string };

const codeOf = (error: unknown) => (typeof error === "object" && error !== null ? (error as DbError).code : undefined);

/** The database refused the write: a known refusal becomes its typed error; anything else is unavailable. */
function refused(error: unknown): Error {
  switch (codeOf(error)) {
    case "23505": return new AssignmentAlreadyOpenError({ cause: error });
    case "23514": return new AssignmentInvalidError("The assignment can't be changed that way.", { cause: error });
    case "42501": return new AssignmentsForbiddenError();
    default: return new AssignmentsUnavailableError({ cause: error });
  }
}

export type AssignmentsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createAssignmentsStore({ userClient, scope = managerScope }: AssignmentsStoreClients): AssignmentsStore {
  async function client(): Promise<SupabaseClient> {
    try {
      return await userClient();
    } catch (cause) {
      throw new AssignmentsUnavailableError({ cause });
    }
  }

  /** A read: an error is AssignmentsUnavailableError. */
  async function read<T>(table: string, query: (t: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await client()).from(table));
    } catch (cause) {
      if (cause instanceof AssignmentsUnavailableError) throw cause;
      throw new AssignmentsUnavailableError({ cause });
    }
    if (result.error) throw new AssignmentsUnavailableError({ cause: result.error });
    return result.data ?? null;
  }

  /** A write: a database refusal becomes its typed error (refused). */
  async function write<T>(query: (t: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await client()).from(TABLE));
    } catch (cause) {
      if (cause instanceof AssignmentsUnavailableError) throw cause;
      throw new AssignmentsUnavailableError({ cause });
    }
    if (result.error) throw refused(result.error);
    return result.data ?? null;
  }

  /** The employee ids in a manager's subtree; a scope that cannot be read is unavailable, never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new AssignmentsUnavailableError({ cause });
      throw cause;
    }
  }

  /** The Administrator always; a manager only for an in-scope employee; Staff never. */
  async function authorize(session: SessionIdentity, employeeId: string): Promise<void> {
    if (session.role === "admin") return;
    if (session.role === "manager" && (await managedEmployeeIds(session)).has(employeeId)) return;
    throw new AssignmentsForbiddenError();
  }

  async function readRows(employeeIds: string[] | undefined): Promise<AssignmentRow[]> {
    // Paged (Story 8.2): one request is capped at PostgREST's max_rows; id makes the order total.
    return readAllPages(async (from, to) => {
      const page = await read<AssignmentRow[]>(TABLE, t => {
        const query = t.select(COLUMNS);
        const filtered = employeeIds === undefined ? query
          : employeeIds.length === 1 ? query.eq("employee_id", employeeIds[0]) : query.in("employee_id", employeeIds);
        return filtered.order("created_at", { ascending: false }).order("id").range(from, to).returns<AssignmentRow[]>();
      });
      if (!page) throw new AssignmentsUnavailableError({ cause: "no data returned" });
      return page;
    });
  }

  /**
   * The target of a note edit or a close, authorized against its own employee. A row the session cannot
   * see (missing, or hidden by RLS) is refused the same way as one outside the scope.
   */
  async function target(session: SessionIdentity, id: string): Promise<AssignmentRow> {
    if (session.role === "staff") throw new AssignmentsForbiddenError();
    const row = await read<AssignmentRow>(TABLE, t => t.select(COLUMNS).eq("id", id).maybeSingle<AssignmentRow>());
    if (!row) throw new AssignmentsForbiddenError();
    await authorize(session, row.employee_id);
    if (row.status !== "open") throw new AssignmentClosedError();
    return row;
  }

  /** An update matched no open row: closed in the meantime, or refused by RLS. */
  async function noRowUpdated(id: string): Promise<never> {
    const row = await read<{ status: string }>(TABLE, t => t.select("status").eq("id", id).maybeSingle<{ status: string }>());
    if (row?.status === "closed") throw new AssignmentClosedError();
    throw new AssignmentsForbiddenError();
  }

  return {
    async listFor(session, employeeId) {
      if (session.role === "manager") {
        const ids = await managedEmployeeIds(session);
        // Out of scope (or nothing in scope): nothing, without an assignments query.
        if (employeeId !== undefined && !ids.has(employeeId)) return [];
        if (ids.size === 0) return [];
        const rows = await readRows(employeeId === undefined ? [...ids] : [employeeId]);
        // Defence in depth: only rows of in-scope employees (and of the one asked for).
        return sorted(rows.filter(r => ids.has(r.employee_id) && (employeeId === undefined || r.employee_id === employeeId)).map(toAssignment));
      }
      // Staff only ever see their own; asking for anyone else's returns nothing, without a query.
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const only = session.role === "admin" ? employeeId : session.employeeId;
      const rows = await readRows(only === undefined ? undefined : [only]);
      return sorted(rows.filter(r => only === undefined || r.employee_id === only).map(toAssignment));
    },

    async create(session, employeeId, input) {
      await authorize(session, employeeId);
      const values = validateAssignmentInput(input);
      const employee = await read<{ employee_id: string; department_id: string | null }>("employees", t => t
        .select("employee_id,department_id").eq("employee_id", employeeId).maybeSingle<{ employee_id: string; department_id: string | null }>());
      if (!employee) throw new AssignmentEmployeeNotFoundError(employeeId);
      if (!employee.department_id) throw new AssignmentNoDepartmentError();
      const open = await read<{ id: string }[]>(TABLE, t => t.select("id").eq("employee_id", employeeId).eq("status", "open").limit(1)
        .returns<{ id: string }[]>());
      if (open && open.length > 0) throw new AssignmentAlreadyOpenError();
      const row = await write<AssignmentRow>(t => t.insert({
        employee_id: employeeId, department_id: employee.department_id, client: values.client, project_name: values.projectName,
        role: values.role, allocation: values.allocation, start_date: values.startDate, latest_update: "",
      }).select(COLUMNS).single<AssignmentRow>());
      if (!row) throw new AssignmentsUnavailableError({ cause: "no data returned" });
      return toAssignment(row);
    },

    async updateNote(session, id, note) {
      const trimmed = typeof note === "string" ? note.trim() : "";
      if (trimmed.length > ASSIGNMENT_NOTE_MAX) throw new AssignmentInvalidError(`Keep the latest update to ${ASSIGNMENT_NOTE_MAX} characters or fewer.`);
      await target(session, id);
      const row = await write<AssignmentRow>(t => t.update({ latest_update: trimmed }).eq("id", id).eq("status", "open")
        .select(COLUMNS).maybeSingle<AssignmentRow>());
      if (!row) return noRowUpdated(id);
      return toAssignment(row);
    },

    async close(session, id, completionDate) {
      if (typeof completionDate !== "string" || !isCalendarDate(completionDate)) throw new AssignmentInvalidError("Enter a valid completion date.");
      const current = await target(session, id);
      if (completionDate < current.start_date) throw new AssignmentInvalidError("The completion date can't be before the start date.");
      const row = await write<AssignmentRow>(t => t.update({ status: "closed", completion_date: completionDate }).eq("id", id).eq("status", "open")
        .select(COLUMNS).maybeSingle<AssignmentRow>());
      if (!row) return noRowUpdated(id);
      return toAssignment(row);
    },
  };
}

export const assignmentsStore: AssignmentsStore = createAssignmentsStore({ userClient: getUserClient });
