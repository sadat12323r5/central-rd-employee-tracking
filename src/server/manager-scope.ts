import type { SupabaseClient } from "@supabase/supabase-js";
import { DepartmentHierarchyError, managedDepartmentIds } from "@/domain/departments";
import type { ManagerIdentity } from "./session";
import { getUserClient } from "./supabase";

// Story 4.3: what a department manager may see. A department is in scope when the manager's account is
// on its authority chain (its own manager or an ancestor's), which is the authority rule (AD-4) read from
// the other end; the employees in scope are those whose department is in scope.
//
// The scope is computed fresh on each call (never from the session token, never cached across requests)
// through the per-request client carrying the manager's JWT, so the RLS policies of the manager-scope
// migration (manages_department / manages_employee) bound what is read. The walk is re-done here with the
// domain walker as the store-level layer (defence in depth, AD-1): the employees, training and
// attendance stores apply it. A failed read, or a loop in the stored hierarchy, throws
// ManagerScopeUnavailableError; callers map it to their own "unavailable" error, so a partial list is
// never shown. This module never uses the service role.

export type ManagerScopeSet = { departmentIds: Set<string>; employeeIds: Set<string> };

export interface ManagerScope {
  /** The departments and employees in the manager's subtree. Throws ManagerScopeUnavailableError. */
  forManager(session: ManagerIdentity): Promise<ManagerScopeSet>;
}

/** The manager's scope could not be worked out. Never treat this as "nothing in scope" or "everything". */
export class ManagerScopeUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The manager's department scope is temporarily unavailable.", options);
    this.name = "ManagerScopeUnavailableError";
  }
}

type Result<T> = { data: T | null; error: unknown };
type ScopeDepartmentRow = { id: string; parent_department_id: string | null; manager_user_id: string | null };

export type ManagerScopeClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

export function createManagerScope({ userClient }: ManagerScopeClients): ManagerScope {
  async function run<T>(table: string, query: (t: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(table));
    } catch (cause) {
      throw new ManagerScopeUnavailableError({ cause });
    }
    if (result.error) throw new ManagerScopeUnavailableError({ cause: result.error });
    if (result.data === null || result.data === undefined) throw new ManagerScopeUnavailableError({ cause: "no data returned" });
    return result.data;
  }

  return {
    async forManager(session) {
      const rows = await run<ScopeDepartmentRow[]>("departments", t => t.select("id,parent_department_id,manager_user_id")
        .returns<ScopeDepartmentRow[]>());
      let departmentIds: string[];
      try {
        departmentIds = managedDepartmentIds(
          rows.map(r => ({ id: r.id, parentId: r.parent_department_id ?? null, managerUserId: r.manager_user_id ?? null })),
          session.userId,
        );
      } catch (cause) {
        if (cause instanceof DepartmentHierarchyError) throw new ManagerScopeUnavailableError({ cause });
        throw cause;
      }
      // No department (e.g. the manager was just unassigned): an empty scope, never everything.
      if (departmentIds.length === 0) return { departmentIds: new Set(), employeeIds: new Set() };
      const employees = await run<{ employee_id: string; department_id: string | null }[]>("employees", t => t
        .select("employee_id,department_id").in("department_id", departmentIds)
        .returns<{ employee_id: string; department_id: string | null }[]>());
      const inScope = new Set(departmentIds);
      return {
        departmentIds: inScope,
        // Defence in depth: only rows whose department really is in scope.
        employeeIds: new Set(employees.filter(e => e.department_id !== null && inScope.has(e.department_id)).map(e => e.employee_id)),
      };
    },
  };
}

export const managerScope: ManagerScope = createManagerScope({ userClient: getUserClient });
