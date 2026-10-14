---
title: 'Story 4.3: Managers see only their own department'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: 'aae50655b29136d8ad357c6785372b0bf8b3a29b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-department-manager.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A manager session (Story 4.2) reaches the management portal but sees only its own record, through the Staff read paths. Managers need their team: everyone in the departments they manage and those departments' sub-departments, and nothing outside that.

**Approach:** Define a manager's scope as the departments whose authority chain contains the manager's account, plus the employees in them. Enforce it twice. At the database, new RLS select policies backed by SECURITY DEFINER helper functions that walk up the department tree. At the store, a shared `manager-scope` helper computes the scope fresh on each request using the domain walker, and the employees, training and attendance stores apply it. The portal then shows the scoped directory, profiles, L&D, attendance and CSV export, with department names.

## Boundaries & Constraints

**Always:**
- **Migration.** `supabase/migrations/20261014020000_manager_scope.sql` is ADDITIVE: two new functions and new select-only policies. No existing policy, column or function is altered.
  - `public.manages_department(dept uuid)` and `public.manages_employee(emp text)` are `stable`, `security definer`, with `set search_path = ''` and fully qualified names. Execute is revoked from `public` and granted to `authenticated`.
  - Each function walks up from the department through `parent_department_id` with a recursive CTE using `UNION`, so a loop in the data still terminates. It returns true when any department on the chain has `manager_user_id = auth.uid()`.
  - New select policies:
    - `departments_select_managed_subtree` (`manages_department(id)`);
    - `employees_select_managed`, `attendance_select_managed`, `training_history_select_managed` and `lms_stub_enrolments_select_managed` (each `manages_employee(employee_id)`).
  - No insert, update or delete policies are added.
- **Session.** The manager identity becomes `{ role: "manager"; employeeId; userId }`. `userId` is the validated auth user id that `auth.ts` already has.
- **Store-side scope.** New `src/server/manager-scope.ts`, `createManagerScope({ userClient })`:
  - `forManager(session)` returns `{ departmentIds: Set<string>; employeeIds: Set<string> }`.
  - It reads the visible departments (`id, parent_department_id, manager_user_id`), then keeps the departments `managedDepartmentIds(list, session.userId)` returns.
  - `managedDepartmentIds` is new in `src/domain/departments.ts`: every department whose `authorityChain` includes the user id. It is built on the existing loop-guarded walker.
  - It then reads `employees.employee_id` where `department_id` is in those departments.
  - A read failure throws `ManagerScopeUnavailableError`. Each store maps that to its own `…UnavailableError`, so a partial list is never shown.
- **Manager reads at the store.** Admin and Staff behaviour is unchanged byte-for-byte.
  - **employees-store:**
    - `listFor(manager)` returns only in-scope employees, including archived ones flagged `archived`. The manager columns are the base columns plus `department_id` and `archived_at`, never `auth_user_id`.
    - `getFor(manager, id)` returns `null` for an id outside the scope, without querying the employee.
    - Interviews stay `[]` for managers.
  - **training-store:**
    - `listFor(manager, id?)` returns `[]` for an out-of-scope id, and otherwise only rows of in-scope employees.
    - `currentFor(manager, ids)` drops out-of-scope ids before calling the LMS.
  - **attendance-store:** add `listFor(session, employeeId)`. Admin can read any employee; Staff only their own; a manager only an in-scope id, and an out-of-scope id gives `[]` without a query. The page's Staff branch uses it. The `listForEmployee`/`listAll` used by attendance-actions are unchanged.
- **Portal for managers.**
  - The directory, profile, Learning & development, Attendance & leave and CSV export all come from the scoped employee list.
  - Department names come from a new `departmentsStore.listFor(session)`: admin gets all departments, a manager gets the in-scope ones.
  - The overview's "Across 5 specialist teams" note becomes a neutral count for managers.
- **Tests.** Live DB tests sign each test user in once per file, and bulk inserts pass `{ defaultToNull: false }`.

**Never:**
- No manager writes of any kind: no assignments (Story 4.5), no archiving (4.9), no "My record" (4.10).
- No interviews for managers, at any layer.
- No change to what Staff or Administrator sessions can read.
- Never compute scope from the session token or cache it across requests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Subtree | Manager of L&D (L&D > Central R&D) | Sees L&D and Central R&D employees | — |
| Child only | Manager of Central R&D | Sees Central R&D employees only, not L&D's | — |
| Direct profile | Central R&D manager calls `getFor(L&D employee)` | `null`, page shows nothing for it | — |
| Direct training/attendance | Manager asks for an out-of-scope id | `[]`, no table query | — |
| RLS | Manager JWT selects employees, attendance, training or enrolments outside the subtree | 0 rows. Inside the subtree, rows are returned | — |
| No departments | Manager whose department was just unassigned (race) | Empty scope gives an empty list, never everything | — |
| Loop in data | Departments form a cycle | SQL helper terminates. Domain walker throws `DepartmentHierarchyError` | Store maps it to unavailable |
| Scope read fails | Departments or employees read errors | Store's own unavailable error, no partial list | Existing "unavailable" page |
| Admin and Staff | Any read | Identical to before this story | — |

</intent-contract>

## Code Map

- `src/server/session.ts`, `src/server/auth.ts:95-104`: manager identity built here; add `userId`.
- `src/domain/departments.ts`: `ancestorIds`, `authorityChain`, `hasDepartmentAuthority` (4.2). Add `managedDepartmentIds`.
- `src/server/departments-store.ts`: `runMaybe`/`run`, typed errors, `list` (admin only). Add `listFor(session)`: admin delegates to `list`; a manager gets the scope's departments with manager fields resolved as far as RLS allows.
- `src/server/employees-store.ts:145-170`: the `columnsFor` and admin/staff branches; add a manager branch through an injected `scope` dependency (default: the real manager-scope).
- `src/server/training-store.ts:136-160`: `listFor`/`currentFor` staff filters; add manager branches via an injected scope.
- `src/server/attendance-store.ts`: role-agnostic; add session-aware `listFor`.
- `src/server/lms-client.ts`: reads `lms_stub_enrolments` with the user client (needs the new policy).
- `src/app/page.tsx`: manager branch (4.2). Pass `departments` from `departmentsStore.listFor`. The staff branch uses `attendanceStore.listFor`.
- `src/components/portal.tsx`: `departmentName` lookup, Overview stat notes, the `role` prop from 4.2.
- `supabase/migrations/20261014010000_department_managers.sql`, `20261008000000_archive_and_audit.sql`: SQL style for comments, policies and functions.
- `tests/departments-rls.test.ts`, `tests/attendance-rls.test.ts`, `tests/training-rls.test.ts`, `tests/lms-rls.test.ts`: live-test patterns.
- `tests/e2e/department-manager.spec.ts`, `tests/e2e/global-setup.ts`: manager e2e setup (4.2).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261014020000_manager_scope.sql`: functions and policies (ADDITIVE).
- `src/domain/departments.ts` + `tests/departments.test.ts`: `managedDepartmentIds`.
- `src/server/session.ts`, `src/server/auth.ts` + tests: manager `userId`.
- `src/server/manager-scope.ts` + `tests/manager-scope.test.ts`: scope helper and error.
- `src/server/employees-store.ts`, `src/server/training-store.ts`, `src/server/attendance-store.ts`, `src/server/departments-store.ts` + their tests: manager branches. Admin and Staff regression tests stay green.
- `src/app/page.tsx`, `src/components/portal.tsx` + tests: scoped data and department names for managers.
- `tests/manager-scope-rls.test.ts` (new, live): a throwaway parent and child department, an employee in each, attendance, training and LMS rows, and Staff accounts made manager of the parent and of the child. Assert the subtree rows are visible and the outside rows return 0. Unmanaged Staff and Admin results are unchanged. Clean up through the service role.
- `tests/e2e/department-manager.spec.ts`: a manager of a throwaway department sees only that department's throwaway employees in the directory, with their department name, and not the seeded demo employees.

**Acceptance Criteria:**
- Given a manager session, when they open the directory, a profile, Learning & development, Attendance & leave, or export the CSV, then only employees in their department subtree appear.
- Given the Administrator, when they use the same views, then they still see every employee.

## Spec Change Log

## Review Triage Log

## Design Notes

Scope runs downward: a department is in scope when the manager is on its authority chain. That is the same rule as AD-4's authority set, read from the other end, so scope and later write checks cannot disagree. The SQL helpers are SECURITY DEFINER because a manager must not be able to read the department and employee rows the walk passes through. They expose only a boolean about `auth.uid()`. `UNION` in the recursive CTE de-duplicates rows, so a cyclic parent chain still terminates. The store re-derives scope with the domain walker instead of trusting RLS alone (defence in depth, AD-1). A manager's own record appears only when it sits in their subtree; "My record" is Story 4.10.

## Verification

**Commands:**
- `npm run typecheck`: expect no errors.
- `npm test`: all pass, except live DB tests that need the 4.1, 4.2 and 4.3 migrations. Those may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205).
- `npm run build`: expect success.
- `npm run test:e2e`, using Chromium via `launchOptions.executablePath: "/opt/pw-browsers/chromium"`: pass, or fail only with schema-missing errors until the migrations are applied.
