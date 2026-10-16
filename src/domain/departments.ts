// Pure department rules (Story 4.1): name normalisation and comparison, and the hierarchy walker.
// Story 4.2 adds the authority chain (the managers over a department) built on the same walker, and
// Story 4.3 the managed departments (the chain read from the other end).
// No framework or database imports. departments-store is the load-bearing check; these are its helpers.

export type Department = {
  id: string; name: string; parentId: string | null;
  /** Story 4.2: the manager's sign-in account (auth user id), or null when the department has no manager. */
  managerUserId: string | null;
  /** The Employee ID linked to that account, or null (no manager, or an account with no employee row, e.g. an Administrator). */
  managerEmployeeId: string | null;
};

/** The hierarchy fields the walkers need. */
type Node = Pick<Department, "id" | "parentId">;

export const DEPARTMENT_NAME_MAX = 100;

/** Trims and collapses inner whitespace, so "  Central   R&D " becomes "Central R&D". */
export function normalizeDepartmentName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Department names are unique case-insensitively, after normalisation. */
export function sameDepartmentName(a: string, b: string): boolean {
  return normalizeDepartmentName(a).toLowerCase() === normalizeDepartmentName(b).toLowerCase();
}

/** The stored hierarchy already contains a loop (or an id twice); walking it would never end. */
export class DepartmentHierarchyError extends Error {
  constructor(id: string) {
    super(`The department hierarchy loops at ${id}.`);
    this.name = "DepartmentHierarchyError";
  }
}

/**
 * The ancestors of `id`, nearest first (parent, grandparent, ...). Unknown ids end the walk. A loop in
 * the stored list throws DepartmentHierarchyError instead of looping forever.
 */
export function ancestorIds(list: readonly Node[], id: string): string[] {
  const byId = new Map(list.map(d => [d.id, d]));
  const seen = new Set<string>([id]);
  const ancestors: string[] = [];
  let current = byId.get(id)?.parentId ?? null;
  while (current !== null) {
    if (seen.has(current)) throw new DepartmentHierarchyError(current);
    seen.add(current);
    ancestors.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return ancestors;
}

/**
 * True when placing department `id` under `parentId` would make it its own parent or ancestor.
 * A null parent (top level) never creates a cycle.
 */
export function wouldCreateCycle(list: readonly Node[], id: string, parentId: string | null): boolean {
  if (parentId === null) return false;
  if (parentId === id) return true;
  return ancestorIds(list, parentId).includes(id);
}

/**
 * The manager user ids with authority over `departmentId`, nearest first: the department's own manager,
 * then each ancestor's manager. Unmanaged departments are skipped and a manager appears once (at their
 * nearest position). A loop in the list throws DepartmentHierarchyError (from ancestorIds). Computed
 * from the list it is given, never cached: callers pass a fresh read.
 */
export function authorityChain(list: readonly Pick<Department, "id" | "parentId" | "managerUserId">[], departmentId: string): string[] {
  const byId = new Map(list.map(d => [d.id, d]));
  const chain: string[] = [];
  for (const id of [departmentId, ...ancestorIds(list, departmentId)]) {
    const manager = byId.get(id)?.managerUserId ?? null;
    if (manager !== null && !chain.includes(manager)) chain.push(manager);
  }
  return chain;
}

/** Who is asking: the session role and the auth user id behind it. */
export type DepartmentActor = { role: "admin" | "manager" | "staff"; userId: string };

/**
 * True when the actor has authority over `departmentId`: an Administrator always does; a manager only
 * when their user id is in the department's authority chain (its own or an ancestor's manager). Staff
 * never do, even if their user id is in the chain (e.g. a manager downgraded after a failed check).
 */
export function hasDepartmentAuthority(
  actor: DepartmentActor, list: readonly Pick<Department, "id" | "parentId" | "managerUserId">[], departmentId: string,
): boolean {
  if (actor.role === "admin") return true;
  if (actor.role !== "manager") return false;
  return authorityChain(list, departmentId).includes(actor.userId);
}

/**
 * Story 4.3: the ids of every department whose authority chain includes `userId` (the departments the
 * user manages, directly or through an ancestor), in list order. This is the authority rule read from
 * the other end, so a manager's scope and their write authority cannot disagree. Ancestors missing from
 * the list end the walk; a loop in the list throws DepartmentHierarchyError (from ancestorIds).
 */
export function managedDepartmentIds(
  list: readonly Pick<Department, "id" | "parentId" | "managerUserId">[], userId: string,
): string[] {
  return list.filter(d => authorityChain(list, d.id).includes(userId)).map(d => d.id);
}
