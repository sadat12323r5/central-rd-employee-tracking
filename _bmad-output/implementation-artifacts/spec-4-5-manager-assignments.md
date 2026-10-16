---
title: 'Story 4.5: Managers create and close assignments'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: 'cd0cd97c1cfe5ce459087a4e6ab007296fb5ffa2'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-manager-scoping.md'
warnings: ['oversized']
deferred:
  - summary: >-
      No correction path for a mistaken locked field or closed assignment.
    evidence: |-
      The guard trigger freezes identifying fields on insert and whole rows on close, and nothing can be deleted; a typo stays forever. Needs a System Owner decision (correction window, admin override, or void marker).
    location: >-
      supabase/migrations/20261014030000_assignments.sql
    severity: medium
  - summary: >-
      No record of who created, edited or closed an assignment.
    evidence: |-
      The table has created_at/closed_at only; latest_update is overwritten in place and no audit_events row is written.
    location: >-
      src/server/assignments-store.ts
    severity: medium
  - summary: >-
      Employee status badge is still fixture-driven and not linked to open assignments.
    evidence: |-
      Creating or closing an assignment does not change "On project"/"Available".
    location: >-
      src/data/employees.ts
    severity: low
  - summary: >-
      Every admin/manager page view loads the full assignment history with no limit.
    evidence: |-
      employees-store.listFor reads all assignments; fine at current size, grows with test rows that can never be deleted.
    location: >-
      src/server/employees-store.ts
    severity: low
  - summary: >-
      Seed assignment step (skip already-open, insert-only) has no test.
    evidence: |-
      No test runs scripts/seed-employees.ts; same for its other DB steps.
    location: >-
      scripts/seed-employees.ts
    severity: low
  - summary: >-
      Story 4.8 must block transfers while an assignment is open, or department_id drifts from the employee's department.
    evidence: |-
      Nothing in this story stops an admin/service-role change to employees.department_id.
    location: >-
      supabase/migrations/20261014030000_assignments.sql
    severity: low
  - summary: >-
      Live-test assignment rows accumulate permanently in the shared project.
    evidence: |-
      The no-delete trigger binds the service role, so tests close and archive fixed throwaway records instead of deleting them.
    location: >-
      tests/assignments-rls.test.ts
    severity: low
  - summary: >-
      Database guarantees are only verified by live tests that skip without credentials.
    evidence: |-
      tests/assignments-rls.test.ts is describe.skipIf(!configured); unit tests use fakes.
    location: >-
      tests/assignments-rls.test.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Each employee has one fixture "current work" record that is overwritten, never persisted, and shown next to a fake Git-activity panel. There is no assignment history, so nothing records what an employee did, for whom, or under which department.

**Approach:** Add a persisted `assignments` table with one writer, `assignments-store.ts`. The Administrator, or a manager with authority over the employee's department, creates an assignment, edits its latest-update note while it is open, and closes it with a completion date. Identifying fields lock and no row is ever deleted; the store and the database (trigger + RLS reusing `manages_employee`) both enforce this. `db:seed` migrates the fixture's current work into open assignments. The Current work tab shows the open assignment plus history, and the Git panel is removed.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261014030000_assignments.sql` is **ADDITIVE**: new table, indexes, guard function + triggers, and RLS policies. Nothing existing is altered.
  - Columns: `id uuid pk default gen_random_uuid()`, `employee_id text not null references employees on delete restrict`, `department_id uuid not null references departments on delete restrict`, `client`, `project_name`, `role` (text, trimmed, 1–200), `allocation smallint check 0..100`, `start_date date not null`, `latest_update text not null default ''` (≤ 2000), `status text not null default 'open' check in ('open','closed')`, `completion_date date null`, `created_at`, `closed_at timestamptz null`.
  - Check: `(status='open' and completion_date is null and closed_at is null) or (status='closed' and completion_date is not null and completion_date >= start_date)`.
  - Partial unique index `assignments_one_open_per_employee on (employee_id) where status = 'open'`, plus an index on `employee_id`.
  - `assignments_guard()` (plpgsql, `security definer`, `set search_path = ''`) runs BEFORE INSERT OR UPDATE.
    - On insert it sets `department_id` from `employees.department_id`, raising 23514 when that is null, and forces `status='open'`, `completion_date`/`closed_at` null and `created_at = now()`.
    - On update it raises 23514 for any change to a closed row, and for any change to `id, employee_id, department_id, client, project_name, role, allocation, start_date, created_at`. The only changes allowed are `latest_update` while open, and `open→closed` with a completion date. `closed_at := now()`.
  - A BEFORE DELETE trigger always raises. This binds the service role too.
  - Policies, all `to authenticated`:
    - `assignments_select_admin` (JWT role admin);
    - `assignments_select_managed` (`manages_employee(employee_id)`);
    - `assignments_select_own` (`employees.auth_user_id = auth.uid()`, as in `external_interviews_update_own`);
    - `assignments_insert_authorized` and `assignments_update_authorized` (admin or `manages_employee(employee_id)`, in both `using` and `with check`).
  - No delete policy.
- **Store** `src/server/assignments-store.ts` (`createAssignmentsStore({ userClient, scope = managerScope })`, the `AttendanceStore` shape):
  - `listFor(session, employeeId?)`: the open assignment first, then closed ones by `completion_date` desc.
  - `create(session, employeeId, input)`, `updateNote(session, id, note)`, `close(session, id, completionDate)`.
  - Authority: admin always. A manager only when `scope.forManager(session).employeeIds` has the subject. Staff never.
  - The subject `employeeId` of `updateNote` and `close` is read from the target row, never taken from the form.
  - `create` never accepts `department_id`. It sends the employee's `department_id`, and the trigger is authoritative.
  - Typed errors: `AssignmentsForbiddenError`, `AssignmentEmployeeNotFoundError`, `AssignmentNoDepartmentError`, `AssignmentAlreadyOpenError` (store pre-check, and 23505 from the index), `AssignmentClosedError`, `AssignmentInvalidError`, `AssignmentsUnavailableError`. Not-found reads return `null` or `[]`.
- **Single writer:** only `assignments-store.ts` writes `status`/`completion_date` (AD-2).
- **Actions** `src/server/assignment-actions.ts`: `createAssignmentAction`, `updateAssignmentNoteAction`, `closeAssignmentAction`.
  - Each checks for an admin or manager session first, then zod, then the store, then `revalidatePath("/")`, returning `{ error, message }`.
  - Dates are checked with `isCalendarDate`, and allocation must be an integer 0–100.
- **Seed:** `db:seed` inserts one open assignment per fixture employee (insert-only, idempotent).
  - Each row uses `assignmentSeedId(employeeId)`, with client "Not recorded".
  - `start_date` is the first day of `period` (`"14–20 Sep 2026"` → `2026-09-14`), else `joined`.
  - Employees who already have an open assignment are skipped. Upserts use `onConflict: "id", ignoreDuplicates: true, defaultToNull: false`, and run after the department placement.
  - `commits` is dropped.
- **Live DB tests** sign each test user in once per file and reuse the session. Bulk inserts pass `{ defaultToNull: false }`. Throwaway rows only, cleaned up through the service role.

**Never:**
- No evaluations (4.6), no staff portal assignment UI (4.6), no backfill or `provenance` marker (4.7), no transfers (4.8).
- No delete path, and no caller-chosen `department_id`. Assignments are never written by Staff.
- No Git activity migration, and no runtime reads of the fixture's work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create | Admin, or manager over the employee; no open assignment | Saved as open, with `department_id` = the employee's department | "Assignment created." |
| Second open | Employee already has an open assignment | Rejected, nothing saved | "This employee already has an open assignment. Close it first." |
| Out of scope | Manager whose subtree excludes the employee: create/note/close | Rejected at the store; RLS returns 0 rows or refuses the write | "Only the Administrator or a manager over this employee's department can manage assignments." |
| Staff | Any write action, or a direct insert/update with a Staff JWT | Rejected; RLS denies | Same forbidden message |
| Edit note | Open assignment | Note saved | "Latest update saved." |
| Locked fields | Update of client, project, role, department, allocation or start date (direct DB too) | Rejected by the trigger, 23514 | Store maps to `AssignmentInvalidError` |
| Close | Open; completion date ≥ start date | Closed; listed in history | "Assignment closed." |
| Bad close | Completion date before start, invalid date, or already closed | Rejected | Field message, or "This assignment is closed and can't be changed." |
| Closed row | Note edit or reopen | Rejected | Same closed message |
| No department | Employee with `department_id` null | Rejected | "Place this employee in a department first." |
| Delete | Any role, including service role | Raises; row kept | — |
| Read own | Staff JWT | Only their own rows; none of another employee's | — |
| Seed | Re-run; or the seeded row is closed; or a manager already created an open one | No duplicates; that employee is skipped | — |
| Unparseable period | `period` = "ongoing" | `start_date` = `joined` | — |

</intent-contract>

## Code Map

- `src/data/employees.ts:21,112`: `Employee.work`, which carries `commits`/`period`. Remove `work` from `Employee`, add `assignments: Assignment[]`, and move the fixture's work into a seed-only list without `commits`. Add `assignmentSeedId` and `assignmentSeedRows` next to `trainingSeedId:53` and `trainingSeedRows:63`.
- `src/server/employees-store.ts:70-84` (`NestedProfile`, `emptyProfile`, `nestedFor` drop `work`); `:92` (`toEmployee` takes `assignments`); `:118-129` (inject `assignments: Pick<AssignmentsStore,"listFor">`, composed like `training`; a failure means `EmployeesUnavailableError`); `:238`.
- `src/server/manager-scope.ts`: `forManager`, `ManagerScopeUnavailableError` (map to `AssignmentsUnavailableError`).
- `src/server/training-store.ts`: admin/manager/staff `listFor` branch pattern to copy.
- `src/server/department-actions.ts`: zod `field()`, `refusal()` mapping and `ActionState` (from `attendance-actions.ts:9`).
- `src/domain/dates.ts`: `isCalendarDate`, `formatDisplayDate`.
- `src/components/portal.tsx:167` (the Overview "Current focus" reads `work`: show the open assignment, or "No open assignment"); `:171` (Current work tab: open panel and its forms, a history list with "Open"/"Closed" text labels and `D MMM YYYY` dates, and the Git panel removed); `:170` (fine-print "Git activity" wording stays accurate).
- `scripts/seed-employees.ts:124-156`: add the assignments step after the employee placement; update the header comment.
- `supabase/migrations/20261012020000_external_interview_updates.sql` (guard trigger style), `20261014020000_manager_scope.sql` (`manages_employee`), `20261014000000_departments.sql:61-72` (admin JWT policy).
- `tests/manager-scope-rls.test.ts`, `tests/interviews-rls.test.ts`: live patterns. `tests/e2e/department-manager.spec.ts`, `tests/e2e/global-setup.ts` (BS-98nn throwaways): e2e patterns. `tests/components/portal.test.tsx:194`: the `work` stub.

## Tasks & Acceptance

**Execution:**
1. `supabase/migrations/20261014030000_assignments.sql`: table, indexes, guard, delete trigger, policies (ADDITIVE). The header comment says why a trigger and not column grants.
2. `src/data/employees.ts` + `tests/fixture-assignments.test.ts`: seed rows (period parse, join-date fallback, "Not recorded", ids, no commits).
3. `src/server/assignments-store.ts` + `tests/assignments-store.test.ts`: every matrix row at the store, with a fake client and an injected scope.
4. `src/server/assignment-actions.ts` + `tests/assignment-actions.test.ts`: session gate, zod, error mapping.
5. `src/server/employees-store.ts`, `src/app/page.tsx` + `tests/employees-store.test.ts`, `tests/page.test.tsx`: compose assignments; `work` gone; admin/staff/manager regressions stay green.
6. `src/components/portal.tsx` + `tests/components/portal.test.tsx`: Current work tab and Overview, keyboard-operable forms; no "Recorded Git activity"; create form only when nothing is open.
7. `tests/assignments-single-writer.test.ts`: no file under `src/` except `assignments-store.ts` mentions `completion_date` or writes `status` on `assignments`.
8. `scripts/seed-employees.ts`, `docs/DEPLOYMENT.md`: seed step; apply the migration, then `npm run db:seed`.
9. `tests/assignments-rls.test.ts` (live): throwaway parent and child departments, employees, an admin, managers of each, and Staff. Assert scoped select/insert/update; Staff own-read only and no writes; locked fields, closed rows and delete all refused; a second open insert gives 23505; `department_id` is overwritten by the trigger.
10. `tests/e2e/assignments.spec.ts`: a throwaway-department manager creates, edits the note on, and closes an assignment for a throwaway employee; it appears in history; a second create while one is open shows the rejection.

**Acceptance Criteria:**
- Given an authorized manager on the Current work tab, when they submit client, project, role, allocation and start date, then the open assignment shows those values and the employee's department, and the form has no department field.
- Given the seed has run, when the Administrator opens any fixture employee's Current work tab, then an open assignment shows the fixture's project, role, allocation and latest update, with client "Not recorded" and start date 14 Sep 2026, and no Git activity panel.
- Given a closed assignment, when the tab is reopened, then it is listed in history with its completion date, and no edit or close control is offered for it.
- Given a manager of Central R&D, when they call any assignment action for an L&D employee, then it is rejected at the server, and a direct PostgREST write with their JWT is refused by RLS.

## Spec Change Log

## Review Triage Log

### 2026-10-16 — Review pass
(Resumed run: the previous run died after implementation with no triage log, so this is a fresh full review on the adopted branch.)
- verdicts: 33 findings — high 0, medium 3, low 13, false 3, maybe-false 0 (plus 14 design/scope observations recorded below as defer or reject)
- findings:
  - blind-hunter
    - `[medium]` `[defer]` No way to correct a mistaken locked field or closed row (no correction window, admin override or void marker) — real, but the contract locks fields deliberately; a correction path is a stakeholder decision. Deferred.
    - `[low]` `[reject]` Close has no confirmation step — every other form in the app submits without confirm; adding one is new UI behaviour, not a direct fix.
    - `[low]` `[reject]` Future completion dates accepted — the spec's Design Notes record "no future-date limit" as a deliberate assumption; recorded as an open question in deferred-work.
    - `[medium]` `[defer]` No created_by/closed_by or audit trail for note edits — real accountability gap; adding columns/audit rows widens the schema beyond the contract. Deferred.
    - `[low]` `[reject]` Assignments can be created for archived employees — the spec's Design Notes deliberately allow it (conservative assumption).
    - `[low]` `[defer]` Employee status badge ("On project"/"Available") still fixture-driven, not linked to assignments — pre-existing fixture field, no story owns it yet.
    - `[medium]` `[reject]` Staff reads fail when assignments are unavailable — the contract (Code Map) composes assignments into every employee read with failure → EmployeesUnavailableError, exactly like training; the migration is applied before merge. Consistent with the existing training precedent.
    - `[low]` `[defer]` Full assignment history loaded on every admin/manager view with no limit — fine at current data size; recorded for later.
    - `[low]` `[reject]` Live region swaps between role=alert and role=status — inserted role=alert regions are announced assertively; same pattern as every other panel in src/components.
    - `[low]` `[defer]` Seed's assignment block untested — real; no seed DB step in the repo has tests (pre-existing). Deferred with the verification-gap duplicate.
    - `[low]` `[reject]` Seed log "skipped" count misleading — cosmetic log text.
    - `[low]` `[defer]` department_id invariant depends on Story 4.8 blocking transfers — true; 4.8 is the owning story and must enforce it. Deferred to 4.8.
    - `[low]` `[reject]` 23514 "no department" race maps to the generic message — needs a department cleared between read and insert; the store's own pre-check covers the normal path.
    - `[low]` `[reject]` Small UI gaps (empty completion date format, first-name split, missing full stop, unsaved note lost on refresh) — cosmetic; first-name split copies the existing portal convention; the refusal case of the lost note is patched below.
  - edge-case-hunter
    - `[medium]` `[patch]` Note or completion date typed into a refused form is lost (React resets the form after the action) — patched: note and close forms keep the refused value and re-key per attempt, like the create form; component test added and proven failing without the patch.
    - `[low]` `[reject]` Archived employee gets a new assignment — duplicate of the blind-hunter row; spec assumption.
    - `[low]` `[reject]` Department outside the viewer's list shows "No department" — portal's pre-existing departmentName helper; managers see departments in their scope and 4.8 transfers are not built yet.
    - `[low]` `[patch]` Missing note field silently clears the note via `.default("")` — patched: the schema now refuses a missing/non-string note ("Enter the latest update."); an empty string still clears it deliberately.
    - `[low]` `[reject]` Future completion date — duplicate; spec assumption.
    - `[low]` `[reject]` Seed race with a concurrently created open assignment — needs a manager write during the seed run; a rerun succeeds.
  - verification-gap
    - `[low]` `[defer]` Seed skip-already-open / insert-only rules not exercised by any test — pre-verified; deferred (no seed DB step has tests; needs a refactor or the live project).
    - `[low]` `[patch]` Tie-break order of closed assignments with the same completion date not pinned — patched: added a unit test in tests/assignments-store.test.ts.
  - intent-alignment
    - `[false]` `[reject]` Delete "raises for any role" only true for the service role — the outcome (row kept, no delete) holds for every role; with no delete policy RLS filters the row before the trigger, which the live test pins.
    - `[low]` `[defer]` Test rows cannot be cleaned up (no delete) and accumulate in the shared project — necessary consequence of the no-delete rule; documented in DEPLOYMENT.md. Deferred.
    - `[false]` `[reject]` Single-writer check scans only src/ — the contract scopes AD-2 to the app; the seed never writes status/completion_date.
    - `[false]` `[reject]` Note edit/close on a missing id throws Forbidden rather than not-found — the contract's not-found rule is about reads; a write on an unseen id is correctly refused.
    - `[low]` `[defer]` Database guarantees (trigger, RLS) are only checked by live tests that skip without credentials — CI has the credentials; tracked with the migration hand-off.

## Design Notes

Field locking uses a BEFORE UPDATE trigger rather than column privileges. Three reasons: it follows the `external_interviews_guard` precedent; it is purely additive; and it binds the service role. Column grants also cannot express the state-dependent rule (the note is editable only while open, and closed rows are frozen). The insert trigger copies `department_id` as SECURITY DEFINER, so the value is the employee's real department whatever the caller sent. The store still copies it so that its own checks (no department, authority) run first. RLS uses `manages_employee`, which is the same authority chain as `scope.forManager`, so the store and database scopes cannot disagree. Story 4.8 blocks transfers while an assignment is open, so the employee's current department equals `department_id` for every writable row.

Assumptions (validation details the planning docs leave open; conservative defaults, revisit if the System Owner decides otherwise): completion date must be on or after the start date, with no future-date limit; assignments may be created for archived employees (not blocked); allocation is an integer percentage 0–100 (the fixture uses 0% for Available employees); text limits are 200 characters (client, project, role) and 2000 (latest update); manager read access follows the employee's current department (post-transfer visibility is for 4.6/4.8).

## Verification

**Commands:**
- `npm run typecheck`: no errors.
- `npm test`: all pass, except live DB tests that need the 4.1–4.5 migrations. Those may fail only with 42P01, 42703, 42883, PGRST202, PGRST204 or PGRST205.
- `npm run build`: success.
- `npm run test:e2e`, with Chromium at `launchOptions.executablePath: "/opt/pw-browsers/chromium"`: pass, or fail only with the same schema-missing errors.

**Manual checks:**
- Read the migration: no `alter`/`drop` of existing objects, no delete policy, and the header states ADDITIVE.

## Auto Run Result

Status: done (resumed from an abandoned run's WIP branch; review run fresh on 2026-10-16)

**Summary:** persisted `assignments` table (ADDITIVE migration `20261014030000_assignments.sql`) with a guard trigger that copies the employee's department, locks identifying fields, freezes closed rows and refuses deletes; RLS reusing `manages_employee`. `assignments-store.ts` is the single writer; `assignment-actions.ts` exposes create / edit note / close. The Current work tab shows the open assignment with its forms plus the read-only history; the Git activity panel is gone. `db:seed` migrates the fixture's current work into open assignments (client "Not recorded").

**Files changed:** migration; `src/server/assignments-store.ts`, `src/server/assignment-actions.ts` (new); `src/components/assignments-panel.tsx` (new); `src/components/portal.tsx`, `src/server/employees-store.ts`, `src/data/employees.ts`, `src/app/styles.css`; `scripts/seed-employees.ts`, `docs/DEPLOYMENT.md`; tests: assignments-store, assignment-actions, assignments-single-writer, fixture-assignments, assignments-rls (live), e2e/assignments, plus updates to portal, employees-store, page and manager-scope-rls tests.

**Review:** 3 patches (1 medium: refused note/close values kept; 2 low: missing note refused, same-date ordering test), 8 deferred (see frontmatter), the rest rejected with reasons in the triage log.

**Follow-up review recommended:** false (patched: 1 medium, 2 low; no high).

**Verification:** see the PR; typecheck and build pass; unit tests pass except live RLS tests that fail only with PGRST205 (schema missing: the 4.1–4.5 migrations are not applied to the shared project).

**Residual risk:** database-level rules are only exercised once the migrations are applied and the live tests run.
