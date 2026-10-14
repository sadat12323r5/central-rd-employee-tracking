import type { SupabaseClient } from "@supabase/supabase-js";
import { employees as fixture, type Employee } from "@/data/employees";
import {
  derivedFields, invalidEmployeeDetailsFields, invalidNewEmployeeFields, normalizeEmployeeDetails, normalizeNewEmployee,
  type EmployeeDetailsInput, type NewEmployeeField, type NewEmployeeInput,
} from "@/domain/employee-input";
import { interviewsStore, InterviewsUnavailableError, type ExternalInterview, type InterviewsStore } from "./interviews-store";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import type { ManagerIdentity, SessionIdentity, StaffIdentity } from "./session";
import { readAllPages } from "./paging";
import { getUserClient } from "./supabase";
import { trainingStore, TrainingUnavailableError, type TrainingEntry, type TrainingStore } from "./training-store";

// The only way the app reads employees (AD-2). Basic details come from the Supabase `employees`
// table, external interviews from the `external_interviews` table (through interviews-store,
// Story 2.1) and training through training-store (Story 3.1); the other nested profile data (skills,
// history, work, attendance summary, review) still comes from the fixture, merged by Employee ID, so
// callers see the same shape. The fixture's interviews and training are never read here.
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
//
// Story 7.1: `create` adds a new employee through the same per-request client (never the service role).
// The Administrator may add to any department, a manager only to a department in their subtree (checked
// here against manager-scope, and again by the employees_insert_* RLS policies); Staff never. The
// department is required. Status, initials, avatar colour and summary are derived, never taken from the
// input, and the row never carries an account link or an archived flag: accounts come only from
// accounts-store (Story 1.3).
//
// Story 7.2: `updateDetails` edits an existing employee's title, team, reporting manager, office and
// employment type through the per-request client's rpc to public.update_employee_details (a SECURITY
// DEFINER function that names only those five columns; there is no update policy on employees). The
// Administrator may edit anyone, a manager only employees in their subtree (checked here against
// manager-scope before the rpc, and again by the function); Staff never, not even their own record.
// The department never changes here: only through a transfer.
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
  /**
   * Story 7.1: adds a new employee. Throws EmployeeForbiddenError (Staff, or a department outside a
   * manager's subtree), EmployeeValidationError (bad input, unknown department), EmployeeExistsError
   * (duplicate Employee ID or email) or EmployeesUnavailableError. Never creates a sign-in account.
   */
  create(session: SessionIdentity, input: NewEmployeeInput): Promise<{ employeeId: string; name: string }>;
  /**
   * Story 7.2: saves an employee's title, team, reporting manager, office and employment type (nothing
   * else). Throws EmployeeForbiddenError (Staff, or an employee outside a manager's subtree),
   * EmployeeValidationError (bad input), EmployeeNotFoundError (no such employee) or EmployeesUnavailableError.
   */
  updateDetails(session: SessionIdentity, employeeId: string, input: EmployeeDetailsInput): Promise<{ employeeId: string; name: string }>;
}

/** The caller may not add or edit this employee: a Staff session, or outside a manager's subtree. */
export class EmployeeForbiddenError extends Error {
  constructor() {
    super("Only an Administrator, or a manager for their own department subtree, can add or edit employees.");
    this.name = "EmployeeForbiddenError";
  }
}

/**
 * The input failed validation. `fields` names the offending inputs; values are never included.
 * `"details"` means the database function refused the basic details without naming a field (Story 7.2).
 */
export class EmployeeValidationError extends Error {
  readonly fields: (NewEmployeeField | "details")[];
  constructor(fields: (NewEmployeeField | "details")[]) {
    super(`Invalid employee details: ${fields.join(", ")}.`);
    this.name = "EmployeeValidationError";
    this.fields = fields;
  }
}

/** An employee with this Employee ID or primary email already exists. */
export class EmployeeExistsError extends Error {
  readonly field: "employeeId" | "email";
  constructor(field: "employeeId" | "email") {
    super(field === "employeeId" ? "An employee with this Employee ID already exists." : "An employee with this email already exists.");
    this.name = "EmployeeExistsError";
    this.field = field;
  }
}

/** Story 7.2: there is no employee with this Employee ID. */
export class EmployeeNotFoundError extends Error {
  constructor() {
    super("No employee has this Employee ID.");
    this.name = "EmployeeNotFoundError";
  }
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

type NestedProfile = Pick<Employee, "skills" | "history" | "work" | "attendance" | "review">;

const emptyProfile = (): NestedProfile => ({
  skills: [], history: [],
  work: { project: "", role: "", allocation: 0, update: "", commits: 0, period: "" },
  attendance: { scheduled: 0, worked: 0, leave: 0, unrecorded: 0, records: [] },
  review: { date: "", reviewer: "", readiness: "", strengths: "", next: "" },
});

function nestedFor(id: string): NestedProfile {
  const source = fixture.find(e => e.id === id);
  if (!source) return emptyProfile();
  const { skills, history, work, attendance, review } = structuredClone(source);
  return { skills, history, work, attendance, review };
}

/**
 * Maps a row to an Employee with the given interviews (from interviews-store) and training (from
 * training-store). The `admin` view (`true` is the same) adds `hasAccount` from `auth_user_id`,
 * `archived` from `archived_at` and `departmentId` from `department_id`; the `manager` view (Story 4.3)
 * adds `archived` and `departmentId` only.
 */
export function toEmployee(
  row: EmployeeRow, view: EmployeeView | boolean = "basic", interviews: Employee["interviews"] = [], training: Employee["training"] = [],
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
  };
}

/** The interviews of one employee, without the store's `employeeId` (implied by the profile). */
const interviewsOf = (all: ExternalInterview[], employeeId: string): Employee["interviews"] =>
  all.filter(i => i.employeeId === employeeId).map(({ employeeId: _, ...interview }) => interview);

/** The training of one employee, in the store's order, without the store's `employeeId`. */
const trainingOf = (all: TrainingEntry[], employeeId: string): Employee["training"] =>
  all.filter(t => t.employeeId === employeeId).map(({ employeeId: _, ...entry }) => entry);

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string; details?: string };

/** Maps an insert refusal to the store's typed errors; anything unrecognised is "unavailable". */
function insertRefusal(error: DbError): Error {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "23505") {
    if (/employees_pkey|\(employee_id\)/.test(text)) return new EmployeeExistsError("employeeId");
    if (/employees_email_key|\(email\)/.test(text)) return new EmployeeExistsError("email");
  }
  // 23503: no such department; 22P02: not even a valid department id.
  if (error.code === "23503" || error.code === "22P02") return new EmployeeValidationError(["departmentId"]);
  if (error.code === "42501") return new EmployeeForbiddenError();
  return new EmployeesUnavailableError({ cause: error });
}

/** Story 7.2: maps an update_employee_details refusal to the store's typed errors; anything else is "unavailable". */
function detailsRefusal(error: DbError): Error {
  switch (error.message) {
    case "not_authorized": return new EmployeeForbiddenError();
    case "invalid_input": return new EmployeeValidationError(["details"]);
    case "employee_not_found": return new EmployeeNotFoundError();
    default: return new EmployeesUnavailableError({ cause: error });
  }
}

export type EmployeesStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every read. */
  userClient: () => Promise<SupabaseClient>;
  /** Where profile interviews come from (RLS-scoped through the same per-request JWT). */
  interviews: Pick<InterviewsStore, "listFor">;
  /** Where profile training comes from (RLS-scoped through the same per-request JWT). */
  training: Pick<TrainingStore, "listFor">;
  /** Story 4.3: a manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createEmployeesStore({ userClient, interviews, training, scope = managerScope }: EmployeesStoreClients): EmployeesStore {
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
    const [rows, allTraining] = await Promise.all([
      // Paged (Story 8.2) like the Administrator list: employee_id is the primary key, so the order is total.
      readAllPages(async (from, to) => {
        const page = await run<EmployeeRow[]>(t => t.select(MANAGER_COLUMNS).in("employee_id", [...ids])
          .order("employee_id").range(from, to).returns<EmployeeRow[]>());
        if (!page) throw new EmployeesUnavailableError({ cause: "no data returned" });
        return page;
      }),
      trainingFor(session),
    ]);
    // Defence in depth: never a row outside the scope, whatever the query returned.
    return rows.filter(row => ids.has(row.employee_id))
      .map(row => toEmployee(row, "manager", [], trainingOf(allTraining, row.employee_id)));
  }

  async function getForManager(session: ManagerIdentity, id: string): Promise<Employee | null> {
    // Outside the subtree: null, without reading the employee.
    if (!(await managedEmployeeIds(session)).has(id)) return null;
    const row = await run<EmployeeRow>(t => t.select(MANAGER_COLUMNS).eq("employee_id", id).maybeSingle<EmployeeRow>());
    if (!row) return null;
    return toEmployee(row, "manager", [], trainingOf(await trainingFor(session, id), id));
  }

  /** Story 7.1: the departments a manager may add employees to. Scope failure: unavailable, never "allowed". */
  async function managedDepartmentIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).departmentIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new EmployeesUnavailableError({ cause });
      throw cause;
    }
  }

  return {
    async create(session, input) {
      // Staff never add employees: refused before any query.
      if (session.role !== "admin" && session.role !== "manager") throw new EmployeeForbiddenError();
      const employee = normalizeNewEmployee(input);
      const invalid = invalidNewEmployeeFields(employee);
      if (invalid.length > 0) throw new EmployeeValidationError(invalid);
      if (session.role === "manager" && !(await managedDepartmentIds(session)).has(employee.departmentId)) {
        throw new EmployeeForbiddenError();
      }
      const derived = derivedFields(employee);
      let result: { error: DbError | null };
      try {
        // No .select(): nothing is read back, so only the insert policies apply.
        result = await (await userClient()).from("employees").insert({
          employee_id: employee.employeeId, name: employee.name, title: employee.title, team: employee.team,
          employment_type: employee.employmentType, email: employee.email, joined_on: employee.joinedOn,
          manager: employee.manager, office: employee.office, department_id: employee.departmentId,
          status: derived.status, initials: derived.initials, avatar_color: derived.avatarColor, summary: derived.summary,
        });
      } catch (cause) {
        throw new EmployeesUnavailableError({ cause });
      }
      if (result.error) throw insertRefusal(result.error);
      return { employeeId: employee.employeeId, name: employee.name };
    },
    async updateDetails(session, employeeId, input) {
      // Staff never edit basic details, not even their own: refused before any query.
      if (session.role !== "admin" && session.role !== "manager") throw new EmployeeForbiddenError();
      // Outside a manager's subtree: refused without calling the function.
      if (session.role === "manager" && !(await managedEmployeeIds(session)).has(employeeId)) {
        throw new EmployeeForbiddenError();
      }
      const details = normalizeEmployeeDetails(input);
      const invalid = invalidEmployeeDetailsFields(details);
      if (invalid.length > 0) throw new EmployeeValidationError(invalid);
      let result: { data: unknown; error: DbError | null };
      try {
        // Only the five basic-details fields are sent; the function updates nothing else.
        result = await (await userClient()).rpc("update_employee_details", {
          p_employee_id: employeeId, p_title: details.title, p_team: details.team, p_manager: details.manager,
          p_office: details.office, p_employment_type: details.employmentType,
        });
      } catch (cause) {
        throw new EmployeesUnavailableError({ cause });
      }
      if (result.error) throw detailsRefusal(result.error);
      if (typeof result.data !== "string") throw new EmployeesUnavailableError({ cause: "no employee name returned" });
      return { employeeId, name: result.data };
    },
    async listFor(session) {
      if (session.role === "manager") return listForManager(session);
      // One interviews and one training read for the whole list: everyone's for an admin, the caller's own for staff.
      const [rows, all, allTraining] = await Promise.all([
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
      ]);
      return rows.map(row => toEmployee(
        row, session.role === "admin", interviewsOf(all, row.employee_id), trainingOf(allTraining, row.employee_id),
      ));
    },
    async getFor(session, id) {
      if (session.role === "manager") return getForManager(session, id);
      if (session.role !== "admin" && id !== session.employeeId) return null;
      const row = await run<EmployeeRow>(t => t.select(columnsFor(session)).eq("employee_id", id).maybeSingle<EmployeeRow>());
      if (!row) return null;
      const [own, ownTraining] = await Promise.all([interviewsFor(session, id), trainingFor(session, id)]);
      return toEmployee(row, session.role === "admin", interviewsOf(own, id), trainingOf(ownTraining, id));
    },
    async isActive(session) {
      const row = await run<{ archived_at: string | null }>(t => t.select("archived_at").eq("employee_id", session.employeeId).maybeSingle<{ archived_at: string | null }>());
      return row !== null && !row.archived_at;
    },
  };
}

export const employeesStore: EmployeesStore = createEmployeesStore({
  userClient: getUserClient, interviews: interviewsStore, training: trainingStore,
});
