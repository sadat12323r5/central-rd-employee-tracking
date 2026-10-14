import type { Department } from "@/domain/departments";

// Seed departments (Story 4.1, AD-5): L&D at the top level (the managing department) and Central R&D
// under it. Fixed ids, so `npm run db:seed` inserts them once and never duplicates or overwrites them.
// Every fixture employee is placed in Central R&D: the workspace tracks Central R&D staff.

export const LND_DEPARTMENT_ID = "de9a0000-0000-4000-8000-000000000001";
export const CENTRAL_RD_DEPARTMENT_ID = "de9a0000-0000-4000-8000-000000000002";

/** The department the seed gives every fixture employee that has none yet. */
export const DEFAULT_EMPLOYEE_DEPARTMENT_ID = CENTRAL_RD_DEPARTMENT_ID;

/** Parents before children, so inserting in this order satisfies the parent foreign key. */
export const seedDepartments: readonly Department[] = [
  { id: LND_DEPARTMENT_ID, name: "L&D", parentId: null },
  { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parentId: LND_DEPARTMENT_ID },
];

/** The `departments` rows `npm run db:seed` inserts (insert-only: existing rows are left unchanged). */
export function departmentSeedRows() {
  return seedDepartments.map(d => ({ id: d.id, name: d.name, parent_department_id: d.parentId }));
}
