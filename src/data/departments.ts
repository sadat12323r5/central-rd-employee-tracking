import type { Department } from "@/domain/departments";

// Seed departments (Story 4.1, AD-5): L&D at the top level (the managing department) and Central R&D
// under it. Fixed ids, so `npm run db:seed` inserts them once and never duplicates or overwrites them.
// Every fixture employee is placed in Central R&D: the workspace tracks Central R&D staff.
// Managers (Story 4.2) are not part of these rows: the seed sets L&D's manager in a separate step.

export const LND_DEPARTMENT_ID = "de9a0000-0000-4000-8000-000000000001";
export const CENTRAL_RD_DEPARTMENT_ID = "de9a0000-0000-4000-8000-000000000002";

/**
 * The department whose manager the seed sets to the Administrator account (Story 4.2, only while it has
 * none). Central R&D gets no manager, so its authority resolves to L&D's manager.
 */
export const ADMIN_MANAGED_DEPARTMENT_ID = LND_DEPARTMENT_ID;

/** The department the seed gives every fixture employee that has none yet. */
export const DEFAULT_EMPLOYEE_DEPARTMENT_ID = CENTRAL_RD_DEPARTMENT_ID;

/** Parents before children, so inserting in this order satisfies the parent foreign key. */
export const seedDepartments: readonly Department[] = [
  { id: LND_DEPARTMENT_ID, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
  { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parentId: LND_DEPARTMENT_ID, managerUserId: null, managerEmployeeId: null },
];

/** The `departments` rows `npm run db:seed` inserts (insert-only: existing rows are left unchanged). */
export function departmentSeedRows() {
  return seedDepartments.map(d => ({ id: d.id, name: d.name, parent_department_id: d.parentId }));
}

/** The auth-user fields the seed needs to pick L&D's manager. */
export type SeedAuthUser = { id: string; email?: string | null; created_at: string; app_metadata?: Record<string, unknown> | null };

/**
 * The Administrator account the seed makes L&D's manager (Story 4.2), or null when there is none. Only
 * ever an `app_metadata.role === "admin"` user: the admin whose email matches `email` (case-insensitive)
 * when given, else the earliest-created admin. An email naming a non-admin is never used.
 */
export function pickSeedAdministrator(users: readonly SeedAuthUser[], email?: string | null): SeedAuthUser | null {
  const admins = users.filter(u => u.app_metadata?.role === "admin");
  const wanted = email?.trim().toLowerCase();
  if (wanted) {
    const match = admins.find(u => u.email?.toLowerCase() === wanted);
    if (match) return match;
  }
  return admins.reduce<SeedAuthUser | null>((earliest, u) => (earliest === null || u.created_at < earliest.created_at ? u : earliest), null);
}
