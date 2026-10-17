import type { SupabaseClient } from "@supabase/supabase-js";
import type { Employee } from "@/data/employees";
import {
  invalidEmploymentHistoryFields, normalizeEmploymentHistory, sortNewestFirst,
  type EmploymentHistoryField, type EmploymentHistoryInput,
} from "@/domain/employment-history";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import { readAllPages } from "./paging";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The only way the app reads and writes employment history (Story 7.3). Entries live in the Supabase
// `employment_history` table; the fixture's history is seed data only (scripts/seed-employees.ts).
//
// Who may change an employee's history: the employee themselves (a staff session, own record only), the
// Administrator (anyone) and a department manager (employees in their subtree, from manager-scope,
// worked out fresh on every call). Every query goes through a per-request client carrying the signed-in
// user's JWT, so the employment_history RLS policies (admin, own, or manages_employee) are enforced; the
// checks here are the store-level layer on top. For update and remove, the subject employee is read from
// the target row, never taken from the caller, and the write is filtered by id, that employee and
// `removed_at is null`. Removal sets `removed_at` once (the guard trigger stamps the time); the row is
// kept, and there is no delete path and no un-remove. Removed entries are never listed. This module never
// uses the service role.
export type EmploymentHistoryEntry = Employee["history"][number] & { employeeId: string; createdAt: string };

export interface EmploymentHistoryStore {
  /**
   * Active entries the session may see, newest first per employee: anyone's for an Administrator, the
   * subtree's for a manager, only the session's own for staff. `employeeId` narrows the list to one
   * employee (staff asking for anyone else, or a manager outside the subtree: `[]`, without a query).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<EmploymentHistoryEntry[]>;
  /** Adds an entry for `employeeId` (staff: must be their own; manager: in their subtree). */
  add(session: SessionIdentity, employeeId: string, input: EmploymentHistoryInput): Promise<EmploymentHistoryEntry>;
  /** Changes the role, employer, period and detail of an active entry. */
  update(session: SessionIdentity, id: string, input: EmploymentHistoryInput): Promise<EmploymentHistoryEntry>;
  /** Removes an active entry (sets `removed_at`). The row is kept; it is never deleted. */
  remove(session: SessionIdentity, id: string): Promise<EmploymentHistoryEntry>;
}

/** The session may not change this employee's history (another employee for staff, outside a manager's subtree). */
export class EmploymentHistoryForbiddenError extends Error {
  constructor() {
    super("Only the employee, an Administrator, or a manager for their own department subtree can change employment history.");
    this.name = "EmploymentHistoryForbiddenError";
  }
}

/** No entry with this id is visible to the session (unknown, not visible, or another employee's for staff). */
export class EmploymentHistoryNotFoundError extends Error {
  constructor() {
    super("That employment entry was not found.");
    this.name = "EmploymentHistoryNotFoundError";
  }
}

/** The entry was removed and can no longer be changed. */
export class EmploymentHistoryRemovedError extends Error {
  constructor() {
    super("That employment entry was removed and can no longer be changed.");
    this.name = "EmploymentHistoryRemovedError";
  }
}

/**
 * The entry failed validation. `fields` names the offending inputs; values are never included.
 * `"entry"` means the database refused it (check constraint or guard trigger) without naming a field.
 */
export class EmploymentHistoryInvalidError extends Error {
  readonly fields: (EmploymentHistoryField | "entry")[];
  constructor(fields: (EmploymentHistoryField | "entry")[]) {
    super(`Invalid employment entry: ${fields.join(", ")}.`);
    this.name = "EmploymentHistoryInvalidError";
    this.fields = fields;
  }
}

/** The database (or the manager's scope) is unreachable or refused the query. Never treat this as "no history" or "saved". */
export class EmploymentHistoryUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Employment history is temporarily unavailable.", options);
    this.name = "EmploymentHistoryUnavailableError";
  }
}

export type EmploymentHistoryRow = {
  id: string; employee_id: string; role: string; employer: string; period: string; detail: string;
  created_at: string; removed_at: string | null;
};

const TABLE = "employment_history";
const COLUMNS = "id,employee_id,role,employer,period,detail,created_at,removed_at";

export function toEmploymentHistoryEntry(row: EmploymentHistoryRow): EmploymentHistoryEntry {
  return {
    id: row.id, employeeId: row.employee_id, role: row.role, company: row.employer, period: row.period,
    detail: row.detail, createdAt: row.created_at,
  };
}

const isRemoved = (row: EmploymentHistoryRow) => row.removed_at !== null && row.removed_at !== undefined;

/** Newest first within each employee; employees keep the order they first appear in. */
function newestFirstPerEmployee(entries: EmploymentHistoryEntry[]): EmploymentHistoryEntry[] {
  const groups = new Map<string, EmploymentHistoryEntry[]>();
  for (const entry of entries) groups.set(entry.employeeId, [...(groups.get(entry.employeeId) ?? []), entry]);
  return [...groups.values()].flatMap(group => sortNewestFirst(group));
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string };

/** Maps a refused write to the store's typed errors; anything unrecognised is "unavailable". */
function writeRefusal(error: unknown): Error {
  const code = (error as DbError | null)?.code;
  if (code === "23514") return new EmploymentHistoryInvalidError(["entry"]);
  if (code === "42501") return new EmploymentHistoryForbiddenError();
  return new EmploymentHistoryUnavailableError({ cause: error });
}

export type EmploymentHistoryStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createEmploymentHistoryStore({ userClient, scope = managerScope }: EmploymentHistoryStoreClients): EmploymentHistoryStore {
  type Query<T> = (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>;

  /** Runs a query whose "no row" is a legitimate answer (maybeSingle): null means not found. */
  async function runMaybe<T>(query: Query<T>, refusal: (error: unknown) => Error = cause => new EmploymentHistoryUnavailableError({ cause })): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new EmploymentHistoryUnavailableError({ cause });
    }
    if (result.error) throw refusal(result.error);
    return result.data ?? null;
  }

  async function run<T>(query: Query<T>, refusal?: (error: unknown) => Error): Promise<T> {
    const data = await runMaybe(query, refusal);
    if (data === null) throw new EmploymentHistoryUnavailableError({ cause: "no data returned" });
    return data;
  }

  /** The employee ids in a manager's subtree. A scope that cannot be read is "unavailable", never "allowed" or "nothing". */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EmploymentHistoryUnavailableError({ cause });
      throw cause;
    }
  }

  /** Throws EmploymentHistoryForbiddenError unless the session may change `employeeId`'s history. */
  async function authorize(session: SessionIdentity, employeeId: string): Promise<void> {
    if (session.role === "admin") return;
    if (session.role === "staff") {
      if (employeeId !== session.employeeId) throw new EmploymentHistoryForbiddenError();
      return;
    }
    // Story 4.10: a manager changes their own history from "My record" under the Staff own-record rule
    // (RLS allows it through the account link), whether or not their own row sits in their subtree.
    if (employeeId === session.employeeId) return;
    if (!(await managedEmployeeIds(session)).has(employeeId)) throw new EmploymentHistoryForbiddenError();
  }

  function validated(input: EmploymentHistoryInput): EmploymentHistoryInput {
    const entry = normalizeEmploymentHistory(input);
    const invalid = invalidEmploymentHistoryFields(entry);
    if (invalid.length > 0) throw new EmploymentHistoryInvalidError(invalid);
    return entry;
  }

  /**
   * Shared path for update and remove: the subject employee comes from the target row. Staff see another
   * employee's entry as not found; a manager outside the subtree is forbidden. The write is filtered by
   * id, that employee and `removed_at is null`, so an entry removed or moved in between changes nothing
   * (reported as not found).
   */
  async function change(session: SessionIdentity, id: string, values: Partial<Omit<EmploymentHistoryRow, "id" | "employee_id" | "created_at">>) {
    const current = await runMaybe<EmploymentHistoryRow>(t => t.select(COLUMNS).eq("id", id).maybeSingle<EmploymentHistoryRow>());
    if (!current) throw new EmploymentHistoryNotFoundError();
    if (session.role === "staff" && current.employee_id !== session.employeeId) throw new EmploymentHistoryNotFoundError();
    await authorize(session, current.employee_id);
    if (isRemoved(current)) throw new EmploymentHistoryRemovedError();
    const saved = await runMaybe<EmploymentHistoryRow>(t => t.update(values)
      .eq("id", id).eq("employee_id", current.employee_id).is("removed_at", null)
      .select(COLUMNS).maybeSingle<EmploymentHistoryRow>(), writeRefusal);
    if (!saved || saved.employee_id !== current.employee_id) throw new EmploymentHistoryNotFoundError();
    return toEmploymentHistoryEntry(saved);
  }

  return {
    async listFor(session, employeeId) {
      let filter: { eq: string } | { in: string[] } | null = null;
      let allowed: Set<string> | null = null;
      if (session.role === "staff") {
        // Staff only ever see their own history; asking for anyone else's returns nothing, without a query.
        if (employeeId !== undefined && employeeId !== session.employeeId) return [];
        filter = { eq: session.employeeId };
        allowed = new Set([session.employeeId]);
      } else if (session.role === "manager") {
        allowed = await managedEmployeeIds(session);
        if (employeeId !== undefined && !allowed.has(employeeId)) return [];
        if (allowed.size === 0) return [];
        filter = employeeId !== undefined ? { eq: employeeId } : { in: [...allowed] };
      } else if (employeeId !== undefined) {
        filter = { eq: employeeId };
      }
      // Paged (Story 8.2): one request is capped at PostgREST's max_rows; the order is total (id last).
      const rows = await readAllPages((from, to) => run<EmploymentHistoryRow[]>(t => {
        const base = t.select(COLUMNS);
        const scoped = filter === null ? base : "eq" in filter ? base.eq("employee_id", filter.eq) : base.in("employee_id", filter.in);
        return scoped.is("removed_at", null)
          .order("employee_id")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to)
          .returns<EmploymentHistoryRow[]>();
      }));
      // Defence in depth: never a removed entry, and never one outside the session's scope.
      const visible = rows.filter(row => !isRemoved(row) && (allowed === null || allowed.has(row.employee_id)));
      return newestFirstPerEmployee(visible.map(toEmploymentHistoryEntry));
    },
    async add(session, employeeId, input) {
      await authorize(session, employeeId);
      const entry = validated(input);
      const saved = await run<EmploymentHistoryRow>(t => t.insert({
        employee_id: employeeId, role: entry.role, employer: entry.employer, period: entry.period, detail: entry.detail,
      }).select(COLUMNS).single<EmploymentHistoryRow>(), writeRefusal);
      // Defence in depth: the stored row must belong to the employee asked for.
      if (saved.employee_id !== employeeId) throw new EmploymentHistoryUnavailableError({ cause: "saved for another employee" });
      return toEmploymentHistoryEntry(saved);
    },
    async update(session, id, input) {
      const entry = validated(input);
      return change(session, id, { role: entry.role, employer: entry.employer, period: entry.period, detail: entry.detail });
    },
    async remove(session, id) {
      return change(session, id, { removed_at: new Date().toISOString() });
    },
  };
}

export const employmentHistoryStore: EmploymentHistoryStore = createEmploymentHistoryStore({ userClient: getUserClient });
