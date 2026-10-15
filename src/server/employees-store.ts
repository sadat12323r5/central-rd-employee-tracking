import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import { assignmentsStore, AssignmentsUnavailableError, type Assignment, type AssignmentsStore } from "./assignments-store";
import { interviewsStore, InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "./interviews-store";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import type { ManagerIdentity, SessionIdentity, StaffIdentity } from "./session";
import { readAllPages } from "./paging";
import { getUserClient } from "./supabase";
import { trainingStore, TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "./training-store";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table, external interviews from the `external_interviews` table (through interviews-store,
// Story 2.1), training through training-store (Story 3.1) and assignments through assignments-store
// (Story 4.5); the other nested profile data (skills, history, attendance summary, review) still comes
// from the fixture, merged by Employee ID, so callers see the same shape. The fixture's interviews,
// training and former "current work" are never read here.
//
// Every read (Administrator and Staff, Story 1.3) goes through a per-request client carrying the
// signed-in user's Supabase JWT, so the employees RLS policies are the enforced rule: an admin
// reads every row, a staff member only the row linked to their auth user (`auth_user_id`). The
// staff-own scoping below is kept as defence in depth. This module never uses the service role.
// Archived employees (Story 1.4, `archived_at` set) stay readable by Administrators, who see the
// `archived` flag; `isActive` lets auth.ts end an archived Staff member's session on every request.
//
// Story 4.3: a department manager reads the employees in their department subtree (manager-scope,
// computed fresh on each call), archived ones included and flagged, with their department; never
// `auth_user_id` and never interviews. RLS (employees_select_managed) bounds the same rows.
// Story 4.5: every role's profiles carry their assignments (scoped the same way by assignments-store).
export interface EmployeesStore {
  /** Every employee for an admin; the department subtree's employees for a manager; only the caller's own record for staff. */
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
  /** Selected on Administrator reads only (never for managers); mapped to `hasAccount`. */
  auth_user_id?: string | null;
  /** Selected on Administrator and manager reads; mapped to `archived`. */
  archived_at?: string | null;
  /** Selected on Administrator and manager reads; mapped to `departmentId` (Story 4.1). */
  department_id?: string | null;
};

const COLUMNS = "employee_id,name,title,team,employment_type,email,joined_on,manager,office,status,initials,avatar_color,summary";
/**
 * Administrators also see whether each employee has a linked sign-in account, whether it is archived,
 * and its department (Story 4.1; names are read separately through departments-store, never embedded).
 */
const ADMIN_COLUMNS = `${COLUMNS},auth_user_id,archived_at,department_id`;
/** Story 4.3: managers see each employee's department and whether it is archived, never the sign-in account link. */
const MANAGER_COLUMNS = `${COLUMNS},department_id,archived_at`;

/** Which extra fields a read maps: Administrator (account, archived, department), manager (archived, department) or none. */
export type EmployeeView = "admin" | "manager" | "basic";

type NestedProfile = Pick<Employee, "skills" | "history" | "attendance" | "review">;

const emptyProfile = (): NestedProfile => ({
  skills: [], history: [],
  attendance: { scheduled: 0, worked: 0, leave: 0, unrecorded: 0, records: [] },
  review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" },
});

function nestedFor(id: string): NestedProfile {
  const source = fixture.find(e => e.id === id);
  if (!source) return emptyProfile();
  const { skills, history, attendance, review } = structuredClone(source);
  return { skills, history, attendance, review };
}

/**
 * Maps a row to an Employee with the given interviews (from interviews-store), training (from
 * training-store) and assignments (from assignments-store, Story 4.5). The `admin` view (`true` is the same) adds `hasAccount` from `auth_user_id`,
 * `archived` from `archived_at` and `departmentId` from `department_id`; the `manager` view (Story 4.3)
 * adds `archived` and `departmentId` only.
 */
export function toEmployee(
  row: EmployeeRow, view: EmployeeView | boolean = "basic", interviews: Employee["interviews"] = [], training: Employee["training"] = [],
  assignments: Employee["assignments"] = [],
): Employee {
  const mode = view === true ? "admin" : view === false ? "basic" : view;
  return {
    id: row.employee_id, name: row.name, title: row.title, team: row.team, type: row.employment_type, email: row.email,
    joined: row.joined_on, manager: row.manager, location: row.office, status: row.status, initials: row.initials,
    color: row.avatar_color, summary: row.summary,
    ...(mode === "admin" ? { hasAccount: Boolean(row.auth_user_id) } : {}),
    ...(mode !== "basic" ? { archived: Boolean(row.archived_at), departmentId: row.department_id ?? null } : {}),
    ...nestedFor(row.employee_id),
    training,
    interviews,
    assignments,
  };
}

/** The interviews of one employee, without the store's `employeeId` (implied by the profile). */
const interviewsOf = (all: ExternalInterview[], employeeId: string): Employee["interviews"] =>
  all.filter(i => i.employeeId === employeeId).map(({ employeeId: _, ...interview }) => interview);

/** The training of one employee, in the store's order, without the store's `employeeId`. */
const trainingOf = (all: TrainingEntry[], employeeId: string): Employee["training"] =>
  all.filter(t => t.employeeId === employeeId).map(({ employeeId: _, ...entry }) => entry);

/** The assignments of one employee, in the store's order (open first, then history). */
const assignmentsOf = (all: Assignment[], employeeId: string): Employee["assignments"] =>
  all.filter(a => a.employeeId === employeeId);

type Result<T> = { data: T | null; error: unknown };

export type EmployeesStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every read. */
  userClient: () => Promise<SupabaseClient>;
  /** Where profile interviews come from (RLS-scoped through the same per-request JWT). */
  interviews: Pick<InterviewsStore, "listFor">;
  /** Where profile training comes from (RLS-scoped through the same per-request JWT). */
  training: Pick<TrainingStore, "listFor">;
  /** Story 4.5: where profile assignments come from (RLS-scoped through the same per-request JWT). */
  assignments: Pick<AssignmentsStore, "listFor">;
  /** Story 4.3: a manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createEmployeesStore({ userClient, interviews, training, assignments, scope = managerScope }: EmployeesStoreClients): EmployeesStore {
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

  /** A failed training read makes the whole record unavailable: never a profile with missing training. */
  async function trainingFor(session: SessionIdentity, employeeId?: string): Promise<TrainingEntry[]> {
    try {
      return await training.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof TrainingUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** A failed assignments read makes the whole record unavailable: never a profile with missing assignments. */
  async function assignmentsFor(session: SessionIdentity, employeeId?: string): Promise<Assignment[]> {
    try {
      return await assignments.listFor(session, employeeId);
    } catch (cause) {
      if (cause instanceof AssignmentsUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  const columnsFor = (session: SessionIdentity) => (session.role === "admin" ? ADMIN_COLUMNS : COLUMNS);

  /** The employee ids in a manager's subtree. A scope that cannot be read makes the records unavailable: never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  /** Story 4.3: the manager's subtree, archived employees included and flagged. Interviews are always `[]`. */
  async function listForManager(session: ManagerIdentity): Promise<Employee[]> {
    const ids = await managedEmployeeIds(session);
    if (ids.size === 0) return [];
    const [rows, allTraining, allAssignments] = await Promise.all([
      // Paged (Story 8.2) like the Administrator list: employee_id is the primary key, so the order is total.
      readAllPages(async (from, to) => {
        const page = await run<EmployeeRow[]>(t => t.select(MANAGER_COLUMNS).in("employee_id", [...ids])
          .order("employee_id").range(from, to).returns<EmployeeRow[]>());
        if (!page) throw new EmployeesUnavailableError({ cause: "no data returned" });
        return page;
      }),
      trainingFor(session),
      assignmentsFor(session),
    ]);
    // Defence in depth: never a row outside the scope, whatever the query returned.
    return rows.filter(row => ids.has(row.employee_id))
      .map(row => toEmployee(row, "manager", [], trainingOf(allTraining, row.employee_id), assignmentsOf(allAssignments, row.employee_id)));
  }

  async function getForManager(session: ManagerIdentity, id: string): Promise<Employee | null> {
    // Outside the subtree: null, without reading the employee.
    if (!(await managedEmployeeIds(session)).has(id)) return null;
    const row = await run<EmployeeRow>(t => t.select(MANAGER_COLUMNS).eq("employee_id", id).maybeSingle<EmployeeRow>());
    if (!row) return null;
    const [ownTraining, ownAssignments] = await Promise.all([trainingFor(session, id), assignmentsFor(session, id)]);
    return toEmployee(row, "manager", [], trainingOf(ownTraining, id), assignmentsOf(ownAssignments, id));
  }

  return {
    async listFor(session) {
      if (session.role === "manager") return listForManager(session);
      // One interviews, one training and one assignments read for the whole list: everyone's for an admin, the caller's own for staff.
      const [rows, all, allTraining, allAssignments] = await Promise.all([
        // Paged (Story 8.2): one request is capped at PostgREST's max_rows. employee_id is the primary
        // key, so ordering by it alone is total.
        readAllPages(async (from, to) => {
          const page = await run<EmployeeRow[]>(t => {
            const query = t.select(columnsFor(session));
            return (session.role === "admin" ? query : query.eq("employee_id", session.employeeId))
              .order("employee_id").range(from, to).returns<EmployeeRow[]>();
          });
          if (!page) throw new EmployeesUnavailableError({ cause: "no data returned" });
          return page;
        }),
        interviewsFor(session),
        trainingFor(session),
        assignmentsFor(session),
      ]);
      return rows.map(row => toEmployee(
        row, session.role === "admin", interviewsOf(all, row.employee_id), trainingOf(allTraining, row.employee_id),
        assignmentsOf(allAssignments, row.employee_id),
      ));
    },
    async getFor(session, id) {
      if (session.role === "manager") return getForManager(session, id);
      if (session.role !== "admin" && id !== session.employeeId) return null;
      const row = await run<EmployeeRow>(t => t.select(columnsFor(session)).eq("employee_id", id).maybeSingle<EmployeeRow>());
      if (!row) return null;
      const [own, ownTraining, ownAssignments] = await Promise.all([interviewsFor(session, id), trainingFor(session, id), assignmentsFor(session, id)]);
      return toEmployee(row, session.role === "admin", interviewsOf(own, id), trainingOf(ownTraining, id), assignmentsOf(ownAssignments, id));
    },
    async isActive(session) {
      const row = await run<{ archived_at: string | null }>(t => t.select("archived_at").eq("employee_id", session.employeeId).maybeSingle<{ archived_at: string | null }>());
      return row !== null && !row.archived_at;
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore({
  userClient: getUserClient, interviews: interviewsStore, training: trainingStore, assignments: assignmentsStore,
});
