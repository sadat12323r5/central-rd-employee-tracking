---
title: 'Story 4.6: Manager evaluates a closed assignment; employee sees it'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_revision: '6df80d84bbc0c41b66e8877c72ceea93e3d7d660'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-5-manager-assignments.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An amendment overwrites the earlier evaluation text; no version history is kept.
    evidence: |-
      AD-4 specifies upsert-with-authorship, which keeps created_by and authored_by but not the earlier wording. Keeping full versions needs a System Owner decision.
    location: >-
      supabase/migrations/20261016000000_assignment_evaluations.sql
    severity: medium
  - summary: >-
      Story 4.8: hide the evaluation form from a current-department manager who has no authority over the assignment's department.
    evidence: |-
      ClosedEvaluation shows the form on every closed row. This is unreachable until transfers exist, because the assignment's department and the employee's department are equal today.
    location: >-
      src/components/assignments-panel.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Closed assignments (Story 4.5) carry no record of how the work went, so neither the L&D manager nor the employee has an evaluation or the client's feedback on the service. The employee also cannot see their own assignment history at all.

**Approach:** Add a separate `assignment_evaluations` table (one row per closed assignment, AD-2), with a single writer, `assignment-evaluations-store.ts`. Anyone with authority over the **assignment's** department, meaning its manager chain plus every Administrator (AD-4), may write it once and then amend it. Every write records who wrote it and when. The management portal's assignment history gets an evaluation view and a write/amend form. The staff portal gets a read-only "My assignments" section that shows the history and evaluations.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261016000000_assignment_evaluations.sql` is **ADDITIVE**. It adds a new table, a unique index, a guard function and triggers, and policies. Nothing existing is altered.
  - Columns:
    - `id uuid pk default gen_random_uuid()`
    - `assignment_id uuid not null references assignments on delete restrict`, with a unique index `assignment_evaluations_one_per_assignment`
    - `employee_id text not null`, `department_id uuid not null`: both copied from the assignment
    - `evaluation text not null`, trimmed, 1–4000 characters
    - `client_feedback text not null default ''`, at most 2000 characters
    - `created_by uuid not null`, `created_at timestamptz not null default now()`
    - `authored_by uuid not null`, `updated_at timestamptz not null default now()`
  - `assignment_evaluations_guard()` is plpgsql, `security definer`, `set search_path = ''`, and runs BEFORE INSERT OR UPDATE.
    - **On insert:** it raises 23514 unless the assignment exists with `status = 'closed'`. It sets `employee_id` and `department_id` from the assignment, whatever the caller sent. It sets `created_by := coalesce(auth.uid(), new.created_by)`, `authored_by := created_by`, and `created_at = updated_at = now()`.
    - **On update:** it raises 23514 on any change to `id, assignment_id, employee_id, department_id, created_by, created_at`. It sets `authored_by := coalesce(auth.uid(), new.authored_by)` and `updated_at := now()`.
  - A BEFORE DELETE trigger always raises. It binds the service role too.
  - Policies, all `to authenticated`:
    - **select:** admin JWT role, OR `manages_department(department_id)`, OR `manages_employee(employee_id)`, OR the own row (`employees.auth_user_id = auth.uid()`, as in `assignments_select_own`).
    - **insert and update:** admin, OR `manages_department(department_id)`, in both `using` and `with check`.
    - No delete policy.
- **Store** `src/server/assignment-evaluations-store.ts` follows the `AttendanceStore` shape: `createAssignmentEvaluationsStore({ userClient, scope = managerScope })`.
  - `listFor(session, employeeId?)` scopes reads the same way as `assignments-store.listFor`. A manager sees rows whose `department_id` is in `scope.departmentIds` or whose `employee_id` is in `scope.employeeIds`.
  - `create(session, assignmentId, input)`:
    - reads the assignment, and refuses one that is missing or invisible;
    - refuses an open assignment with `EvaluationAssignmentOpenError`, and never writes `assignments`;
    - authorizes the session;
    - refuses with `EvaluationExistsError` when an evaluation already exists (a store pre-check, plus 23505 from the database);
    - then inserts.
  - `amend(session, assignmentId, input)` updates the existing row. It throws `EvaluationNotFoundError` when there is none.
  - Authority: admin always. A manager only when `scope.forManager(session).departmentIds` has the **assignment's** `department_id`. Staff never (`EvaluationForbiddenError`).
  - Input: `evaluation` trimmed, 1–4000 characters; `clientFeedback` trimmed, 0–2000 characters (`EvaluationInvalidError`). Database errors map to `EvaluationsUnavailableError`.
  - The subject `employee_id` always comes from the assignment row. The author always comes from the session JWT, through the trigger.
- **Type** `AssignmentEvaluation` is `{ id, assignmentId, employeeId, departmentId, evaluation, clientFeedback, createdBy, createdAt, authoredBy, updatedAt }`, exported from `src/data/employees.ts`. `Employee` gains `evaluations: AssignmentEvaluation[]`. `Assignment` gains no fields.
- **Actions** `src/server/assignment-evaluation-actions.ts`: `createEvaluationAction` and `amendEvaluationAction`.
  - Each one checks the session (admin or manager) first, then validates with zod, calls the store, runs `revalidatePath("/")`, and returns `{ error, message }`.
- **Display of authorship:** "Written by X on D MMM YYYY". When the evaluation was amended, add "· amended by Y on D MMM YYYY". Names are resolved where available (an account linked to an employee name); otherwise show "a manager" for managers and "the Administrator" for the admin. Never show raw uuids.
- Live DB tests follow 4.5's patterns: sign in once per file, `{ defaultToNull: false }` on bulk inserts, fixed throwaway records, and no deletes (rows can't be deleted).

**Never:**
- No evaluation-shaped fields on `assignments`, and no write to `assignments` from the evaluations store (AD-2). Never force-close an assignment.
- No score or rating field, and no aggregation. No backfill (4.7), no transfer (4.8), no export (8.4).
- No delete path. Staff never write evaluations, including on their own assignments.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Write | Admin, or a manager over the assignment's department; closed assignment, no evaluation | Saved, with created_by = authored_by = the writer and timestamps set | "Evaluation saved." |
| Amend by another manager | An evaluation exists; a different authorized account amends it | Text updated; authored_by and updated_at = the amender; created_by kept | "Evaluation updated." |
| Second record | An evaluation already exists; create is called again | Rejected at the store; the database index also rejects it (23505) | "This assignment already has an evaluation. Amend it instead." |
| Open assignment | Create on an open assignment | Rejected; the assignment stays open | "Close the assignment before evaluating it." |
| Staff | Any write action, or a direct insert/update with a Staff JWT, own assignment included | Rejected; RLS denies | "Only the Administrator or a manager over this assignment's department can evaluate it." |
| Out of scope | A manager whose subtree excludes the assignment's department | Rejected at the store and by RLS | Same forbidden message |
| Invalid | Empty evaluation, over 4000 characters, or feedback over 2000 characters | Rejected | Field message |
| Amend missing | Amend when no evaluation exists | Rejected | "Write the evaluation first." |
| Locked fields | Changing assignment_id, employee_id, department_id or created_by (direct DB too) | 23514 | Maps to `EvaluationInvalidError` |
| Delete | Any role, service role included | Raises, or matches 0 rows under RLS; the row is kept | — |
| Own read | Staff JWT | Their own evaluations only; none of anyone else's | — |
| Staff view | The employee opens their portal | "My assignments": open plus history, each closed row with its evaluation and client feedback, read-only (no form or button) | "Not evaluated yet." when none |

</intent-contract>

## Code Map

- `src/server/assignments-store.ts`: the pattern to copy (`read` and `write` helpers, `refused()` code mapping, `managedEmployeeIds`, `target`, `listFor` role branches, typed errors). Reuse `AssignmentRow` and `COLUMNS` for the assignment lookup (read only).
- `src/server/manager-scope.ts`: `forManager` returns `departmentIds` and `employeeIds`. Map `ManagerScopeUnavailableError` to `EvaluationsUnavailableError`.
- `src/server/assignment-actions.ts`: the zod `field()`, `refusal()` and `managingSession` patterns, and `ActionState` from `attendance-actions.ts`.
- `src/server/employees-store.ts:120-134,171-253`: compose `evaluations` the same way as `assignments` (inject `evaluations: Pick<AssignmentEvaluationsStore,"listFor">`). A failure gives `EmployeesUnavailableError`. Default wiring is at `:263`.
- `src/data/employees.ts:6-40,177`: the `Assignment` type, the `Employee.assignments` field, and the fixture default `assignments: []`. Add `evaluations: []`.
- `src/components/assignments-panel.tsx`: the history `<li>`. Add the evaluation (text, client feedback, authorship) and a create/amend form (`<details>` or inline). It is keyboard-operable and keeps refused values, like the 4.5 forms.
- `src/components/portal.tsx:175`: pass `selected.evaluations` (and a name resolver for authorship) to `AssignmentsPanel`.
- `src/components/staff-attendance.tsx:114+`: add a read-only "My assignments" section, with Open/Closed text labels and `D MMM YYYY` dates (`formatDisplayDate`).
- `src/server/session.ts`: `SessionIdentity` and `ManagerIdentity` (`userId`). Authorship names can be resolved from the employees list (`auth_user_id`), or fall back to role words.
- `supabase/migrations/20261014030000_assignments.sql`: the guard, no-delete trigger and policy style to copy. `20261014020000_manager_scope.sql`: `manages_department` and `manages_employee`.
- Tests to copy: `tests/assignments-store.test.ts` (fake client), `tests/assignment-actions.test.ts`, `tests/assignments-rls.test.ts` (live, fixed throwaway slots), `tests/assignments-single-writer.test.ts`, `tests/e2e/assignments.spec.ts`, `tests/components/portal.test.tsx`, plus the staff portal component tests, and `tests/employees-store.test.ts` and `tests/page.test.tsx` for the composition.

## Tasks & Acceptance

**Execution:**
1. `supabase/migrations/20261016000000_assignment_evaluations.sql`: the table, unique index, guard, no-delete trigger and policies (ADDITIVE). The header comment explains why.
2. `src/data/employees.ts`: the `AssignmentEvaluation` type, plus `Employee.evaluations` with a default of `[]`.
3. `src/server/assignment-evaluations-store.ts` + `tests/assignment-evaluations-store.test.ts`: every row of the matrix at the store level, using a fake client and an injected scope.
4. `src/server/assignment-evaluation-actions.ts` + `tests/assignment-evaluation-actions.test.ts`: the session gate, zod, and error mapping.
5. `src/server/employees-store.ts` + `tests/employees-store.test.ts`, `tests/page.test.tsx`: compose evaluations for every role; existing tests stay green.
6. `src/components/assignments-panel.tsx`, `src/components/portal.tsx` + `tests/components/portal.test.tsx`: the evaluation view and the write/amend form on closed rows only. There is no form on the open assignment.
7. `src/components/staff-attendance.tsx` + its component test: the read-only "My assignments" section, with no form controls in it.
8. `tests/assignments-single-writer.test.ts`: extend it so the evaluations store never writes to `assignments`. Add `tests/assignment-evaluations-single-writer.test.ts`: only `assignment-evaluations-store.ts` under `src/` writes `assignment_evaluations`.
9. `tests/assignment-evaluations-rls.test.ts` (live): an admin, a parent manager, a child manager, an out-of-scope manager, the owning Staff member and another Staff member. Assert:
   - scoped select, and Staff reading their own rows only;
   - insert on an open assignment gives 23514;
   - a second insert gives 23505;
   - a Staff write is refused;
   - a parent-manager amend changes `authored_by` and keeps `created_by`;
   - locked fields give 23514;
   - a service-role delete raises.
10. `tests/e2e/assignment-evaluations.spec.ts`: a throwaway manager closes a throwaway assignment, writes an evaluation with client feedback, and amends it. The linked throwaway Staff member sees it read-only in "My assignments".
11. `docs/DEPLOYMENT.md`: add the migration to the apply list (no seed change).

**Acceptance Criteria:**
- Given an authorized manager on a closed assignment in the Current work history, when they write an evaluation with client feedback, then it shows with "Written by … on D MMM YYYY", and the form becomes "Amend evaluation".
- Given the open assignment, when the Current work tab renders, then no evaluation form is offered for it.
- Given a Staff member with a closed, evaluated assignment, when they open their portal, then "My assignments" shows it with the evaluation and client feedback, and the section has no input, textarea or button.
- Given a Staff JWT, when it inserts or updates `assignment_evaluations` directly through PostgREST, then RLS refuses it.

## Spec Change Log

### 2026-10-16: review pass 1 (bad_spec: authorship display)
- **Trigger:** the review found that author names were worked out at display time from whoever currently manages a department in the viewer's list. A manager whose employee row the viewer can't see showed as "the Administrator", which is the wrong author. An Administrator who manages nothing, or a replaced manager, showed as "a manager or the Administrator". Staff always saw the anonymous phrase. The same evaluation also showed different authors to different viewers.
- **Amended:** Code Map and Design Notes. The writer's display name and role are now captured on each write (see "Authorship snapshot" below), and the display reads only those stored values.
- **Known-bad state avoided:** the author label depending on the viewer and on later manager changes; the guessed "the Administrator".
- **KEEP:** everything else in the implementation is kept as is: the migration's table, guard, policies and no-delete trigger, the store, the actions, the forms (including keeping refused values), the staff "My assignments" section, and all tests. This is a delta, not a re-derivation. Only the authorship resolution changes, plus the review patches listed in the triage log.

## Review Triage Log

### 2026-10-16 — Review pass 2
- verdicts: 33 findings — high 0, medium 3, low 26, false 1, maybe-false 0 (7 intent-audit notes are counted as low or reject)
- findings:
  - blind-hunter
    - `[low]` `[reject]` In `create`, the open check runs before authorize, so a manager who can read the assignment but not write it learns its state — that is the order the intent sets, and that manager can already see the assignment's status in the portal.
    - `[low]` `[defer]` carried: a write form is shown to a manager without authority over the assignment's department — deferred to 4.8.
    - `[low]` `[patch]` The post-transfer write path can't be reached from the portal — the migration header and DEPLOYMENT.md now say plainly that this path is database/store-only until 4.8 (the 4.8 defer already covers the UI).
    - `[medium]` `[defer]` carried: an amendment replaces the earlier text with no history.
    - `[low]` `[reject]` carried: saving without a change still counts as an amendment.
    - `[low]` `[reject]` The character limits are repeated in the client — cosmetic duplication; the SQL checks are the backstop.
    - `[false]` `[reject]` carried: "My assignments" isn't ordered — the store already sorts with `compareAssignments`.
    - `[low]` `[patch]` Every evaluation region has the same accessible name — the name now includes the project.
    - `[low]` `[patch]` `employee_id` and `department_id` have no foreign keys — added; the trim CHECK is rejected as before (carried).
    - `[low]` `[reject]` `auth.jwt()` is not wrapped in a select — this matches every existing policy in the repo; a performance tweak is out of scope.
    - `[low]` `[patch]` The RLS refusal assertions are weak — they now assert 42501.
    - `[low]` `[reject]` `formatDisplayDay` duplicates the date-time helper's body — small, tested duplication.
    - `[low]` `[patch]` DEPLOYMENT.md and the migration header leave things out — fixed together with the transfer-path note.
    - `[low]` `[patch]` Trailing whitespace in two test files — removed.
  - edge-case-hunter
    - `[low]` `[defer]` carried: the form is shown after a transfer.
    - `[low]` `[reject]` The open check runs before authorize — duplicate of the blind-hunter row.
    - `[medium]` `[patch]` A manager, or an employee-linked Administrator, can evaluate their own assignment, though 4.10 says read-only evaluations apply to one's own record — the store refuses it and the insert/update policies exclude the writer's own employee.
    - `[low]` `[reject]` carried: a no-op amend.
    - `[low]` `[reject]` An evaluation made only of zero-width characters — far-fetched for an internal tool used by managers.
    - `[low]` `[reject]` `.in()` URL length for very large subtrees — the same pattern as 4.3/4.5; the departments are a handful.
    - `[low]` `[reject]` An unknown action error reaches the error boundary — the same convention as every other action in the repo.
    - `[low]` `[patch]` The transfer path is unreachable from the portal (claim) — duplicate; documented.
  - verification-gap
    - no gaps; other finding: the transfer path is unreachable from the portal — `[low]` `[patch]`, duplicate; documented.
  - intent-alignment
    - `[low]` `[reject]` Extra snapshot columns and indexes (A2) — the pass-1 spec amendment adds them for the intent's display rule.
    - `[low]` `[reject]` A new policy on `assignments` (B2) — additive; the header now says so.
    - `[low]` `[reject]` Write-time snapshot rather than read-time resolution (C2) — chosen in pass 1, because read-time resolution depends on the viewer.
    - `[low]` `[reject]` Store ordering and error differences — no outcome in the matrix changes.
    - `[low]` `[reject]` Transfer infrastructure added ahead of 4.8 — needed for AD-4 at the database; small and additive.
    - `[low]` `[reject]` The 23514 mapping is tested only with faked errors — by design.
    - `[low]` `[reject]` An own-author amendment shows "amended by" — accurate: the text was changed later.

### 2026-10-16 — Review pass 1
- verdicts: 27 findings — high 0, medium 4, low 17, false 2, maybe-false 0 (4 more are descriptive intent-audit notes and are logged below as reject)
- findings:
  - blind-hunter
    - `[medium]` `[patch]` A department manager can't evaluate pre-transfer work, because the assignments read RLS uses manages_employee — fixed by an additive `assignments_select_department_managed` policy. The path is only reachable once 4.8 ships.
    - `[low]` `[defer]` A write form is shown to a current-department manager who lacks authority over the assignment's department — unreachable until 4.8 transfers exist (the departments are always equal today). Deferred to 4.8.
    - `[low]` `[patch]` A refused create (already exists) leaves the form stuck in create mode — the action now revalidates on Exists/NotFound refusals.
    - `[medium]` `[defer]` An amendment overwrites the earlier text with no version history — AD-4 specifies upsert-with-authorship. A full version history is a stakeholder decision. Deferred.
    - `[medium]` `[bad_spec]` Author names are unstable and depend on the viewer; a manager can be guessed as "the Administrator" — the spec is amended with an authorship snapshot (name and role captured on write).
    - `[medium]` `[bad_spec]` Staff never see who evaluated them — same root cause; the snapshot gives Staff the same text.
    - `[false]` `[reject]` The staff assignment list isn't ordered — `assignments-store.listFor` sorts with `compareAssignments` and `assignmentsOf` keeps that order.
    - `[low]` `[patch]` No index on `department_id` — index added.
    - `[low]` `[reject]` `client_feedback` has no trim CHECK — the app always trims; adding a database-level check is extra code for a service-role-only path.
    - `[low]` `[reject]` 23514 on create shows an amend-style message — this needs an assignment reopened or removed between the store's read and the insert, and assignments can't be reopened or deleted.
    - `[low]` `[patch]` The live tests don't cover the department-vs-employee split — a transfer case was added (see verification-gap).
    - `[low]` `[patch]` The single-writer test name no longer matches its claim — renamed/tightened.
  - edge-case-hunter
    - `[medium]` `[patch]` The post-transfer manager is refused — duplicate of the first blind-hunter row; same fix.
    - `[medium]` `[bad_spec]` A sub-manager whose employee row is invisible shows as "the Administrator" — fixed by the snapshot.
    - `[low]` `[patch]` CRLF newlines push text over the server's length limits — newlines are normalized before validation.
    - `[low]` `[patch]` A stale create/amend form mode — duplicate; same revalidate fix.
    - `[low]` `[reject]` A no-op amend bumps `updated_at` — an explicit save by an authorized manager is a write, and recording it is correct.
    - `[medium]` `[patch]` The transfer claim (same root cause as the first row) — same fix.
  - verification-gap
    - `[low]` `[patch]` No live RLS case where the employee's current department differs from the assignment's department — added the transfer case to `tests/assignment-evaluations-rls.test.ts`.
    - `[medium]` `[bad_spec]` (other finding) "the Administrator" is a wrong label when the manager's employee row is hidden — same snapshot fix.
  - intent-alignment
    - `[medium]` `[bad_spec]` The authorship display uses viewer visibility (A2) and introduces a third string, rather than the intent's two role words — fixed by the snapshot, which implements reading A1.
    - `[low]` `[reject]` The insert policy has `with check` only — Postgres INSERT policies can't take `USING`; B1 is the only valid reading.
    - `[low]` `[defer]` The authority-after-transfer path is not exercised end to end — covered at the database level by the new RLS case; the UI path waits on 4.8.
    - `[false]` `[reject]` `create` refuses Staff and invalid input before reading the assignment — extra early checks don't change any outcome in the matrix.
    - `[low]` `[reject]` An extra `employee_id` index — additive and harmless.
    - `[low]` `[reject]` Every employee read now also reads evaluations (unavailable before the migration) — the same composition as 4.5, documented in DEPLOYMENT.md.
    - `[low]` `[reject]` The locked-field 23514 mapping is only reachable through a direct database call — by design, since the store never sends locked fields.

## Design Notes

Authority follows the **assignment's** stored department (AD-4: "the Assignment's Department's own manager, plus every ancestor…"), not the employee's current department. That is why the evaluation copies `department_id` from the assignment and the policies use `manages_department(department_id)`. After a 4.8 transfer, the manager who ran the work can still evaluate it. Read access also includes `manages_employee`, so the employee's current manager sees their history (PRD FR-9).

AD-4 makes evaluations upsert-with-authorship, not insert-once. The epic AC still forbids a second record, so there are two entry points: `create`, which refuses when one exists, and `amend`. `created_by` keeps the first author. `authored_by` and `updated_at` are the latest writer, so an amendment by another manager is recorded without an extra history table.

Assumptions, which are conservative and recorded so the owner can revisit them: the evaluation is limited to 4000 characters and client feedback to 2000; client feedback may be cleared on amend; an evaluation can be written for an archived employee's assignment.

**Authorship snapshot (review pass 1).**
- **Columns:** four new columns on `assignment_evaluations`:
  - `created_by_name text null` and `authored_by_name text null`;
  - `created_by_role text not null` and `authored_by_role text not null`, each with `check in ('admin','manager')`.
- **The guard sets them on every write.**
  - The role is `'admin'` when `auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'`, otherwise `'manager'`.
  - The name is the `employees` name whose `auth_user_id = auth.uid()`, or null when no row is linked.
  - When `auth.uid()` is null (the service role), the values sent are kept. The role then defaults to `'admin'` if none is sent.
  - The created_* pair is locked on update, the same as `created_by`.
- **Display** (`src/domain/evaluations.ts`): the stored name if there is one. Otherwise "the Administrator" for `admin` and "a manager" for `manager`. Both portals, staff included, use the same text. The `authorNames` resolver built from the department list goes away.
- **`AssignmentEvaluation`** gains `createdByName`, `createdByRole`, `authoredByName`, `authoredByRole`.

**Transfer read path (review pass 1).**
- **New policy:** an additive select policy on `assignments`, `assignments_select_department_managed using (public.manages_department(department_id))`. Without it, after a 4.8 transfer the store's assignment read is hidden from the department manager who should be able to evaluate the work.
- **Index:** an index on `assignment_evaluations(department_id)`.

## Verification

**Commands:**
- `npm run typecheck`: no errors.
- `npm test`: all pass, except the live DB tests that need the 4.1–4.6 migrations. Those may fail only with 42P01, 42703, 42883, PGRST202, PGRST204 or PGRST205.
- `npm run build`: success.
- e2e with Chromium, via a local uncommitted config that sets `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"` and `channel: undefined` (run as `npx playwright test -c <that config>`): pass, or fail only with the same schema-missing errors.

**Manual checks:**
- The migration has no `alter` or `drop` of existing objects and no delete policy, and its header says ADDITIVE.

## Auto Run Result

Status: done

**Summary:** a new `assignment_evaluations` table, added by the ADDITIVE migration `20261016000000_assignment_evaluations.sql`.
- **The table:** one row per closed assignment, with a unique index and foreign keys. A guard trigger copies the employee and department from the assignment, records `created_by`/`authored_by` and a name/role snapshot on every write, and locks the identifying fields. A no-delete trigger blocks deletes. RLS covers the admin, the manager chain of the assignment's department and the employee's own rows; writes are refused on one's own record. A new additive select policy on `assignments` lets the assignment's department manager read it after a transfer.
- **Code:** a single-writer store (`assignment-evaluations-store.ts`) and actions (`assignment-evaluation-actions.ts`).
- **Management portal:** the Current work history shows each evaluation and a Write/Amend form. The open assignment gets no form.
- **Staff portal:** a read-only "My assignments" section with the evaluations.

**Files:** the migration; `src/server/assignment-evaluations-store.ts`, `src/server/assignment-evaluation-actions.ts`, `src/domain/evaluations.ts`, `src/components/evaluation-view.tsx` (new); `src/components/assignments-panel.tsx`, `portal.tsx`, `staff-attendance.tsx`, `src/server/employees-store.ts`, `src/server/assignments-store.ts` (exports the column list), `src/data/employees.ts`, `src/domain/dates.ts` (`formatDisplayDay`), `src/app/styles.css`, `docs/DEPLOYMENT.md`. Tests: the new store, actions, evaluations, single-writer, live RLS and e2e tests, plus updates to the existing ones.

**Review:** two passes.
- **Pass 1:** one bad_spec loop. The authorship snapshot replaced the viewer-dependent name resolver; it was applied as a delta with KEEP everything (see the Spec Change Log). Patches: the transfer read policy and its index, revalidating on stale refusals, CRLF normalization, the transfer RLS case, and the single-writer test name.
- **Pass 2:** patches: no evaluating one's own assignment (store and RLS), the foreign keys, documentation, distinct region names, 42501 assertions, and whitespace.
- **Deferred:** 2 (amendment history; the form shown after a 4.8 transfer).
- **Rejected:** the rest, with reasons in the triage log.

**Follow-up review recommended:** false. Pass 2 patched 1 medium and 5 low findings, and no high.

**Verification:**
- `npm run typecheck` passes and `npm run build` passes.
- `npm test`: 1156 passed and 43 skipped. Four live RLS files fail, only with PGRST205.
- e2e on Chromium (local `executablePath` override): 8 passed and 20 failed. Every failure comes from the schema-missing causes: PGRST205 or 42703, which surface as the "Employee records unavailable" or "Departments unavailable" page.
- The implementer also applied all 14 migrations to a scratch Postgres 16 and checked the guard and RLS rules there.

**Residual risk:** the database rules are verified only on a scratch database until the migrations are applied to the shared project.
