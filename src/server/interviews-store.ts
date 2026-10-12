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
// uses the service role.
//
// Story 2.2 adds the update and withdraw paths: only the author (session employee = row employee), only
// a staff session, only while the entry is not withdrawn, and only stage/outcome/feedback. Company, role
// and date are locked (also refused by a database trigger for everyone). There is no delete path.
export type ExternalInterview = Employee["interviews"][number] & { employeeId: string };

/** What a staff member reports when adding an interview. The employee is never part of it. */
export type NewInterview = { company: string; role: string; date: string; stage: string; outcome: string };

/** The only fields an author can change after creation. Company, role and date are locked. */
export type InterviewChanges = { stage: string; outcome: string; feedback: string };
const EDITABLE: readonly string[] = ["stage", "outcome", "feedback"] satisfies (keyof InterviewChanges)[];

export interface InterviewsStore {
  /**
   * Interviews the session may see, newest first: every interview for an Administrator, only the
   * session's own for staff. `employeeId` narrows the list to one employee (staff: only their own).
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<ExternalInterview[]>;
  /** Adds an interview for the session's own employee. Only a staff session can add. */
  add(session: SessionIdentity, input: NewInterview): Promise<ExternalInterview>;
  /**
   * Changes the stage, outcome and feedback of the session's own, not-withdrawn interview. Only a staff
   * session can update; any other key (company, role, date, …) is refused with InterviewLockedError.
   */
  update(session: SessionIdentity, id: string, changes: InterviewChanges): Promise<ExternalInterview>;
  /** Withdraws the session's own, not-withdrawn interview (sets `withdrawn_at` once). Never deletes. */
  withdraw(session: SessionIdentity, id: string): Promise<ExternalInterview>;
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

/** No interview with this id belongs to the session's employee (unknown, or another employee's). */
export class InterviewNotFoundError extends Error {
  constructor() {
    super("That interview was not found, or it is not yours.");
    this.name = "InterviewNotFoundError";
  }
}

/** The interview was withdrawn and can no longer be changed. */
export class InterviewWithdrawnError extends Error {
  constructor() {
    super("That interview has already been withdrawn and can no longer be changed.");
    this.name = "InterviewWithdrawnError";
  }
}

/** Company, role and date (and anything else but stage, outcome and feedback) are locked after creation. */
export class InterviewLockedError extends Error {
  constructor() {
    super("Company, role and date can't be changed after an interview is added.");
    this.name = "InterviewLockedError";
  }
}

export type InterviewRow = {
  id: string; employee_id: string; company: string; role: string; stage: string; interview_date: string; outcome: string; feedback: string;
  withdrawn_at: string | null;
};

const TABLE = "external_interviews";
const COLUMNS = "id,employee_id,company,role,stage,interview_date,outcome,feedback,withdrawn_at";

export function toInterview(row: InterviewRow): ExternalInterview {
  return {
    id: row.id, employeeId: row.employee_id, company: row.company, role: row.role, date: row.interview_date,
    stage: row.stage, outcome: row.outcome, feedback: row.feedback, withdrawn: row.withdrawn_at !== null && row.withdrawn_at !== undefined,
  };
}

type Result<T> = { data: T | null; error: unknown };

export type InterviewsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createInterviewsStore({ userClient }: InterviewsStoreClients): InterviewsStore {
  type Query<T> = (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>;

  /** Runs a query whose "no row" is a legitimate answer (maybeSingle): null means not found. */
  async function runMaybe<T>(query: Query<T>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new InterviewsUnavailableError({ cause });
    }
    if (result.error) throw new InterviewsUnavailableError({ cause: result.error });
    return result.data ?? null;
  }

  async function run<T>(query: Query<T>): Promise<T> {
    const data = await runMaybe(query);
    if (data === null) throw new InterviewsUnavailableError({ cause: "no data returned" });
    return data;
  }

  /**
   * Shared path for update and withdraw: staff only, the session's own row, not withdrawn. The update
   * itself is filtered by id, the session's employee and `withdrawn_at is null`, so a row withdrawn or
   * reassigned in between updates nothing (reported as not found).
   */
  async function change(session: SessionIdentity, id: string, values: Partial<InterviewChanges> & { withdrawn_at?: string }) {
    if (session.role !== "staff") throw new InterviewsForbiddenError();
    const current = await runMaybe<InterviewRow>(t => t.select(COLUMNS).eq("id", id).maybeSingle<InterviewRow>());
    if (!current || current.employee_id !== session.employeeId) throw new InterviewNotFoundError();
    if (current.withdrawn_at !== null && current.withdrawn_at !== undefined) throw new InterviewWithdrawnError();
    const saved = await runMaybe<InterviewRow>(t => t.update(values)
      .eq("id", id).eq("employee_id", session.employeeId).is("withdrawn_at", null)
      .select(COLUMNS).maybeSingle<InterviewRow>());
    if (!saved || saved.employee_id !== session.employeeId) throw new InterviewNotFoundError();
    return toInterview(saved);
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
    async update(session, id, changes) {
      if (session.role !== "staff") throw new InterviewsForbiddenError();
      // Only stage, outcome and feedback: anything else (company, role, date, employee, …) is refused.
      if (Object.keys(changes).some(key => !EDITABLE.includes(key))) throw new InterviewLockedError();
      return change(session, id, { stage: changes.stage, outcome: changes.outcome, feedback: changes.feedback });
    },
    async withdraw(session, id) {
      return change(session, id, { withdrawn_at: new Date().toISOString() });
    },
  };
}

export const interviewsStore: InterviewsStore = createInterviewsStore({ userClient: getUserClient });
