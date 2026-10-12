import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import type { SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The single source of training for every view (Story 3.1): the staff portal, the Administrator's
// Training tab and the org-wide Learning & development view all read training through here.
//
// Completed entries live in the Supabase `training_history` table (no department column: training
// stays with the employee). In-progress entries are still served from the fixture
// (`src/data/employees.ts`, `progress < 100`) until Story 3.2 replaces that source with the LMS
// adapter; they are never copied into the table. RLS applies only to `training_history` reads; the
// in-progress fixture entries are scoped by this store alone, from the session (role and employeeId).
//
// Privacy rule: an entry is visible only to the employee and to Administrators. Every table query goes
// through a per-request client carrying the signed-in user's JWT, so the RLS policies ("is this the
// employee, or an Administrator" — never a department or manager lookup) are enforced on stored rows.
// The scoping here is the store-level layer: staff reads are filtered to the session's own employee
// (for fixture in-progress entries it is the only layer). There
// is no write path (creating or editing training outside the LMS is deferred). This module never uses
// the service role.
export type TrainingEntry = Employee["training"][number] & { employeeId: string };

export interface TrainingStore {
  /**
   * Training the session may see: every employee's for an Administrator, only the session's own for
   * staff. `employeeId` narrows the list to one employee (staff: only their own; anyone else's is `[]`).
   * Completed entries come first (newest completion first), then in-progress entries in fixture order.
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<TrainingEntry[]>;
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

/** A stored entry is always complete: progress 100, dated by its completion date. */
export function toTraining(row: TrainingRow): TrainingEntry {
  return {
    id: row.id, employeeId: row.employee_id, name: row.programme, provider: row.provider,
    progress: 100, date: row.completed_on, result: row.result,
  };
}

/**
 * In-progress entries (until Story 3.2): the fixture's entries below 100%, in fixture order. No RLS
 * applies here: callers must pass the scope derived from the session.
 */
export function fixtureInProgress(list: Employee[], employeeId?: string): TrainingEntry[] {
  return list
    .filter(e => employeeId === undefined || e.id === employeeId)
    .flatMap(e => e.training.filter(t => t.progress < 100).map(t => ({ ...t, employeeId: e.id })));
}

type Result<T> = { data: T | null; error: unknown };

export type TrainingStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createTrainingStore({ userClient }: TrainingStoreClients): TrainingStore {
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

  return {
    async listFor(session, employeeId) {
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
      const completed = rows.filter(r => scope === undefined || r.employee_id === scope).map(toTraining);
      return [...completed, ...structuredClone(fixtureInProgress(fixture, scope))];
    },
  };
}

export const trainingStore: TrainingStore = createTrainingStore({ userClient: getUserClient });
