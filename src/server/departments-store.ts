import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEPARTMENT_NAME_MAX, DepartmentHierarchyError, normalizeDepartmentName, sameDepartmentName, wouldCreateCycle, type Department,
} from "@/domain/departments";
import type { SessionIdentity } from "./session";
import { getUserClient } from "./supabase";

// The only way the app reads and writes departments (Story 4.1). Departments live in the Supabase
// `departments` table.
//
// Administrator only: every method refuses any other session before a query, and every query goes
// through a per-request client carrying the signed-in user's JWT, so the RLS policies (admin select,
// insert, update; no delete) are enforced too. This module never uses the service role.
//
// This store is the load-bearing check for the department rules: names are normalised and unique
// case-insensitively (the DB unique index on lower(name) is the backstop, its 23505 maps to the same
// error), a parent must be an existing department, and a department may never become its own parent or
// ancestor (the DB trigger `departments_prevent_cycle` is the backstop, mapped to the same error).
// There is no delete path.
//
// Story 4.2 adds department managers: `setManager` (Administrator only) points a department at an
// employee's existing, non-archived sign-in account (or clears it), and `managesAny` is the per-request
// check auth.ts uses to derive the `manager` role (RLS: a user reads only the departments they manage).
// Assigning a manager never creates an account.
export type { Department } from "@/domain/departments";

/** What the Administrator sends when adding or changing a department. `parentId` null = top level. */
export type DepartmentInput = { name: string; parentId: string | null };

export interface DepartmentsStore {
  /** Every department, by name. Administrators only. */
  list(session: SessionIdentity): Promise<Department[]>;
  /** Adds a department. Administrators only. */
  create(session: SessionIdentity, input: DepartmentInput): Promise<Department>;
  /** Renames and/or re-parents a department. Administrators only. */
  update(session: SessionIdentity, id: string, input: DepartmentInput): Promise<Department>;
  /**
   * Sets the department's manager to the sign-in account linked to `employeeId`, or removes the manager
   * when `employeeId` is null. Administrators only. The employee must already have a linked, non-archived
   * account; this never creates one.
   */
  setManager(session: SessionIdentity, departmentId: string, employeeId: string | null): Promise<Department>;
  /**
   * True when the auth user manages at least one department (read through that user's own JWT, so RLS
   * limits it to the departments they manage). Throws DepartmentsUnavailableError on a read error.
   */
  managesAny(userId: string): Promise<boolean>;
}

/** The departments database is unreachable or refused the query. Never treat this as "no departments" or "saved". */
export class DepartmentsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Departments are temporarily unavailable.", options);
    this.name = "DepartmentsUnavailableError";
  }
}

/** Only an Administrator can read or manage departments. */
export class DepartmentsForbiddenError extends Error {
  constructor() {
    super("Only an Administrator can manage departments.");
    this.name = "DepartmentsForbiddenError";
  }
}

/** Another department already has this name (case-insensitively). */
export class DepartmentNameTakenError extends Error {
  constructor() {
    super("A department with that name already exists.");
    this.name = "DepartmentNameTakenError";
  }
}

/** The name is empty or longer than 100 characters after normalisation. */
export class DepartmentNameInvalidError extends Error {
  constructor() {
    super(`Enter a department name of 1 to ${DEPARTMENT_NAME_MAX} characters.`);
    this.name = "DepartmentNameInvalidError";
  }
}

/** The change would make a department its own parent or ancestor. */
export class DepartmentCycleError extends Error {
  constructor() {
    super("A department can't be placed under itself or one of its own sub-departments.");
    this.name = "DepartmentCycleError";
  }
}

/** The department (or the chosen parent) is not in the list. */
export class DepartmentNotFoundError extends Error {
  constructor() {
    super("Choose an existing department.");
    this.name = "DepartmentNotFoundError";
  }
}

/** The chosen manager is not an existing employee. */
export class ManagerEmployeeNotFoundError extends Error {
  constructor() {
    super("Choose an existing department and employee.");
    this.name = "ManagerEmployeeNotFoundError";
  }
}

/** The chosen manager has no linked sign-in account: provision one first (never created here). */
export class ManagerHasNoAccountError extends Error {
  constructor(readonly employeeName: string) {
    super(`${employeeName} has no sign-in account yet. Provision their account first, then make them a manager.`);
    this.name = "ManagerHasNoAccountError";
  }
}

/** The chosen manager's account is archived. */
export class ManagerArchivedError extends Error {
  constructor(readonly employeeName: string) {
    super(`${employeeName}'s account is archived. Restore it first.`);
    this.name = "ManagerArchivedError";
  }
}

export type DepartmentRow = { id: string; name: string; parent_department_id: string | null; manager_user_id?: string | null };

const TABLE = "departments";
const COLUMNS = "id,name,parent_department_id,manager_user_id";

type ManagerCandidateRow = { employee_id: string; name: string; auth_user_id: string | null; archived_at: string | null };
type LinkedEmployeeRow = { employee_id: string; auth_user_id: string };

/** `managerEmployeeId` is the Employee ID linked to the manager account, resolved by the caller (null when none). */
export function toDepartment(row: DepartmentRow, managerEmployeeId: string | null = null): Department {
  const managerUserId = row.manager_user_id ?? null;
  return {
    id: row.id, name: row.name, parentId: row.parent_department_id ?? null,
    managerUserId, managerEmployeeId: managerUserId === null ? null : managerEmployeeId,
  };
}

type DbError = { code?: string; message?: string; details?: string };
type Result<T> = { data: T | null; error: DbError | null };

/** Maps a database refusal to the store's typed errors; anything unrecognised is "unavailable". */
function refusal(error: DbError): Error {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "23505") return new DepartmentNameTakenError();
  if (error.code === "23514" && /department_cycle|departments_not_own_parent/.test(text)) return new DepartmentCycleError();
  if (error.code === "23503") return new DepartmentNotFoundError();
  return new DepartmentsUnavailableError({ cause: error });
}

export type DepartmentsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createDepartmentsStore({ userClient }: DepartmentsStoreClients): DepartmentsStore {
  type Query<T> = (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>;

  /** Runs a query whose "no row" is a legitimate answer (maybeSingle): null means not found. */
  async function runMaybe<T>(query: Query<T>, table = TABLE): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(table));
    } catch (cause) {
      throw new DepartmentsUnavailableError({ cause });
    }
    if (result.error) throw refusal(result.error);
    return result.data ?? null;
  }

  async function run<T>(query: Query<T>, table = TABLE): Promise<T> {
    const data = await runMaybe(query, table);
    if (data === null) throw new DepartmentsUnavailableError({ cause: "no data returned" });
    return data;
  }

  function requireAdmin(session: SessionIdentity) {
    if (session?.role !== "admin") throw new DepartmentsForbiddenError();
  }

  /** Employee IDs linked to the given auth user ids (Administrator read of employees, RLS enforced). */
  async function employeeIdsFor(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = await run<LinkedEmployeeRow[]>(t => t.select("employee_id,auth_user_id").in("auth_user_id", ids)
      .returns<LinkedEmployeeRow[]>(), "employees");
    return new Map(rows.map(r => [r.auth_user_id, r.employee_id]));
  }

  async function withManagers(rows: DepartmentRow[]): Promise<Department[]> {
    const linked = await employeeIdsFor(rows.flatMap(r => (r.manager_user_id ? [r.manager_user_id] : [])));
    return rows.map(r => toDepartment(r, r.manager_user_id ? linked.get(r.manager_user_id) ?? null : null));
  }

  /**
   * The saved department after a committed write. The write already succeeded, so a failed follow-up
   * lookup of the manager's Employee ID is logged and reported as unknown (null), never as "not saved".
   */
  async function afterWrite(saved: DepartmentRow): Promise<Department> {
    try {
      return (await withManagers([saved]))[0];
    } catch (error) {
      if (!(error instanceof DepartmentsUnavailableError)) throw error;
      console.error("Department saved, but its manager's Employee ID could not be read.", error, { cause: error.cause });
      return toDepartment(saved, null);
    }
  }

  async function readAll(): Promise<Department[]> {
    const rows = await run<DepartmentRow[]>(t => t.select(COLUMNS).order("name").order("id").returns<DepartmentRow[]>());
    return withManagers(rows);
  }

  /** The store-level rules shared by create and update. `id` is undefined for a new department. */
  function checked(all: Department[], id: string | undefined, input: DepartmentInput): DepartmentInput {
    const name = normalizeDepartmentName(input.name);
    if (name.length < 1 || name.length > DEPARTMENT_NAME_MAX) throw new DepartmentNameInvalidError();
    const parentId = input.parentId ?? null;
    if (id !== undefined && parentId === id) throw new DepartmentCycleError();
    if (parentId !== null && !all.some(d => d.id === parentId)) throw new DepartmentNotFoundError();
    if (all.some(d => d.id !== id && sameDepartmentName(d.name, name))) throw new DepartmentNameTakenError();
    if (id !== undefined) {
      try {
        if (wouldCreateCycle(all, id, parentId)) throw new DepartmentCycleError();
      } catch (error) {
        // A loop already in the stored list: refuse rather than make it worse.
        if (error instanceof DepartmentHierarchyError) throw new DepartmentCycleError();
        throw error;
      }
    }
    return { name, parentId };
  }

  return {
    async list(session) {
      requireAdmin(session);
      return readAll();
    },
    async create(session, input) {
      requireAdmin(session);
      const values = checked(await readAll(), undefined, input);
      const saved = await run<DepartmentRow>(t => t.insert({ name: values.name, parent_department_id: values.parentId })
        .select(COLUMNS).single<DepartmentRow>());
      return toDepartment(saved);
    },
    async update(session, id, input) {
      requireAdmin(session);
      const all = await readAll();
      if (!all.some(d => d.id === id)) throw new DepartmentNotFoundError();
      const values = checked(all, id, input);
      const saved = await runMaybe<DepartmentRow>(t => t.update({ name: values.name, parent_department_id: values.parentId })
        .eq("id", id).select(COLUMNS).maybeSingle<DepartmentRow>());
      if (!saved) throw new DepartmentNotFoundError();
      return afterWrite(saved);
    },
    async setManager(session, departmentId, employeeId) {
      requireAdmin(session);
      const all = await readAll();
      if (!all.some(d => d.id === departmentId)) throw new DepartmentNotFoundError();
      let managerUserId: string | null = null;
      if (employeeId !== null) {
        const employee = await runMaybe<ManagerCandidateRow>(t => t.select("employee_id,name,auth_user_id,archived_at")
          .eq("employee_id", employeeId).maybeSingle<ManagerCandidateRow>(), "employees");
        if (!employee) throw new ManagerEmployeeNotFoundError();
        // Archived first: an archived employee is told to restore, whether or not they have an account.
        if (employee.archived_at) throw new ManagerArchivedError(employee.name);
        if (!employee.auth_user_id) throw new ManagerHasNoAccountError(employee.name);
        managerUserId = employee.auth_user_id;
      }
      const saved = await runMaybe<DepartmentRow>(t => t.update({ manager_user_id: managerUserId })
        .eq("id", departmentId).select(COLUMNS).maybeSingle<DepartmentRow>());
      if (!saved) throw new DepartmentNotFoundError();
      return toDepartment(saved, employeeId);
    },
    async managesAny(userId) {
      const rows = await run<{ id: string }[]>(t => t.select("id").eq("manager_user_id", userId).limit(1).returns<{ id: string }[]>());
      return rows.length > 0;
    },
  };
}

export const departmentsStore: DepartmentsStore = createDepartmentsStore({ userClient: getUserClient });
