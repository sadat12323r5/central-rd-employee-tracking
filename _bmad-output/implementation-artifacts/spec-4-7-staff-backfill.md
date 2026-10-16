---
title: 'Story 4.7: Staff backfills a past project'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_revision: 'f8987f64f080616a99d0cfdfbf3176b02745021c'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-6-assignment-evaluation.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Managers and employee-linked Administrators can write their own backfilled entries at the store, but have no UI, and their own entries may fall outside their list scope.
    evidence: |-
      The store allows any session with an employeeId; page.tsx only gives Staff the form. Story 4.10 ("My record") owns this.
    location: >-
      src/server/backfilled-project-store.ts
    severity: low
  - summary: >-
      Live and e2e test rows in backfilled_projects accumulate, because nothing can be deleted.
    evidence: |-
      Each run inserts new rows tagged by run id; there is no delete path.
    location: >-
      tests/backfill-rls.test.ts
    severity: low
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

### 2026-10-16 — Review pass
- verdicts: 30 findings — high 0, medium 4, low 24, false 2, maybe-false 0
- findings:
  - blind-hunter
    - `[medium]` `[patch]` The no-future-date rule is store-only, so a direct PostgREST write accepts future dates — guard raises 23514; live assertion added.
    - `[low]` `[patch]` No index on `department_id` — added.
    - `[medium]` `[patch]` One withdraw state is shared by all entries (every button disabled, message shown away from its entry) — per-entry action state.
    - `[low]` `[reject]` Withdraw has no confirmation — consistent with 4.5's close, which also has none; adding confirm dialogs is new UX across the app.
    - `[low]` `[patch]` Edits leave no trace for managers — the management row shows "Edited D MMM YYYY"; full version history is not required by FR-8.
    - `[low]` `[defer]` Managers and employee-linked Administrators can write at the store but have no UI, and a manager's own entries may be out of their list scope — 4.10 ("My record") owns this.
    - `[medium]` `[patch]` A backfilled department outside the manager's subtree shows a fallback label — the store attaches `departmentName` from `department_options()`.
    - `[low]` `[patch]` Heading/list label mismatch — renamed to "Work history".
    - `[low]` `[reject]` 23503 always maps to the department message — the employee FK cannot fail, because the owner comes from the session's own existing row.
    - `[low]` `[reject]` Redundant validation and rpc calls — minor duplication with no user-visible harm.
    - `[low]` `[patch]` DEPLOYMENT.md omissions — documented.
    - `[low]` `[patch]` Missing tests — covered by the patches above (future date, per-entry withdraw).
  - edge-case-hunter
    - `[medium]` `[patch]` Future date at the database — duplicate; same fix.
    - `[low]` `[patch]` Withdrawal can rewrite content in the same request — the guard refuses content changes on active→withdrawn.
    - `[low]` `[reject]` A 42501 on add shows the forbidden message — needs an employee whose row isn't linked to auth.uid() while the session carries its id, which session building rules out.
    - `[low]` `[defer]` A manager can add entries with no UI — duplicate of the 4.10 defer.
    - `[low]` `[reject]` Withdraw confirmation — duplicate.
    - `[medium]` `[patch]` Department name lost when options are null — duplicate; `departmentName` comes from the store.
    - `[medium]` `[patch]` The AC "appears with its department name" — same fix.
    - `[low]` `[defer]` Manager-authored entries — duplicate of the 4.10 defer.
  - verification-gap
    - `[low]` `[patch]` The empty-departments branch is never asserted — test added.
  - intent-alignment
    - `[low]` `[reject]` An unlinked Administrator gets the "no employee" message, not forbidden — the matrix's "No employee (e.g. unlinked Administrator)" row settles it.
    - `[low]` `[patch]` The withdraw control sits inside the Edit `<details>` — moved outside, as the spec says.
    - `[false]` `[reject]` Mixed-history ordering lives in the component — the order is tested at both the store and component surfaces, and both agree.
    - `[low]` `[defer]` Manager self-backfill below the UI — duplicate of the 4.10 defer.
    - `[low]` `[defer]` Test rows accumulate (no deletes) — same as 4.5/4.6.
    - `[false]` `[reject]` Strict refusal of no-op updates on withdrawn rows — this is the intended "any change to a withdrawn row".
    - `[low]` `[reject]` "Manager-created" is shown on admin-created assignments — the intent fixes these two labels.
    - `[low]` `[reject]` The staff list is not mixed — mixing is only required in the management view.
    - `[low]` `[reject]` The admin linked-employee forbidden path is untested — Administrator sessions carry no `employeeId` today, so the path is unreachable.

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

## Auto Run Result

Status: done

**Summary:** a new employee-authored `backfilled_projects` table, created by the ADDITIVE migration `20261016010000_backfilled_projects.sql`.
- **Guard rules:** the guard refuses future completion dates, changes to withdrawn rows, content changes made while withdrawing, and edits to locked fields. A separate trigger blocks every delete. RLS lets only the owner write; the admin, managers and the owner can read.
- **`department_options()`:** a SECURITY DEFINER function that returns only department ids and names, so Staff have a list to pick from.
- **Code:** a single-writer store (`backfilled-project-store.ts`) and actions (`backfill-actions.ts`).
- **Staff portal:** add, edit and withdraw controls inside "My assignments".
- **Management portal:** the Current work "Work history" mixes closed assignments with past projects. Each row carries a materialized marker: "Manager-created" or "Self-reported", plus "Withdrawn" or "Edited" where they apply.

**Review:** one pass, 30 findings.
- **Patched:** 4 medium and 10 low. The changes:
  - the database refuses future dates and content changes made during withdrawal;
  - an index on `department_id`;
  - each entry gets its own withdraw state, with the withdraw control outside the Edit disclosure;
  - department names come from the store;
  - "Work history" heading and the "Edited" marker;
  - DEPLOYMENT.md notes and tests.
- **Deferred:** 2, recorded in frontmatter.
- **Rejected:** the rest, with reasons in the triage log.

**Follow-up review recommended:** true. This pass patched 4 medium findings. The unverified risk is the new guard rules (future date, withdraw-only transition). They were checked only on a scratch Postgres 16 and in live tests that cannot run until the migrations are applied. A follow-up pass after the migrations land should confirm `tests/backfill-rls.test.ts` passes.

**Verification:**
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 1235 passed, 54 skipped. 5 live RLS files fail, all with PGRST205.
- e2e on Chromium: 8 passed, 21 failed. Every failure is a schema-missing error: PGRST205, PGRST202 (`department_options` missing) or 42703.
