import type { SupabaseClient } from "@supabase/supabase-js";
import type { BackfilledProject } from "@/data/employees";
import { isCalendarDate, todayInDhaka } from "@/domain/dates";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import { readAllPages } from "./paging";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 4.7: the single writer of the `backfilled_projects` table (AD-2). A backfilled project is a past
// project the employee adds themselves (work done before this system, or never tracked).
//
// - Reads (`listFor`): every entry for an Administrator; the department subtree's employees' for a manager
//   (manager-scope, computed fresh on each call); only the session's own for Staff. Newest completion
//   first; withdrawn entries are included (and marked by their status). Every row carries
//   `provenance: "backfilled"`, materialized here.
// - Writes (`add`, `edit`, `withdraw`): only the owner. The owner is always `session.employeeId`, never a
//   form value; a session without one is refused. `edit` and `withdraw` read their target and refuse any
//   entry the session does not own — the Administrator's and managers' included (they read, never write) —
//   and a withdrawn entry, which never changes again. There is no delete.
// - The department comes from `departmentOptions()` (the `department_options()` function: id and name of
//   every department, so Staff never read `departments`); the foreign key backs that check up.
//
// Every query goes through a per-request client carrying the signed-in user's JWT, so the RLS policies
// (admin, manages_employee, own read; own-only writes) bound the same rows; the checks here are the
// store-level layer. This module never uses the service role.

export type { BackfilledProject } from "@/data/employees";

/** What the owner chooses. The owner itself is never part of it. */
export type BackfillInput = { departmentId: string; client: string; projectName: string; completionDate: string; outcome: string };

/** One department to pick from: id and name only. */
export type DepartmentOption = { id: string; name: string };

export const BACKFILL_TEXT_MAX = 200;
export const BACKFILL_OUTCOME_MAX = 2000;

export interface BackfilledProjectStore {
  /**
   * The backfilled projects the session may see, newest completion first. `employeeId` narrows to one
   * employee (Staff: only their own; manager: only in-scope ids; anything else is `[]`, without a query).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<BackfilledProject[]>;
  /** Every department's id and name, sorted by name. */
  departmentOptions(): Promise<DepartmentOption[]>;
  /** A new, active past project owned by the session's employee. */
  add(session: SessionIdentity, input: BackfillInput): Promise<BackfilledProject>;
  /** Replaces the values of one of the session's own active entries. */
  edit(session: SessionIdentity, id: string, input: BackfillInput): Promise<BackfilledProject>;
  /** Withdraws one of the session's own active entries; it stays in history, marked. */
  withdraw(session: SessionIdentity, id: string): Promise<BackfilledProject>;
}

/** The session has no employee record of its own (e.g. an Administrator account not linked to one). */
export class BackfillNoEmployeeError extends Error {
  constructor() {
    super("Only an employee can add their own past projects.");
    this.name = "BackfillNoEmployeeError";
  }
}

/** The entry is not the session's own (another employee's, missing, or hidden by RLS). */
export class BackfillForbiddenError extends Error {
  constructor() {
    super("Only the employee who added this past project can change it.");
    this.name = "BackfillForbiddenError";
  }
}

/** The entry was withdrawn: it stays in history and can never be changed again. */
export class BackfillWithdrawnError extends Error {
  constructor() {
    super("This past project was withdrawn and can't be changed.");
    this.name = "BackfillWithdrawnError";
  }
}

/** The department is not one of the listed departments. */
export class BackfillDepartmentError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Choose a department from the list.", options);
    this.name = "BackfillDepartmentError";
  }
}

/** The values are not valid (or the database refused the change as a locked-field or state violation). */
export class BackfillInvalidError extends Error {
  constructor(message = "Check the past project's details.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackfillInvalidError";
  }
}

/** The backfilled projects database is unreachable or returned an error. Never treat this as "none". */
export class BackfillUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Past projects are temporarily unavailable.", options);
    this.name = "BackfillUnavailableError";
  }
}

export type BackfilledProjectRow = {
  id: string; employee_id: string; department_id: string; client: string; project_name: string; completion_date: string;
  outcome: string; status: "active" | "withdrawn"; created_at: string; updated_at: string; withdrawn_at: string | null;
};

const TABLE = "backfilled_projects";
const COLUMNS = "id,employee_id,department_id,client,project_name,completion_date,outcome,status,created_at,updated_at,withdrawn_at";

/** Shown when a department id is not in the department list (never expected: the foreign key holds). */
export const UNKNOWN_DEPARTMENT_NAME = "Unknown department";

/**
 * A row as a BackfilledProject. `departmentName` is resolved from department_options() by the store, so
 * every viewer sees the stored department's own name (not one looked up in the viewer's department list).
 */
export function toBackfilledProject(row: BackfilledProjectRow, departmentName = UNKNOWN_DEPARTMENT_NAME): BackfilledProject {
  return {
    id: row.id, employeeId: row.employee_id, departmentId: row.department_id, departmentName, client: row.client, projectName: row.project_name,
    completionDate: row.completion_date, outcome: row.outcome, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, withdrawnAt: row.withdrawn_at ?? null,
    provenance: "backfilled",
  };
}

/** Newest completion first; ties by creation time (newest first), then id. */
export function compareBackfilledProjects(a: BackfilledProject, b: BackfilledProject): number {
  const byCompletion = b.completionDate.localeCompare(a.completionDate);
  if (byCompletion !== 0) return byCompletion;
  const byCreated = b.createdAt.localeCompare(a.createdAt);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

const sorted = (list: BackfilledProject[]) => [...list].sort(compareBackfilledProjects);

/**
 * The store-level checks of a past project's values: trimmed texts within their limits, and a real
 * calendar completion date that is not after `today` (Asia/Dhaka). Trimmed values, or BackfillInvalidError.
 */
export function validateBackfillInput(input: BackfillInput, today: string): BackfillInput {
  const text = (value: unknown, label: string, max: number) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length < 1 || trimmed.length > max) throw new BackfillInvalidError(`Enter the ${label} (1 to ${max} characters).`);
    return trimmed;
  };
  const departmentId = typeof input?.departmentId === "string" ? input.departmentId.trim() : "";
  if (!departmentId) throw new BackfillDepartmentError();
  const client = text(input.client, "client", BACKFILL_TEXT_MAX);
  const projectName = text(input.projectName, "project name", BACKFILL_TEXT_MAX);
  if (typeof input.completionDate !== "string" || !isCalendarDate(input.completionDate)) {
    throw new BackfillInvalidError("Enter a valid completion date.");
  }
  if (input.completionDate > today) throw new BackfillInvalidError("The completion date can't be in the future.");
  const outcome = text(input.outcome, "outcome", BACKFILL_OUTCOME_MAX);
  return { departmentId, client, projectName, completionDate: input.completionDate, outcome };
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string };
type Table = ReturnType<SupabaseClient["from"]>;

const codeOf = (error: unknown) => (typeof error === "object" && error !== null ? (error as DbError).code : undefined);

/** The database refused the write: a known refusal becomes its typed error; anything else is unavailable. */
function refused(error: unknown): Error {
  switch (codeOf(error)) {
    case "23503": return new BackfillDepartmentError({ cause: error });
    case "23514": return new BackfillInvalidError("The past project can't be changed that way.", { cause: error });
    case "42501": return new BackfillForbiddenError();
    default: return new BackfillUnavailableError({ cause: error });
  }
}

/** The session's own employee id (Staff always; managers and employee-linked Administrators too), or undefined. */
function employeeIdOf(session: SessionIdentity): string | undefined {
  const value = "employeeId" in session ? (session as { employeeId?: unknown }).employeeId : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type BackfilledProjectStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
  /** The clock "today" (Asia/Dhaka) is read from (default: the server clock). */
  now?: () => Date;
};

export function createBackfilledProjectStore({ userClient, scope = managerScope, now = () => new Date() }: BackfilledProjectStoreClients): BackfilledProjectStore {
  async function client(): Promise<SupabaseClient> {
    try {
      return await userClient();
    } catch (cause) {
      throw new BackfillUnavailableError({ cause });
    }
  }

  async function execute<T>(query: (t: Table) => PromiseLike<Result<T>>): Promise<Result<T>> {
    try {
      return await query((await client()).from(TABLE));
    } catch (cause) {
      if (cause instanceof BackfillUnavailableError) throw cause;
      throw new BackfillUnavailableError({ cause });
    }
  }

  /** A read: an error is BackfillUnavailableError. */
  async function read<T>(query: (t: Table) => PromiseLike<Result<T>>): Promise<T | null> {
    const result = await execute(query);
    if (result.error) throw new BackfillUnavailableError({ cause: result.error });
    return result.data ?? null;
  }

  /** A write: a database refusal becomes its typed error (refused). */
  async function write<T>(query: (t: Table) => PromiseLike<Result<T>>): Promise<T | null> {
    const result = await execute(query);
    if (result.error) throw refused(result.error);
    return result.data ?? null;
  }

  /** The employee ids in a manager's subtree; a scope that cannot be read is unavailable, never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new BackfillUnavailableError({ cause });
      throw cause;
    }
  }

  async function readRows(employeeIds: string[] | undefined): Promise<BackfilledProjectRow[]> {
    // Paged (Story 8.2): one request is capped at PostgREST's max_rows; id makes the order total.
    return readAllPages(async (from, to) => {
      const page = await read<BackfilledProjectRow[]>(t => {
        const query = t.select(COLUMNS);
        const filtered = employeeIds === undefined ? query
          : employeeIds.length === 1 ? query.eq("employee_id", employeeIds[0]) : query.in("employee_id", employeeIds);
        return filtered.order("completion_date", { ascending: false }).order("created_at", { ascending: false }).order("id")
          .range(from, to).returns<BackfilledProjectRow[]>();
      });
      if (!page) throw new BackfillUnavailableError({ cause: "no data returned" });
      return page;
    });
  }

  async function departmentOptions(): Promise<DepartmentOption[]> {
    let result: Result<{ id: string; name: string }[]>;
    try {
      result = (await (await client()).rpc("department_options")) as Result<{ id: string; name: string }[]>;
    } catch (cause) {
      if (cause instanceof BackfillUnavailableError) throw cause;
      throw new BackfillUnavailableError({ cause });
    }
    if (result.error || !Array.isArray(result.data)) throw new BackfillUnavailableError({ cause: result.error ?? "no data returned" });
    return result.data.map(d => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Every department's name by id, from department_options() (one rpc). */
  async function departmentNames(): Promise<Map<string, string>> {
    return new Map((await departmentOptions()).map(d => [d.id, d.name]));
  }

  const named = (names: Map<string, string>) => (row: BackfilledProjectRow) =>
    toBackfilledProject(row, names.get(row.department_id) ?? UNKNOWN_DEPARTMENT_NAME);

  /** The owner of a write: always the session's own employee. */
  function ownerOf(session: SessionIdentity): string {
    const owner = employeeIdOf(session);
    if (!owner) throw new BackfillNoEmployeeError();
    return owner;
  }

  /** The values, validated, with a department that is in the list; and the department names. */
  async function checked(input: BackfillInput): Promise<{ values: BackfillInput; names: Map<string, string> }> {
    const values = validateBackfillInput(input, todayInDhaka(now()));
    const names = await departmentNames();
    if (!names.has(values.departmentId)) throw new BackfillDepartmentError();
    return { values, names };
  }

  /**
   * The target of an edit or a withdrawal: one of the owner's own active entries. Anyone else's (or one
   * the session cannot see) is refused the same way; a withdrawn one is refused as withdrawn.
   */
  async function target(owner: string, id: string): Promise<BackfilledProjectRow> {
    const row = await read<BackfilledProjectRow>(t => t.select(COLUMNS).eq("id", id).maybeSingle<BackfilledProjectRow>());
    if (!row || row.employee_id !== owner) throw new BackfillForbiddenError();
    if (row.status !== "active") throw new BackfillWithdrawnError();
    return row;
  }

  /** An update matched no active row: withdrawn in the meantime, or refused by RLS. */
  async function noRowUpdated(id: string): Promise<never> {
    const row = await read<{ status: string }>(t => t.select("status").eq("id", id).maybeSingle<{ status: string }>());
    if (row?.status === "withdrawn") throw new BackfillWithdrawnError();
    throw new BackfillForbiddenError();
  }

  return {
    async listFor(session, employeeId) {
      if (session.role === "manager") {
        const ids = await managedEmployeeIds(session);
        // Out of scope (or nothing in scope): nothing, without a query.
        if (employeeId !== undefined && !ids.has(employeeId)) return [];
        if (ids.size === 0) return [];
        const [rows, names] = await Promise.all([readRows(employeeId === undefined ? [...ids] : [employeeId]), departmentNames()]);
        // Defence in depth: only rows of in-scope employees (and of the one asked for).
        return sorted(rows.filter(r => ids.has(r.employee_id) && (employeeId === undefined || r.employee_id === employeeId)).map(named(names)));
      }
      // Staff only ever see their own; asking for anyone else's returns nothing, without a query.
      if (session.role === "staff" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const only = session.role === "admin" ? employeeId : session.employeeId;
      const [rows, names] = await Promise.all([readRows(only === undefined ? undefined : [only]), departmentNames()]);
      return sorted(rows.filter(r => only === undefined || r.employee_id === only).map(named(names)));
    },

    departmentOptions,

    async add(session, input) {
      const owner = ownerOf(session);
      const { values, names } = await checked(input);
      // The guard sets the status (active) and the timestamps; the owner is the session's, never the form's.
      const row = await write<BackfilledProjectRow>(t => t.insert({
        employee_id: owner, department_id: values.departmentId, client: values.client, project_name: values.projectName,
        completion_date: values.completionDate, outcome: values.outcome,
      }).select(COLUMNS).single<BackfilledProjectRow>());
      if (!row) throw new BackfillUnavailableError({ cause: "no data returned" });
      return named(names)(row);
    },

    async edit(session, id, input) {
      const owner = ownerOf(session);
      const values = validateBackfillInput(input, todayInDhaka(now()));
      await target(owner, id);
      const { names } = await checked(values);
      const row = await write<BackfilledProjectRow>(t => t.update({
        department_id: values.departmentId, client: values.client, project_name: values.projectName,
        completion_date: values.completionDate, outcome: values.outcome,
      }).eq("id", id).eq("employee_id", owner).eq("status", "active").select(COLUMNS).maybeSingle<BackfilledProjectRow>());
      if (!row) return noRowUpdated(id);
      return named(names)(row);
    },

    async withdraw(session, id) {
      const owner = ownerOf(session);
      await target(owner, id);
      // The guard stamps withdrawn_at with the database's clock.
      const row = await write<BackfilledProjectRow>(t => t.update({ status: "withdrawn" })
        .eq("id", id).eq("employee_id", owner).eq("status", "active").select(COLUMNS).maybeSingle<BackfilledProjectRow>());
      if (!row) return noRowUpdated(id);
      return named(await departmentNames())(row);
    },
  };
}

export const backfilledProjectStore: BackfilledProjectStore = createBackfilledProjectStore({ userClient: getUserClient });
