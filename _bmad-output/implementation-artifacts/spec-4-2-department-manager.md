---
title: 'Story 4.2: Administrator assigns a department manager'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '0e21739babcdd2acf617dbf772e774d42a17ae6f'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-department-list.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Departments exist (Story 4.1) but nobody manages them, and sessions know only `admin` and `staff`, so a team lead cannot get a management view without org-wide Administrator access.

**Approach:** Add an optional manager account to each department (`departments.manager_user_id`), an Administrator-only "set manager" path (store + action + UI) that requires an existing sign-in account, derive a `manager` session role fresh on every request for staff accounts that manage at least one department, route manager sessions to the management portal, add the pure authority-chain resolver in `src/domain/departments.ts`, and seed L&D's manager as the Administrator.

## Boundaries & Constraints

**Always:**
- Migration `supabase/migrations/20261014010000_department_managers.sql` is ADDITIVE: new nullable column `departments.manager_user_id uuid references auth.users(id) on delete set null`, its index, and a new select policy letting an authenticated user read the departments they manage (`manager_user_id = (select auth.uid())`). Nothing existing is altered or tightened.
- Role precedence: `app_metadata.role = 'admin'` is always `admin` (never downgraded, even when it manages a department). Only a valid staff identity whose auth user manages ≥1 department becomes `{ role: "manager", employeeId }`. Derived in `auth.ts` on every request (after the existing session-window and archived checks), never stored in the token or cached.
- If the manages-check read fails, the session is the plain `staff` identity (the less-privileged role) and the error is logged; never grant `manager` on an error.
- Setting a manager: Administrator only (action checks `session.role === "admin"` first; store re-checks). The chosen person is an employee (by Employee ID) who must already have a linked, non-archived sign-in account; it never creates an account. "No manager" removes the manager. Department must exist.
- Department add/rename/re-parent and set-manager stay Administrator-only; a manager session is rejected at the server exactly like Staff.
- Manager sessions never read interviews through the management portal: `interviews-store.listFor` returns `[]` for a manager session without querying; add/update/withdraw stay staff-only.
- `src/domain/departments.ts` gains pure `authorityChain(list, departmentId)` (manager user ids of the department then each ancestor, nearest first, skipping unmanaged, no duplicates; uses the visited-set guard so a looping list throws `DepartmentHierarchyError`) and `hasDepartmentAuthority(actor, list, departmentId)` (`admin` → always true; otherwise the actor's user id is in the chain).
- Seed (`scripts/seed-employees.ts`) sets L&D's manager to the Administrator only when L&D has no manager: the auth user whose email equals `SEED_ADMIN_EMAIL` when set, else the earliest-created user with `app_metadata.role = 'admin'`; if none exists it logs a warning to run `npm run db:seed-admin` first and continues. Central R&D gets no manager.

**Never:**
- No manager scoping of directory/profile/training/attendance (Story 4.3: a manager sees what the non-admin read paths already return, i.e. their own record); no "My record" area (4.10); no assignments.
- No change to session lengths: the 8 h / 12 h window stays decided by the account's `app_metadata` role (a manager's account is a staff account → 12 h).
- No account creation as a side effect; no service-role use at runtime for this story.
- No delete paths.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Assign | admin; dept exists; employee has active account | saved; that account's next request is `manager` and renders the management portal | "Manager updated." |
| No account | employee without linked account | rejected, nothing saved | "<Name> has no sign-in account yet. Provision their account first, then make them a manager." |
| Archived account | employee archived | rejected | "<Name>'s account is archived. Restore it first." |
| Remove | manager = "none" | manager cleared; if that account manages nothing else its next request is `staff` | "Manager removed." |
| Unknown | unknown department or employee | rejected | "Choose an existing department and employee." |
| Bad input | non-uuid department, malformed employee id, missing choice | rejected before store | field message |
| Non-admin | staff or manager session calls set-manager / add / rename / re-parent | rejected at server, store not called | "Only an Administrator can manage departments." |
| Admin manages | admin account is L&D manager | session `admin` | none |
| Manages-check fails | departments read error for a staff account | session `staff`, error logged | none |
| Loop in data | `authorityChain` over a looping list | throws `DepartmentHierarchyError` | no infinite loop |

</intent-contract>

## Code Map

- `src/server/session.ts` -- `SessionIdentity` union; add `{ role: "manager"; employeeId: string }`; `sessionHours` must treat manager like staff (12 h).
- `src/server/auth.ts` -- `identityFor` (metadata → identity), `supabaseSession` (window + `employeesStore.isActive` for staff; derive manager after these using the validated user id). `getActor` returns `{ identity, userId }`.
- `src/server/departments-store.ts` -- from Story 4.1: `createDepartmentsStore({ userClient })`, typed errors, `refusal` mapping, `checked()`. Add `setManager(session, departmentId, employeeId | null)` and `managesAny(userId)`; `list` (admin) also returns `managerUserId` and `managerEmployeeId` (resolved via an admin read of `employees.employee_id, auth_user_id` for the manager ids).
- `src/server/department-actions.ts` -- 4.1 actions; add `setDepartmentManagerAction` (fields `id`, `manager` = Employee ID or `none`).
- `src/domain/departments.ts` -- `Department` type (add `managerUserId`, `managerEmployeeId`, both `string | null`), `ancestorIds` with guard: build `authorityChain` / `hasDepartmentAuthority` on it.
- `src/server/interviews-store.ts:146` -- `listFor`; manager → `[]`.
- `src/server/employees-store.ts` -- non-admin paths already scope to `session.employeeId`; manager must take those paths (no admin columns).
- `src/app/page.tsx` -- staff branch → staff portal; admin branch loads departments; add manager branch → `Portal` with `role="manager"`, no departments read.
- `src/components/portal.tsx` -- add `role: "admin" | "manager"` prop (default admin). For manager hide: Departments and Interviews & placements nav sections, the profile Interviews tab, the interview overview stat, and the account panels (`StaffAccountPanel`, `AccountAccessPanel`); sidebar identity text says "Department manager".
- `src/components/departments-panel.tsx` -- per-row manager display ("No manager", employee name, or "Administrator account") and a manager form: select with "Choose…" (empty, invalid), "No manager" (`none`), and every non-archived employee (label notes "no account" when `hasAccount` is false); needs `employees` prop.
- `scripts/seed-employees.ts`, `src/data/departments.ts` -- 4.1 seed; add the L&D manager step after the departments insert.
- `tests/departments-rls.test.ts`, `tests/e2e/departments.spec.ts`, `tests/e2e/global-setup.ts` -- live-test patterns (one sign-in per user per file; throwaway rows; service-role cleanup; bulk inserts with `{ defaultToNull: false }`).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261014010000_department_managers.sql` -- column, index, `departments_select_managed` policy -- ADDITIVE.
- `src/domain/departments.ts` + `tests/departments.test.ts` -- `authorityChain`, `hasDepartmentAuthority`, Department manager fields.
- `src/server/session.ts`, `src/server/auth.ts` + `tests/session.test.ts`, `tests/auth.test.ts` -- manager role derivation and precedence, failure → staff.
- `src/server/departments-store.ts`, `src/server/department-actions.ts` + their tests -- set manager, `managesAny`, list with manager fields; manager sessions rejected everywhere.
- `src/server/interviews-store.ts` + test -- manager → `[]`.
- `src/app/page.tsx`, `src/components/portal.tsx`, `src/components/departments-panel.tsx` + `tests/page.test.tsx`, `tests/components/portal.test.tsx`, `tests/components/departments-panel.test.tsx` -- manager routing, hidden sections, manager form.
- `scripts/seed-employees.ts`, `docs/DEPLOYMENT.md` -- L&D manager seed step and run order (`db:seed-admin` before `db:seed`).
- `tests/departments-rls.test.ts` -- a staff user reads only departments it manages; cannot update `manager_user_id`; admin can set/clear it.
- `tests/e2e/departments.spec.ts` (or `department-manager.spec.ts`) -- admin assigns a throwaway Staff account as manager of a throwaway department, that user's next sign-in reaches the management portal (no Interviews nav); admin removes it and the user's next request shows the staff portal; an employee without an account is refused with the provision-first message.

**Acceptance Criteria:**
- Given the seed has run after `db:seed-admin`, when the Administrator opens Departments, then L&D shows the Administrator account as manager and Central R&D shows "No manager".
- Given a manager session, when it requests the page, then it sees the management portal without Departments, Interviews & placements, the Interviews tab or account controls.
- Given any department-scoped permission check, when `hasDepartmentAuthority` runs, then it walks `authorityChain` fresh and an Administrator always has authority.

## Spec Change Log

## Review Triage Log

## Design Notes

The manager reference is an auth user id, not an Employee ID, because the seeded L&D manager is the Administrator account, which has no employee row. The UI picks people by Employee ID and the store resolves the linked account, which is what makes "no account → provision first" observable. Deriving `manager` only from staff identities makes the admin precedence structural. Falling back to `staff` when the manages-check read fails is fail-closed for manager powers and keeps Staff working; the existing archived check stays fail-closed for access. Session length follows the account's `app_metadata` role, so no new session-length decision is introduced.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests needing the 4.1/4.2 migrations, failing only with schema-missing errors (42P01/42703/PGRST204/PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` (here: Chromium via `launchOptions.executablePath: "/opt/pw-browsers/chromium"`) -- expected: pass, or fail only with schema-missing errors until the migrations are applied
