import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import type { SessionIdentity } from "./session";
import { getServiceClient } from "./supabase";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table; nested profile data (skills, history, training, work, interviews, attendance summary,
// review) still comes from the fixture, merged by Employee ID, so callers see the same shape.
//
// Story 1.1 reads with the service-role client because demo sessions are HMAC cookies, not
// Supabase JWTs, so RLS cannot identify the caller yet. Role scoping is therefore enforced here:
// admin reads every employee, staff reads only their session's employeeId. Story 1.2 swaps this
// for a per-request client carrying the user's JWT, making the RLS policies the enforced rule.
export interface EmployeesStore {
  /** Every employee for an admin; only the caller's own record for staff. */
  listFor(session: SessionIdentity): Promise<Employee[]>;
  /** The employee, or null when it does not exist or is outside the caller's scope. */
  getFor(session: SessionIdentity, id: string): Promise<Employee | null>;
  /** Sign-in lookup by primary email (case-insensitive), or null when no employee matches. */
  findByEmail(email: string): Promise<Employee | null>;
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
};

const COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary";

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

export function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.employee_id, name: row.name, title: row.title, team: row.team, type: row.employment_type, email: row.email,
    joined: row.joined_on, manager: row.manager, location: row.office, status: row.status, initials: row.initials,
    color: row.avatar_color, summary: row.summary, ...nestedFor(row.employee_id),
  };
}

type Result<T> = { data: T | null; error: unknown };

export function createEmployeesStore(getClient: () => SupabaseClient): EmployeesStore {
  async function run<T>(query: (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query(getClient().from("employees"));
    } catch (cause) {
      throw new EmployeesUnavailableError({ cause });
    }
    if (result.error) throw new EmployeesUnavailableError({ cause: result.error });
    return result.data;
  }

  const one = async (column: "employee_id" | "email", value: string) => {
    const row = await run<EmployeeRow>(t => t.select(COLUMNS).eq(column, value).maybeSingle<EmployeeRow>());
    return row ? toEmployee(row) : null;
  };

  return {
    async listFor(session) {
      const rows = await run<EmployeeRow[]>(t => {
        const query = t.select(COLUMNS);
        return (session.role === "admin" ? query : query.eq("employee_id", session.employeeId)).order("employee_id").returns<EmployeeRow[]>();
      });
      if (!rows) throw new EmployeesUnavailableError({ cause: "no data returned" });
      return rows.map(toEmployee);
    },
    async getFor(session, id) {
      if (session.role !== "admin" && id !== session.employeeId) return null;
      return one("employee_id", id);
    },
    async findByEmail(email) {
      const normalised = email.trim().toLowerCase();
      if (!normalised) return null;
      return one("email", normalised);
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore(getServiceClient);
