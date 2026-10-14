// Pure department rules (Story 4.1): name normalisation and comparison, and the hierarchy walker.
// No framework or database imports. departments-store is the load-bearing check; these are its helpers.

export type Department = { id: string; name: string; parentId: string | null };

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
export function ancestorIds(list: readonly Department[], id: string): string[] {
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
export function wouldCreateCycle(list: readonly Department[], id: string, parentId: string | null): boolean {
  if (parentId === null) return false;
  if (parentId === id) return true;
  return ancestorIds(list, parentId).includes(id);
}
