import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import { interviewsStore, InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "./interviews-store";
import type { SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table and external interviews from the `external_interviews` table (through interviews-store,
// Story 2.1); the other nested profile data (skills, history, training, work, attendance summary,
// review) still comes from the fixture, merged by Employee ID, so callers see the same shape.
// The fixture's interviews are seed data only (scripts/seed-employees.ts) and never read here.
//
// Every read (Administrator and Staff, Story 1.3) goes through a per-request client carrying the
// signed-in user's Supabase JWT, so the employees RLS policies are the enforced rule: an admin
// reads every row, a staff member only the row linked to their auth user (`auth_user_id`). The
// staff-own scoping below is kept as defence in depth. This module never uses the service role.
export interface EmployeesStore {
  /** Every employee for an admin; only the caller's own record for staff. */
  listFor(session: SessionIdentity): Promise<Employee[]>;
  /** The employee, or null when it does not exist or is outside the caller's scope. */
  getFor(session: SessionIdentity, id: string): Promise<Employee | null>;
}

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
  /** Selected on Administrator reads only; mapped to `hasAccount`. */
  auth_user_id?: string | null;
};

const COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary";
/** Administrators also see whether each employee has a linked sign-in account. */
const ADMIN_COLUMNS = `${COLUMNS},auth_user_id`;

type NestedProfile = Pick<Employee, "skills" | "history" | "training" | "work" | "attendance" | "review">;

const emptyProfile = (): NestedProfile => ({
  skills: [], history: [], training: [],
  work: { project: "", role: "", allocation: 0, update: "", commits: 0, period: "" },
  attendance: { scheduled: 0, worked: 0, leave: 0, unrecorded: 0, records: [] },
  review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" },
});

function nestedFor(id: string): NestedProfile {
  const source = fixture.find(e => e.id === id);
  if (!source) return emptyProfile();
  const { skills, history, training, work, attendance, review } = structuredClone(source);
  return { skills, history, training, work, attendance, review };
}

/**
 * Maps a row to an Employee with the given interviews (from interviews-store); `withAccount`
 * (Administrator reads only) adds `hasAccount` from `auth_user_id`.
 */
export function toEmployee(row: EmployeeRow, withAccount = false, interviews: Employee["interviews"] = []): Employee {
  return {
    id: row.employee_id, name: row.name, title: row.title, team: row.team, type: row.employment_type, email: row.email,
    joined: row.joined_on, manager: row.manager, location: row.office, status: row.status, initials: row.initials,
    color: row.avatar_color, summary: row.summary,
    ...(withAccount ? { hasAccount: Boolean(row.auth_user_id) } : {}),
    ...nestedFor(row.employee_id),
    interviews,
  };
}

/** The interviews of one employee, without the store's `employeeId` (implied by the profile). */
const interviewsOf = (all: ExternalInterview[], employeeId: string): Employee["interviews"] =>
  all.filter(i => i.employeeId === employeeId).map(({ employeeId: _, ...interview }) => interview);

type Result<T> = { data: T | null; error: unknown };

export type EmployeesStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every read. */
  userClient: () => Promise<SupabaseClient>;
  /** Where profile interviews come from (RLS-scoped through the same per-request JWT). */
  interviews: Pick<InterviewsStore, "listFor">;
};

export function createEmployeesStore({ userClient, interviews }: EmployeesStoreClients): EmployeesStore {
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

  const columnsFor = (session: SessionIdentity) => (session.role === "admin" ? ADMIN_COLUMNS : COLUMNS);

  return {
    async listFor(session) {
      // One interviews query for the whole list: every interview for an admin, the caller's own for staff.
      const [rows, all] = await Promise.all([
        run<EmployeeRow[]>(t => {
          const query = t.select(columnsFor(session));
          return (session.role === "admin" ? query : query.eq("employee_id", session.employeeId)).order("employee_id").returns<EmployeeRow[]>();
        }),
        interviewsFor(session),
      ]);
      if (!rows) throw new EmployeesUnavailableError({ cause: "no data returned" });
      return rows.map(row => toEmployee(row, session.role === "admin", interviewsOf(all, row.employee_id)));
    },
    async getFor(session, id) {
      if (session.role !== "admin" && id !== session.employeeId) return null;
      const row = await run<EmployeeRow>(t => t.select(columnsFor(session)).eq("employee_id", id).maybeSingle<EmployeeRow>());
      if (!row) return null;
      return toEmployee(row, session.role === "admin", interviewsOf(await interviewsFor(session, id), id));
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore({ userClient: getUserClient, interviews: interviewsStore });
