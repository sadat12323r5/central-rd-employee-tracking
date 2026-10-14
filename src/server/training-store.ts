import type { SupabaseClient } from "@supabase/supabase-js";
import { lmsClient, LmsUnavailableError, type Enrolment, type LmsClient } from "./lms-client";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The single source of training for every view (Stories 3.1 and 3.2): the staff portal, the
// Administrator's Training tab and the org-wide Learning & development view all read training through
// here. It is also the only caller of the LMS adapter (`lms-client`).
//
// - History (`listFor`): completed entries stored in the Supabase `training_history` table (no
//   department column: training stays with the employee).
// - Current (`currentFor`): LMS enrolments from `lms-client`, split into in-progress entries (the
//   "Current" section) and courses the LMS reports as completed (appended to history, minus those
//   already stored in `training_history`, so no course shows twice and none shows in both sections).
//
// Nothing here reads the fixture (`src/data/employees.ts` is seed-only for training).
//
// Privacy rule: an entry is visible only to the employee and to Administrators. Every table query (here
// and in the LMS stub) goes through a per-request client carrying the signed-in user's JWT, so the RLS
// policies ("is this the employee, or an Administrator" — never a department or manager lookup) are
// enforced. The scoping here is the store-level layer: staff reads are limited to the session's own
// employee. There is no write path (creating or editing training outside the LMS is deferred). This
// module never uses the service role.
//
// Story 4.3: a department manager also sees the training of the employees in their department subtree
// (manager-scope, computed fresh on each call; RLS: training_history_select_managed and
// lms_stub_enrolments_select_managed). Anything outside the subtree is `[]` or dropped, without a query.

/** One training entry as views show it: `date` is the completion date, or the target date while in progress. */
export type TrainingEntry = {
  id: string; employeeId: string; name: string; provider: string; progress: number; date: string; result: string;
};

/**
 * The LMS part of an employee's training, always resolved as a value: `unavailable` when the LMS (or the
 * history read used to deduplicate) could not be reached. `asOf` is the oldest sync time across the
 * employees read; `stale` is true when any of them is stale.
 */
export type CurrentTraining =
  | {
    status: "ok"; asOf: string; stale: boolean; inProgress: TrainingEntry[]; lmsCompleted: TrainingEntry[];
    /** Each employee's own LMS freshness (per-employee views use it; the aggregate is for org-wide views). */
    freshness: Record<string, { asOf: string; stale: boolean }>;
  }
  | { status: "unavailable" };

export interface TrainingStore {
  /**
   * Completed training the session may see, newest completion first: every employee's for an
   * Administrator, the department subtree's for a manager, only the session's own for staff.
   * `employeeId` narrows the list to one employee (staff: only their own; manager: only in-scope ids;
   * anyone else's is `[]`).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<TrainingEntry[]>;
  /**
   * LMS enrolments of the given employees: every id for an Administrator; for a manager only ids in
   * their department subtree; for staff only their own id (any other id is dropped without an LMS call).
   * One LMS call per employee, in parallel.
   */
  currentFor(session: SessionIdentity, employeeIds: string[]): Promise<CurrentTraining>;
}

/** The training database is unreachable or refused the query. Never treat this as "no training". */
export class TrainingUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Training records are temporarily unavailable.", options);
    this.name = "TrainingUnavailableError";
  }
}

export type TrainingRow = {
  id: string; employee_id: string; programme: string; provider: string; result: string; completed_on: string;
};

const TABLE = "training_history";
const COLUMNS = "id,employee_id,programme,provider,result,completed_on";
const DEDUPE_COLUMNS = "employee_id,programme,provider";

/** A stored entry is always complete: progress 100, dated by its completion date. */
export function toTraining(row: TrainingRow): TrainingEntry {
  return {
    id: row.id, employeeId: row.employee_id, name: row.programme, provider: row.provider,
    progress: 100, date: row.completed_on, result: row.result,
  };
}

/**
 * An LMS enrolment as a training entry: in progress → its progress, dated by the target date, result
 * "In progress"; completed → progress 100, dated by the completion date, with the LMS result.
 */
export function enrolmentToTraining(enrolment: Enrolment): TrainingEntry {
  const base = { id: enrolment.id, employeeId: enrolment.employeeId, name: enrolment.programme, provider: enrolment.provider };
  return enrolment.status === "in_progress"
    ? { ...base, progress: enrolment.progress, date: enrolment.targetDate ?? "", result: "In progress" }
    : { ...base, progress: 100, date: enrolment.completedOn ?? "", result: enrolment.result };
}

/** The identity of a course for one employee: trimmed, case-insensitive programme and provider. */
export function courseKey(employeeId: string, programme: string, provider: string): string {
  return [employeeId, programme.trim().toLowerCase(), provider.trim().toLowerCase()].join("\u0000");
}

/**
 * The LMS-completed entries that are not already in stored history for the same employee (and not
 * repeated among themselves), so each completed course shows once: the stored entry wins.
 */
export function dedupeLmsCompleted(
  lmsCompleted: TrainingEntry[], stored: { employeeId: string; programme: string; provider: string }[],
): TrainingEntry[] {
  const seen = new Set(stored.map(s => courseKey(s.employeeId, s.programme, s.provider)));
  return lmsCompleted.filter(entry => {
    const key = courseKey(entry.employeeId, entry.name, entry.provider);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Result<T> = { data: T | null; error: unknown };

export type TrainingStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
  /** The LMS adapter (the only caller is this store). */
  lms: Pick<LmsClient, "listCurrentEnrolments">;
  /** The current time, used as `asOf` when no employee is read (injectable for tests). */
  now?: () => Date;
  /** Story 4.3: a manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createTrainingStore({ userClient, lms, now = () => new Date(), scope = managerScope }: TrainingStoreClients): TrainingStore {
  async function run<T>(query: (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new TrainingUnavailableError({ cause });
    }
    if (result.error) throw new TrainingUnavailableError({ cause: result.error });
    if (result.data === null || result.data === undefined) throw new TrainingUnavailableError({ cause: "no data returned" });
    return result.data;
  }

  /** The employee ids in a manager's subtree; a scope that cannot be read is TrainingUnavailableError, never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new TrainingUnavailableError({ cause });
      throw cause;
    }
  }

  async function listForManager(session: ManagerIdentity, employeeId: string | undefined): Promise<TrainingEntry[]> {
    const ids = await managedEmployeeIds(session);
    // Out of scope (or nothing in scope): nothing, without a training query.
    if (employeeId !== undefined && !ids.has(employeeId)) return [];
    if (ids.size === 0) return [];
    const rows = await run<TrainingRow[]>(t => {
      const query = t.select(COLUMNS);
      return (employeeId === undefined ? query.in("employee_id", [...ids]) : query.eq("employee_id", employeeId))
        .order("completed_on", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .returns<TrainingRow[]>();
    });
    // Defence in depth: only rows of in-scope employees (and of the one asked for).
    return rows.filter(r => ids.has(r.employee_id) && (employeeId === undefined || r.employee_id === employeeId)).map(toTraining);
  }

  return {
    async listFor(session, employeeId) {
      if (session.role === "manager") return listForManager(session, employeeId);
      // Staff only ever see their own training; asking for anyone else's returns nothing, without a query.
      if (session.role !== "admin" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const scope = session.role === "admin" ? employeeId : session.employeeId;
      const rows = await run<TrainingRow[]>(t => {
        const query = t.select(COLUMNS);
        return (scope === undefined ? query : query.eq("employee_id", scope))
          .order("completed_on", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .returns<TrainingRow[]>();
      });
      // Defence in depth: a staff session never receives another employee's rows.
      return rows.filter(r => scope === undefined || r.employee_id === scope).map(toTraining);
    },

    async currentFor(session, employeeIds) {
      // Staff: only their own id, whatever was asked (other ids are dropped without an LMS call).
      // Manager (Story 4.3): only ids in their department subtree; a scope that cannot be read is unavailable.
      let allowed: (id: string) => boolean;
      if (session.role === "admin") allowed = () => true;
      else if (session.role === "manager") {
        let inScope: Set<string>;
        try {
          inScope = await managedEmployeeIds(session);
        } catch (error) {
          if (error instanceof TrainingUnavailableError) return { status: "unavailable" };
          throw error;
        }
        allowed = id => inScope.has(id);
      } else allowed = id => id === session.employeeId;
      const ids = [...new Set(employeeIds)].filter(allowed);
      if (ids.length === 0) return { status: "ok", asOf: now().toISOString(), stale: false, inProgress: [], lmsCompleted: [], freshness: {} };

      let results: Awaited<ReturnType<LmsClient["listCurrentEnrolments"]>>[];
      try {
        results = await Promise.all(ids.map(id => lms.listCurrentEnrolments(id)));
      } catch (error) {
        if (error instanceof LmsUnavailableError) return { status: "unavailable" };
        throw error;
      }

      // Defence in depth: only enrolments of the employees asked for (and in scope).
      const enrolments = results.flatMap((result, i) => result.data.filter(e => e.employeeId === ids[i]));
      const inProgress = enrolments.filter(e => e.status === "in_progress").map(enrolmentToTraining);
      const completed = enrolments.filter(e => e.status === "completed").map(enrolmentToTraining);

      let lmsCompleted: TrainingEntry[] = [];
      if (completed.length > 0) {
        const owners = [...new Set(completed.map(e => e.employeeId))];
        let stored: { employee_id: string; programme: string; provider: string }[];
        try {
          stored = await run(t => t.select(DEDUPE_COLUMNS).in("employee_id", owners)
            .returns<{ employee_id: string; programme: string; provider: string }[]>());
        } catch (error) {
          // Without stored history the split cannot be guaranteed: never risk showing a course twice.
          if (error instanceof TrainingUnavailableError) return { status: "unavailable" };
          throw error;
        }
        lmsCompleted = dedupeLmsCompleted(completed, stored.map(s => ({ employeeId: s.employee_id, programme: s.programme, provider: s.provider })));
      }

      // The oldest parseable asOf; an unparseable one can never be shown as fresh.
      const times = results.map(r => Date.parse(r.asOf));
      const valid = times.filter(t => !Number.isNaN(t));
      const unparseable = valid.length < times.length;
      return {
        status: "ok",
        asOf: valid.length > 0 ? new Date(Math.min(...valid)).toISOString() : results[0].asOf,
        stale: unparseable || results.some(r => r.stale),
        inProgress,
        lmsCompleted,
        freshness: Object.fromEntries(results.map((r, i) => [ids[i], { asOf: r.asOf, stale: r.stale || Number.isNaN(times[i]) }])),
      };
    },
  };
}

export const trainingStore: TrainingStore = createTrainingStore({ userClient: getUserClient, lms: lmsClient });
