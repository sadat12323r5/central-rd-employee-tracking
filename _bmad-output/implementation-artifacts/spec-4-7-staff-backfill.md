---
title: 'Story 4.7: Staff backfills a past project'
type: 'feature'
created: '2026-10-16'
status: 'in-progress'
baseline_revision: 'f8987f64f080616a99d0cfdfbf3176b02745021c'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-6-assignment-evaluation.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** An employee's track record only holds assignments created in this system (4.5). Projects they did before it existed, or that nobody tracked, are missing. The L&D manager therefore sees an incomplete history.

**Approach:** Add a separate, employee-authored `backfilled_projects` table (AD-2) with a single writer, `backfilled-project-store.ts`. Only the owner can add, edit and withdraw entries. Withdrawn entries stay in history, marked. The Administrator and managers see them read-only, mixed with assignments, and every row carries a materialized `provenance` marker: self-reported or manager-created.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261016010000_backfilled_projects.sql` is **ADDITIVE**: a new table, indexes, a guard function and triggers, policies, and one new read-only function. Nothing existing is altered.
  - **Columns:**
    - `id uuid pk default gen_random_uuid()`.
    - `employee_id text not null references employees(employee_id) on delete restrict`.
    - `department_id uuid not null references departments(id) on delete restrict`.
    - `client` and `project_name`: trimmed, 1–200 characters.
    - `completion_date date not null`.
    - `outcome text not null`: trimmed, 1–2000 characters.
    - `status text not null default 'active' check in ('active','withdrawn')`.
    - `created_at`, `updated_at`, and `withdrawn_at timestamptz null`.
    - A check: `(status='active') = (withdrawn_at is null)`.
    - An index on `employee_id`.
  - **Guard** `backfilled_projects_guard()`: plpgsql, `security definer`, `set search_path = ''`, BEFORE INSERT OR UPDATE.
    - On insert it forces `status='active'`, `withdrawn_at` null and `created_at = updated_at = now()`.
    - On update:
      - It raises 23514 for any change to a withdrawn row, and for any change to `id, employee_id, created_at`.
      - `active→withdrawn` sets `withdrawn_at := now()`. A withdrawn row never changes back.
      - `updated_at := now()` on every update.
  - A BEFORE DELETE trigger always raises.
  - **Policies**, all `to authenticated`:
    - `select`: admin JWT role, OR `manages_employee(employee_id)`, OR own (`employees.auth_user_id = (select auth.uid())`).
    - `insert` and `update`: own only, in `with check` (and `using` for update). No admin or manager write policy at all.
    - No delete policy.
  - **Department options:** `public.department_options()` returns `table(id uuid, name text)`. It is `security definer`, `stable`, `set search_path = ''`, and returns every department's id and name only. Execute is granted to authenticated and revoked from public and anon. Staff need the list to pick from, but must not read `departments` (which holds manager ids).
- **Store** `src/server/backfilled-project-store.ts`: `createBackfilledProjectStore({ userClient, scope = managerScope })`, following the `AttendanceStore` shape.
  - **`listFor(session, employeeId?)`:** scoped like `assignments-store.listFor`. The admin sees everything, a manager sees in-scope employees, and Staff see only their own. Ordered by `completion_date` desc, then `created_at` desc, then `id`. Every row has `provenance: "backfilled"` set by the store.
  - **`departmentOptions()`:** calls the rpc. It returns `{ id, name }[]` sorted by name.
  - **Writes:** `add(session, input)`, `edit(session, id, input)` and `withdraw(session, id)`.
    - The owner is always `session.employeeId`. A session without an `employeeId` is refused.
    - `edit` and `withdraw` read the target row and refuse anything not owned by the session. That includes the Administrator and managers on someone else's entry (`BackfillForbiddenError`).
    - A withdrawn row is refused with `BackfillWithdrawnError`.
  - **Input** `{ departmentId, client, projectName, completionDate, outcome }`:
    - `departmentId` must be in `departmentOptions()` (`BackfillDepartmentError`); the FK backs this up.
    - `completionDate` must be a valid calendar date, not after today in Asia/Dhaka.
    - Text is trimmed, with the length limits above (`BackfillInvalidError`).
  - **Errors:** a database failure is `BackfillUnavailableError`. 23503 maps to `BackfillDepartmentError`, 23514 to `BackfillInvalidError`, 42501 to `BackfillForbiddenError`.
- **Provenance:**
  - The `Assignment` type gains `provenance: "assignment"`, set in `toAssignment`.
  - The `BackfilledProject` type is `{ id, employeeId, departmentId, client, projectName, completionDate, outcome, status, createdAt, updatedAt, withdrawnAt, provenance: "backfilled" }`, exported from `src/data/employees.ts`.
  - `Employee` gains `backfilledProjects: BackfilledProject[]`, composed in `employees-store`. A failure there means `EmployeesUnavailableError`.
- **Actions** `src/server/backfill-actions.ts`: `addBackfillAction`, `editBackfillAction` and `withdrawBackfillAction`. For each:
  - The session must be signed in with an `employeeId`.
  - Then zod, then the store, then `revalidatePath("/")`.
  - Each returns `{ error, message }`.
  - CRLF is normalized before the length checks, as in 4.6.
- **UI:**
  - The staff portal's "My assignments" section gets a keyboard-operable "Add a past project" form. Its department is a select fed from `departmentOptions()`, passed from `page.tsx`.
  - Each active backfilled entry shows edit (`<details>`) and withdraw controls.
  - Withdrawn entries stay listed with a "Withdrawn" text label and no controls.
  - Refused forms keep what was typed.
  - The management portal's Current work history lists closed assignments and backfilled entries together, newest completion first. Each row has a text marker, "Manager-created" or "Self-reported", plus "Withdrawn" where it applies. Backfilled rows are read-only there.
- **Live DB tests:** sign each test user in once per file, use `{ defaultToNull: false }` for bulk inserts, use fixed throwaway records, and never delete.

**Never:**
- No admin or manager edit or withdraw path, at the store or in RLS. No evaluations of backfilled entries. No "My record" for managers (4.10). No transfers (4.8). No exports (8.4).
- No delete path. Staff never see another employee's entries. Staff never read the `departments` table directly.
- The provenance is never derived in the UI from which list a row came from.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add | Staff, valid input | Saved as active, owned by the session employee, shown in their history | "Past project added." |
| Edit own | Owner, active entry | Saved; updated_at changes | "Past project updated." |
| Withdraw own | Owner, active entry | Status withdrawn, withdrawn_at set; still listed and marked "Withdrawn" | "Past project withdrawn." |
| Withdrawn row | Edit or withdraw again | Rejected | "This past project was withdrawn and can't be changed." |
| Admin/manager write | Admin or manager edits or withdraws another employee's entry (store or direct DB) | Rejected; RLS refuses or matches 0 rows | "Only the employee who added this past project can change it." |
| Other Staff | Staff reads, edits or withdraws another Staff member's entry | Reads return nothing; writes refused | Same forbidden message |
| Unknown department | departmentId not in the list | Rejected; the FK backs this up (23503) | "Choose a department from the list." |
| Invalid | Empty or too-long text; invalid date; completion date after today | Rejected | Field message |
| No employee | Session without employeeId (e.g. unlinked Administrator) | Rejected | "Only an employee can add their own past projects." |
| Mixed history | Admin or manager opens Current work | Closed assignments and backfilled rows together, newest completion first, each marked Manager-created or Self-reported | — |
| Delete | Any role, the service role included | Raises, or 0 rows under RLS; the row is kept | — |
| Options | Staff calls `department_options()` | id and name of every department; no manager ids | — |

</intent-contract>

## Code Map

- `src/server/assignments-store.ts`: the store pattern to copy (`read` and `write` helpers, `refused()` code mapping, `managedEmployeeIds`, `listFor` role branches, typed errors); `toAssignment` gains `provenance`.
- `src/server/assignment-evaluations-store.ts`: the newest store; it has the CRLF/trim helpers and is closest in style.
- `src/server/assignment-evaluation-actions.ts`: zod `field()`, the `refusal()` mapping, CRLF normalization, revalidate.
- `src/server/session.ts`: `SessionIdentity`. Staff always have `employeeId`; check which admin and manager identities carry it.
- `src/server/employees-store.ts`: compose `backfilledProjects` in the same way as `assignments` and `evaluations` (inject `backfilled: Pick<BackfilledProjectStore,"listFor">`; default wiring at the bottom).
- `src/data/employees.ts`: the `Assignment` and `AssignmentEvaluation` types and the `Employee` fields; the fixture defaults (`assignments: []`, `evaluations: []`) get `backfilledProjects: []`.
- `src/app/page.tsx`: the staff branch passes `departmentOptions` (read through the store) to `StaffAttendance`. If the options are unavailable, the add form shows a clear unavailable message rather than an empty select.
- `src/components/staff-attendance.tsx`: the "My assignments" section from 4.6 (`MyAssignments`). Add the backfill list and forms here.
- `src/components/assignments-panel.tsx`: the history list. Merge in `backfilledProjects` with the markers; backfilled rows are read-only (no `ClosedEvaluation` form).
- `src/domain/dates.ts`: `isCalendarDate`, `formatDisplayDate`. Add a pure `todayInDhaka(now = new Date())` if none exists (`DHAKA_PARTS` is there).
- `supabase/migrations/20261016000000_assignment_evaluations.sql` and `20261014030000_assignments.sql`: the guard, no-delete trigger and policy style. `20261014020000_manager_scope.sql`: `manages_employee`, and the revoke/grant pattern for functions.
- Tests to copy: `tests/assignment-evaluations-store.test.ts`, `tests/assignment-evaluation-actions.test.ts`, `tests/assignment-evaluations-rls.test.ts` (live, fixed slots; use a new slot range such as BS-9160..9183), `tests/assignments-single-writer.test.ts`, `tests/e2e/assignment-evaluations.spec.ts` (fixed subject; use BS-9192), `tests/components/portal.test.tsx`, `tests/components/staff-attendance.test.tsx`, `tests/employees-store.test.ts`, `tests/page.test.tsx`.

## Tasks & Acceptance

**Execution:**
1. `supabase/migrations/20261016010000_backfilled_projects.sql`: the table, index, guard, no-delete trigger, policies and `department_options()` (ADDITIVE). The header explains each choice.
2. `src/data/employees.ts`: the `BackfilledProject` type, `Assignment.provenance`, and `Employee.backfilledProjects`.
3. `src/server/backfilled-project-store.ts` + `tests/backfilled-project-store.test.ts`: every matrix row at the store level, using a fake client and an injected scope.
4. `src/server/backfill-actions.ts` + `tests/backfill-actions.test.ts`: the session gate, zod, CRLF, and error mapping.
5. `src/server/employees-store.ts`, `src/server/assignments-store.ts`, `src/app/page.tsx` + `tests/employees-store.test.ts`, `tests/page.test.tsx`: composition, provenance and the department options. Existing tests stay green; update fixtures for the new fields.
6. `src/components/staff-attendance.tsx` + `tests/components/staff-attendance.test.tsx`: add, edit and withdraw, withdrawn rows marked, and refused values kept.
7. `src/components/assignments-panel.tsx` + `tests/components/portal.test.tsx`: the mixed history with "Manager-created"/"Self-reported" and "Withdrawn" text labels, and no write controls on backfilled rows.
8. `tests/backfill-single-writer.test.ts`: only `backfilled-project-store.ts` under `src/` writes `backfilled_projects`.
9. `tests/backfill-rls.test.ts` (live). Actors: an owner, another Staff member, an admin and a manager over the owner. Assert:
   - own insert, update and withdraw work;
   - another Staff member reads 0 rows and is refused writes (42501 on insert, 0 rows on update);
   - the admin and the manager can read but get 0 rows on update and 42501 on insert;
   - an unknown department gives 23503;
   - changing a withdrawn row gives 23514, and so does a locked field;
   - a service-role delete raises;
   - `department_options()` returns id and name only.
10. `tests/e2e/backfill.spec.ts`: a throwaway Staff member adds, edits and withdraws a past project; a throwaway manager (or the admin) sees it marked "Self-reported" and "Withdrawn", with no edit control.
11. `docs/DEPLOYMENT.md`: add the migration to the apply list (no seed change).

**Acceptance Criteria:**
- Given a Staff member in their portal, when they add a past project, then it appears under "My assignments" with its department name and a "Self-reported" marker.
- Given the Administrator on that employee's Current work tab, when the history renders, then each row says "Manager-created" or "Self-reported", and backfilled rows offer no edit, withdraw or evaluation control.
- Given a withdrawn entry, when the owner reopens the portal, then it is listed with "Withdrawn" and offers no controls.

## Spec Change Log

## Review Triage Log

## Design Notes

`department_options()` exists because the `departments` table holds `manager_user_id` and is admin- and manager-only (4.1/4.3). A SECURITY DEFINER function that exposes only id and name gives Staff the list to pick from without widening the table's RLS.

Writes are owner-only at both layers (FR-8: "only the owner can"). The owner identity always comes from the session (`session.employeeId`) and the `auth.uid()` link, never from the form. Any session with an `employeeId` may write its own entries. The UI for managers and Administrators comes in 4.10 ("My record"); in 4.7 the forms appear only in the staff portal.

Assumptions (conservative, recorded): the completion date may not be in the future, since this is a past project; withdrawn entries are shown to the admin and managers, marked; text limits are 200 characters for client and project, and 2000 for the outcome.

## Verification

**Commands:**
- `npm run typecheck`: no errors.
- `npm test`: all pass, except the live DB tests that need the 4.1–4.7 migrations. Those may fail only with 42P01, 42703, 42883, PGRST202, PGRST204 or PGRST205.
- `npm run build`: success.
- e2e with Chromium, using a local uncommitted config that sets `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"` and `channel: undefined` (run with `npx playwright test -c <that config>`, then delete it): pass, or fail only with the same schema-missing errors.

**Manual checks:**
- The migration does no `alter` or `drop` of existing objects, has no delete policy and no admin or manager write policy, and its header says ADDITIVE.
