---
title: 'Story 4.3: Managers see only their own department'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: 'fab4f106d3dddc2c2e4d5afc38f65ed8c04a2d4a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-department-manager.md'
warnings: ['oversized']
deferred:
  - summary: >-
      RLS live tests clean up departments by a per-run name prefix, so departments left by an aborted earlier run are never removed.
    evidence: |-
      tests/manager-scope-rls.test.ts PREFIX includes randomBytes run id; same pattern in tests/departments-rls.test.ts.
    location: >-
      tests/manager-scope-rls.test.ts:33
    severity: low
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

- 2026-10-14: resumed by a later unattended run; the original run stopped after the spec (claim branch idle >4h, no PR).

## Review Triage Log

### 2026-10-14 — Review pass
- verdicts: 30 findings — high 0, medium 0, low 22, false 8, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: scope recomputed ~3-4 times per page load and could disagree mid-request — fresh-per-request is the contract; a per-request memo adds plumbing for a race that needs an admin reassignment during one render.
  - `[low]` `[reject]` Blind: RLS exposes all employee columns (incl. auth_user_id) of in-scope rows to a manager JWT via raw PostgREST — the intent bans auth_user_id at the store only; an auth uuid is not a credential; column grants/view is a schema redesign. Noted in the PR.
  - `[false]` `[reject]` Blind: manager attendance store branch unused by the app — the intent says the manager views come from the scoped employee list and only the Staff branch uses listFor.
  - `[false]` `[reject]` Blind: e2e finally sets department_id null instead of restoring — the members are throwaway employees created by global-setup with no department and deleted in teardown.
  - `[low]` `[defer]` Blind: RLS test cleanup by per-run name prefix cannot remove departments from earlier aborted runs — same pattern pre-exists in tests/departments-rls.test.ts.
  - `[low]` `[patch]` Blind: DEPLOYMENT.md checklist names `*_select_managed` for departments (real: departments_select_managed_subtree) — listed the five real policy names.
  - `[low]` `[patch]` Blind: DEPLOYMENT.md misdescribes the pre-migration fallback — reworded to match the store scope.
  - `[low]` `[reject]` Blind: per-row recursive CTE in policies and auth.uid() not wrapped — department trees are a handful of rows; no measured cost.
  - `[low]` `[reject]` Blind: whole manager page fails when departments are unavailable — consistent with the other unavailable paths; graceful degradation is not asked for.
  - `[low]` `[reject]` Blind: toEmployee boolean overload — cosmetic; no caller harmed.
  - `[low]` `[patch]` Blind: singular "Across 1 department" untested — added a portal test.
  - `[low]` `[reject]` Blind: no portal tests for empty scope / archived in-scope rows — covered at the store; empty list rendering is pre-existing.
  - `[low]` `[reject]` Blind: memory attendance store listFor returns [] for managers — test support only; the real store branch is unit-tested.
  - `[low]` `[patch]` Blind: page.test mock named listForEmployee wired to listFor — renamed to attendanceListFor.
  - `[low]` `[reject]` Blind: memory store forEmployee duplicates listForEmployee — test-support cosmetic.
  - `[low]` `[reject]` Blind: userId stored on both identity and Actor — both come from the same validated user id in one function.
  - `[low]` `[patch]` VerificationGap: singular note never asserted — same patch as above.
  - `[low]` `[reject]` VerificationGap other: Promise.all picks whichever unavailable error rejects first — both messages are correct; no user harm.
  - `[low]` `[reject]` VerificationGap other: scope computed three times per load — duplicate of the first row's reasoning.
  - `[low]` `[reject]` EdgeCase: separate scope reads per request can diverge — as above.
  - `[low]` `[reject]` EdgeCase: PostgREST max-rows truncation of scope — L&D has tens of employees, far below 1000.
  - `[low]` `[reject]` EdgeCase: .in() URL length for large subtrees (scope) — same scale argument.
  - `[low]` `[reject]` EdgeCase: .in() URL length in employees-store — same.
  - `[low]` `[reject]` EdgeCase: .in() URL length in training-store — same.
  - `[false]` `[reject]` EdgeCase: departments-store withManagers reads employees.auth_user_id under the manager JWT — it only resolves manager ids already present on departments the manager can read, as the Code Map says ("as far as RLS allows"); no new link is revealed.
  - `[low]` `[reject]` EdgeCase: per-row helper cost on Admin/Staff reads — policies OR together; admin/staff policies short-circuit is not guaranteed but tables are small.
  - `[false]` `[reject]` EdgeCase: e2e department_id null restore — duplicate of the Blind row; throwaway employees.
  - `[low]` `[patch]` EdgeCase claim: DEPLOYMENT.md own-record fallback claim — same patch as above.
  - `[false]` `[reject]` Intent: attendance view uses fixture summaries not attendance_entries (R3) — the intent states the views come from the scoped employee list; real attendance views are Story 5.4.
  - `[false]` `[reject]` Intent: currentFor resolves {status:"unavailable"} instead of throwing; title says "department" not subtree; direct-profile tested at store not page; portal tests use props; departments carry managerUserId (R5b) — each matches the intent's letter (currentFor's contract returns a value; profiles open from the scoped list); descriptive only.

## Design Notes

Scope runs downward: a department is in scope when the manager is on its authority chain. That is the same rule as AD-4's authority set, read from the other end, so scope and later write checks cannot disagree. The SQL helpers are SECURITY DEFINER because a manager must not be able to read the department and employee rows the walk passes through. They expose only a boolean about `auth.uid()`. `UNION` in the recursive CTE de-duplicates rows, so a cyclic parent chain still terminates. The store re-derives scope with the domain walker instead of trusting RLS alone (defence in depth, AD-1). A manager's own record appears only when it sits in their subtree; "My record" is Story 4.10.

## Verification

**Commands:**
- `npm run typecheck`: expect no errors.
- `npm test`: all pass, except live DB tests that need the 4.1, 4.2 and 4.3 migrations. Those may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205).
- `npm run build`: expect success.
- `npm run test:e2e`, using Chromium via `launchOptions.executablePath: "/opt/pw-browsers/chromium"`: pass, or fail only with schema-missing errors until the migrations are applied.

## Auto Run Result

Status: done

**Summary:** Department managers now see only their department subtree (managed departments plus every sub-department) in the directory, profiles, L&D, attendance and CSV export, enforced by new ADDITIVE RLS select policies (SECURITY DEFINER helpers walking up the tree) and re-derived at the store on every request.

**Files changed:**
- `supabase/migrations/20261014020000_manager_scope.sql` — ADDITIVE helpers `manages_department`/`manages_employee` and five select-only policies.
- `src/domain/departments.ts` — `managedDepartmentIds`.
- `src/server/session.ts`, `src/server/auth.ts` — manager identity carries `userId`.
- `src/server/manager-scope.ts` — scope helper and `ManagerScopeUnavailableError`.
- `src/server/employees-store.ts`, `training-store.ts`, `attendance-store.ts`, `departments-store.ts` — manager branches; admin/staff unchanged.
- `src/app/page.tsx`, `src/components/portal.tsx` — scoped data, department names, manager overview note.
- `docs/DEPLOYMENT.md` — migration note and checklist item 10.
- Tests: new `tests/manager-scope.test.ts`, `tests/manager-scope-rls.test.ts` (live); extended domain, store, page, portal and e2e tests.

**Review:** 30 findings; 4 entries patched (all low: DEPLOYMENT policy names, DEPLOYMENT fallback wording, singular-note test, mock rename), 1 deferred (RLS test cleanup of aborted-run departments), the rest rejected with reasons in the triage log. Follow-up review recommended: false (patched: high 0, medium 0, low 4).

**Verification:** `npm run typecheck` pass; `npm run build` pass; `npm test` 861 passed / 24 skipped, only `tests/departments-rls.test.ts` and `tests/manager-scope-rls.test.ts` fail, with PGRST205 (`public.departments` missing — 4.1 migration not applied). `npm run test:e2e` (Chromium via executablePath): 11 passed, 13 failed, all from missing schema (`column employees.department_id does not exist` 42703 on the admin page, PGRST205 creating the throwaway department). The implementer also applied all migrations to a throwaway local Postgres 16 and confirmed subtree/child-only scoping, loop termination, no manager writes, and anon cannot execute the helpers.

**Residual risks:** live RLS and e2e tests have not run against the real schema; re-run after applying 4.1, 4.2, 4.3 migrations. A manager's JWT can read all columns of in-scope employee rows via raw PostgREST (store hides auth_user_id).
