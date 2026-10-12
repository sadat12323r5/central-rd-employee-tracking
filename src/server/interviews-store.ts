import type { SupabaseClient } from "@supabase/supabase-js";
import type { Employee } from "@/data/employees";
import type { SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The only way the app reads and writes external interviews (Story 2.1). Interviews live in the
// Supabase `external_interviews` table.
//
// Privacy rule: an interview is visible only to the reporting employee and to Administrators. Every
// query goes through a per-request client carrying the signed-in user's JWT, so the RLS policies
// ("is this the employee, or an Administrator" — never a department lookup) are enforced. The checks
// here are the store-level layer on top: staff reads are filtered to the session's own employee, only a
// staff session can add, and the new row's employee always comes from the session. This module never
// uses the service role. There is no update or delete path (Story 2.2).
export type ExternalInterview = Employee["interviews"][number] & { employeeId: string };

/** What a staff member reports when adding an interview. The employee is never part of it. */
export type NewInterview = { company: string; role: string; date: string; stage: string; outcome: string };

export interface InterviewsStore {
  /**
   * Interviews the session may see, newest first: every interview for an Administrator, only the
   * session's own for staff. `employeeId` narrows the list to one employee (staff: only their own).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<ExternalInterview[]>;
  /** Adds an interview for the session's own employee. Only a staff session can add. */
  add(session: SessionIdentity, input: NewInterview): Promise<ExternalInterview>;
}

/** The interviews database is unreachable or refused the query. Never treat this as "no interviews" or "saved". */
export class InterviewsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("External interviews are temporarily unavailable.", options);
    this.name = "InterviewsUnavailableError";
  }
}

/** The session may not add interviews (Administrators and signed-out callers have no write path). */
export class InterviewsForbiddenError extends Error {
  constructor() {
    super("Sign in as a staff member to add an interview.");
    this.name = "InterviewsForbiddenError";
  }
}

export type InterviewRow = {
  id: string; employee_id: string; company: string; role: string; stage: string; interview_date: string; outcome: string; feedback: string;
};

const TABLE = "external_interviews";
const COLUMNS = "id,employee_id,company,role,stage,interview_date,outcome,feedback";

export function toInterview(row: InterviewRow): ExternalInterview {
  return {
    id: row.id, employeeId: row.employee_id, company: row.company, role: row.role, date: row.interview_date,
    stage: row.stage, outcome: row.outcome, feedback: row.feedback,
  };
}

type Result<T> = { data: T | null; error: unknown };

export type InterviewsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createInterviewsStore({ userClient }: InterviewsStoreClients): InterviewsStore {
  async function run<T>(query: (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new InterviewsUnavailableError({ cause });
    }
    if (result.error) throw new InterviewsUnavailableError({ cause: result.error });
    if (result.data === null || result.data === undefined) throw new InterviewsUnavailableError({ cause: "no data returned" });
    return result.data;
  }

  return {
    async listFor(session, employeeId) {
      // Staff only ever see their own interviews; asking for anyone else's returns nothing, without a query.
      const scope = session.role === "admin" ? employeeId : session.employeeId;
      if (session.role !== "admin" && employeeId !== undefined && employeeId !== session.employeeId) return [];
      const rows = await run<InterviewRow[]>(t => {
        const query = t.select(COLUMNS);
        return (scope === undefined ? query : query.eq("employee_id", scope))
          .order("interview_date", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .returns<InterviewRow[]>();
      });
      return rows.map(toInterview);
    },
    async add(session, input) {
      if (session.role !== "staff") throw new InterviewsForbiddenError();
      const row = {
        employee_id: session.employeeId, company: input.company, role: input.role, stage: input.stage,
        interview_date: input.date, outcome: input.outcome,
      };
      const saved = await run<InterviewRow>(t => t.insert(row).select(COLUMNS).single<InterviewRow>());
      // Defence in depth: the stored row must belong to the session's employee.
      if (saved.employee_id !== session.employeeId) throw new InterviewsUnavailableError({ cause: "saved for another employee" });
      return toInterview(saved);
    },
  };
}

export const interviewsStore: InterviewsStore = createInterviewsStore({ userClient: getUserClient });
