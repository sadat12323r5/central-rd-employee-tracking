import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import type { SessionIdentity, StaffIdentity } from "./session";
import { getUserClient } from "./supabase";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table; nested profile data (skills, history, training, work, interviews, attendance summary,
// review) still comes from the fixture, merged by Employee ID, so callers see the same shape.
//
// Every read (Administrator and Staff, Story 1.3) goes through a per-request client carrying the
// signed-in user's Supabase JWT, so the employees RLS policies are the enforced rule: an admin
// reads every row, a staff member only the row linked to their auth user (`auth_user_id`). The
// staff-own scoping below is kept as defence in depth. This module never uses the service role.
// Archived employees (Story 1.4, `archived_at` set) stay readable by Administrators, who see the
// `archived` flag; `isActive` lets auth.ts end an archived Staff member's session on every request.
export interface EmployeesStore {
  /** Every employee for an admin; only the caller's own record for staff. */
  listFor(session: SessionIdentity): Promise<Employee[]>;
  /** The employee, or null when it does not exist or is outside the caller's scope. */
  getFor(session: SessionIdentity, id: string): Promise<Employee | null>;
  /**
   * True when the staff session's own employee row is visible to its JWT (RLS) and not archived.
   * False when the row is missing, unlinked or archived. Throws EmployeesUnavailableError on a read error.
   */
  isActive(session: StaffIdentity): Promise<boolean>;
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
  /** Selected on Administrator reads only; mapped to `archived`. */
  archived_at?: string | null;
};

const COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary";
/** Administrators also see whether each employee has a linked sign-in account and whether it is archived. */
const ADMIN_COLUMNS = `${COLUMNS},auth_user_id,archived_at`;

type NestedProfile = Pick<Employee, "skills" | "history" | "training" | "work" | "interviews" | "attendance" | "review">;

const emptyProfile = (): NestedProfile => ({
  skills: [], history: [], training: [], interviews: [],
  work: { project: "", role: "", allocation: 0, update: "", commits: 0, period: "" },
  attendance: { scheduled: 0, worked: 0, leave: 0, unrecorded: 0, records: [] },
  review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" },
});

function nestedFor(id: string): NestedProfile {
  const source = fixture.find(e => e.id === id);
  if (!source) return emptyProfile();
  const { skills, history, training, work, interviews, attendance, review } = structuredClone(source);
  return { skills, history, training, work, interviews, attendance, review };
}

/**
 * Maps a row to an Employee; `withAccount` (Administrator reads only) adds `hasAccount` from
 * `auth_user_id` and `archived` from `archived_at`.
 */
export function toEmployee(row: EmployeeRow, withAccount = false): Employee {
  return {
    id: row.employee_id, name: row.name, title: row.title, team: row.team, type: row.employment_type, email: row.email,
    joined: row.joined_on, manager: row.manager, location: row.office, status: row.status, initials: row.initials,
    color: row.avatar_color, summary: row.summary,
    ...(withAccount ? { hasAccount: Boolean(row.auth_user_id), archived: Boolean(row.archived_at) } : {}),
    ...nestedFor(row.employee_id),
  };
}

type Result<T> = { data: T | null; error: unknown };

export type EmployeesStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every read. */
  userClient: () => Promise<SupabaseClient>;
};

export function createEmployeesStore({ userClient }: EmployeesStoreClients): EmployeesStore {
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

  const columnsFor = (session: SessionIdentity) => (session.role === "admin" ? ADMIN_COLUMNS : COLUMNS);

  return {
    async listFor(session) {
      const rows = await run<EmployeeRow[]>(t => {
        const query = t.select(columnsFor(session));
        return (session.role === "admin" ? query : query.eq("employee_id", session.employeeId)).order("employee_id").returns<EmployeeRow[]>();
      });
      if (!rows) throw new EmployeesUnavailableError({ cause: "no data returned" });
      return rows.map(row => toEmployee(row, session.role === "admin"));
    },
    async getFor(session, id) {
      if (session.role !== "admin" && id !== session.employeeId) return null;
      const row = await run<EmployeeRow>(t => t.select(columnsFor(session)).eq("employee_id", id).maybeSingle<EmployeeRow>());
      return row ? toEmployee(row, session.role === "admin") : null;
    },
    async isActive(session) {
      const row = await run<{ archived_at: string | null }>(t => t.select("archived_at").eq("employee_id", session.employeeId).maybeSingle<{ archived_at: string | null }>());
      return row !== null && !row.archived_at;
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore({ userClient: getUserClient });
