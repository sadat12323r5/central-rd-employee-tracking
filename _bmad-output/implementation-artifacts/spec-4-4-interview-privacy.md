---
title: 'Story 4.4: Interview privacy holds for managers'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: '728f9d3bb2ce2cc40e1daa9ec67e80ff5146fb78'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-department-manager.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-manager-scoping.md'
warnings: []
deferred:
  - summary: >-
      AC3's data path ("that employee's other profile data in their scope shows normally") is proven only at the Portal component level; no page-level or live test shows a real manager receiving a team member's non-interview profile data.
    evidence: |-
      Manager scoping is Story 4.3 (claimed by another run, not yet implemented on this branch's base); employees-store still returns only the manager's own record. Once 4.3 lands, add a page-level or live test that a manager's in-scope employee arrives with training/attendance/work intact and interviews empty.
    location: >-
      tests/components/portal.test.tsx (Interview privacy for managers block)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Story 4.2 hid the interview views from manager sessions and made `interviews-store.listFor` return `[]` for them, but nothing proves the database itself returns zero interview rows to a manager whose department (or sub-department) contains an employee with interviews, and the manager page still hands whatever `employee.interviews` the store returns straight into the client `Portal` payload. As manager scoping (4.3) widens what managers read, interview privacy must hold by construction at every layer (FR-3).

**Approach:** Strip interviews server-side in the manager branch of `src/app/page.tsx` so a manager's client payload can never carry them, and prove the rule end to end: a live RLS/store test with real department managers over a parent/child department tree, plus page and portal tests showing that only interviews are excluded while the rest of a profile renders normally. No schema change.

## Boundaries & Constraints

**Always:**
- Interview reads keep checking the Administrator role or the employee's own identity directly, never a department or manager predicate (epic: "the one exception is interviews").
- The manager branch of `page.tsx` passes every employee to `Portal` with `interviews: []`, whatever the store returned; Admin and Staff branches are unchanged.
- The live test uses only its own throwaway auth users, departments (names carrying the run id) and BS-91xx employees; signs each test user in once per file; bulk inserts pass `{ defaultToNull: false }`; cleans up through the service role (interviews, then employees' `department_id`, departments, employees, users).
- A manager account's own interviews stay readable by that account through the existing own-row policy (Staff self-service, Story 4.10), and are hidden from the manager of the parent department.

**Never:**
- No migration, no new or changed RLS policy (the existing two select policies already exclude managers; tightening them would be DESTRUCTIVE and is not needed).
- No manager scoping work (Story 4.3), no "My record" (4.10), no change to Staff or Administrator interview behaviour.
- No interviews in any manager-visible surface: navigation, profile tabs, overview stat/radar, CSV export, client payload.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Direct DB, subtree employee | Parent-dept manager JWT selects `external_interviews` for an employee in the child dept | 0 rows, no error | — |
| Direct DB, own dept employee | Child-dept manager JWT selects interviews of an employee in its own dept | 0 rows | — |
| Manager above a manager | Parent manager selects the child manager's interviews | 0 rows | — |
| Own interviews | Child manager selects with no filter | only its own employee's rows | — |
| Store | `createInterviewsStore` over the manager's client, `listFor(manager)` and `listFor(manager, id)` | `[]` | — |
| Control | Admin JWT selects the same employee ids | every test interview | — |
| Page | manager session; store returns employees that carry interviews | `Portal` receives `role="manager"` and every employee with `interviews: []` | — |
| Profile | manager opens an in-scope employee's profile | Overview, Employment, Training, Skills & evaluation, Current work, Attendance render their data; no Interviews tab or interview text | — |

</intent-contract>

## Code Map

- `src/app/page.tsx:26-31` -- manager branch: `employeesStore.listFor(session)` → `<Portal role="manager" …>`; add the interview strip here (pure helper in the same file).
- `src/server/interviews-store.ts:146` -- `listFor` already returns `[]` for `role === "manager"` (4.2); add/update/withdraw already refuse non-staff. Read-only for this story.
- `supabase/migrations/20261012010000_external_interviews.sql:28-38` -- `external_interviews_select_admin` (JWT `app_metadata.role = 'admin'`) and `external_interviews_select_own` (`employees.auth_user_id = auth.uid()`); no department predicate. Read-only.
- `supabase/migrations/20261014000000_departments.sql`, `20261014010000_department_managers.sql` -- `departments`, `employees.department_id`, `departments.manager_user_id` (4.1/4.2, not yet applied to the shared project: PGRST205/42703).
- `src/components/portal.tsx:97-98,138-140,165,170,173` -- `MANAGER_HIDDEN_SECTIONS`, `MANAGER_HIDDEN_TABS`, manager guards; read-only unless a test exposes a leak.
- `tests/departments-rls.test.ts` -- pattern for throwaway users/departments, `signedIn` session cache, service-role cleanup.
- `tests/interviews-rls.test.ts` -- pattern for `interviewRow`, employee rows, interview cleanup order.
- `tests/page.test.tsx:119-137` -- manager page test with `portalProps` spy.
- `tests/components/portal.test.tsx:561-620` -- "Portal for a department manager (Story 4.2)" block, `employees` fixture, `show`, `none()`.

## Tasks & Acceptance

**Execution:**
- `src/app/page.tsx` -- in the manager branch, map employees to `{ ...e, interviews: [] }` before rendering `Portal` and before computing current training ids (ids unchanged) -- keeps interviews out of the manager's RSC payload regardless of store behaviour.
- `tests/page.test.tsx` -- manager session whose `listFor` returns a fixture employee with interviews: `Portal` props carry the same employees with `interviews: []`; admin branch still passes interviews through.
- `tests/components/portal.test.tsx` -- new "Interview privacy for managers (Story 4.4)" block: a manager given an employee that carries interviews sees none of the interview text anywhere (Overview, directory, profile, CSV export rows if exported), and each other profile tab (Overview, Employment, Training, Skills & evaluation, Current work, Attendance) shows its normal content.
- `tests/interview-privacy-rls.test.ts` -- new live test covering every RLS/Store row of the I/O matrix with a parent department managed by manager A, a child department managed by manager B, employee E (no account) in the child department; interviews for E and for B.

**Acceptance Criteria:**
- Given a manager session, when it opens the management portal, then neither the profile Interviews tab nor the "Interviews & placements" view is shown, and the page payload carries no interviews.
- Given a manager whose department subtree contains an employee with interviews, when it queries interviews directly through the database or the store, then zero rows are returned.
- Given the same manager, when they open that employee's other profile data, then it shows normally; only interviews are excluded.

## Design Notes

The privacy rule already holds structurally: both interview select policies name the Administrator role or the row's own employee, so adding manager policies on other tables (4.3) cannot widen it. This story makes that guarantee observable with real manager accounts and closes the one remaining channel (the client payload) with a server-side strip rather than relying on hidden UI.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests needing the 4.1/4.2 migrations, failing only with schema-missing errors (42P01/42703/PGRST204/PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, or fail only with schema-missing errors until the 4.1/4.2 migrations are applied

## Auto Run Result

Status: done

**Summary:** Interview privacy for managers was already enforced by the existing RLS policies (admin role or own employee only) and Story 4.2's store/portal guards. This story adds a server-side strip so a manager's page payload never carries interviews, and proves the rule: a live RLS/store test with real parent/child department managers, plus page and portal tests showing only interviews are excluded. No migration.

**Files changed:**
- `src/app/page.tsx`: `withoutInterviews` strips interviews from every employee in the manager branch.
- `tests/page.test.tsx`: manager payload has `interviews: []`; admin still receives interviews.
- `tests/components/portal.test.tsx`: no interview text anywhere (sections, profile, CSV) for a manager; every other profile tab renders normally; admin control.
- `tests/interview-privacy-rls.test.ts`: new live test (BS-91xx), DB + store, parent/child managers, own-row and admin controls.

**Review findings:** 20 total. Patched: 5 rows (4 root causes, all low). Deferred: 1 (medium, AC3 data path after Story 4.3). Rejected: 14, reasons in the triage log.

**Follow-up review recommended:** false. No high or medium findings were patched.

**Verification:**
- `npm run typecheck`, `npm run build`: pass.
- `npm test`: 821 passed, 19 skipped; only `tests/departments-rls.test.ts` and `tests/interview-privacy-rls.test.ts` fail, with PGRST205/PGRST204 (4.1/4.2 migrations not applied).
- `npm run test:e2e` (PLAYWRIGHT_CHANNEL=chromium): 11 passed; 12 admin-portal specs fail only with 42703/PGRST205, as on the 4.2 parent.

**Residual risks:**
- The live test has never run against the real schema; re-run after the 4.1 and 4.2 migrations are applied.
- Built on the 4.3 claim branch before 4.3's implementation; expect a small merge in `src/app/page.tsx` when 4.3 lands.

