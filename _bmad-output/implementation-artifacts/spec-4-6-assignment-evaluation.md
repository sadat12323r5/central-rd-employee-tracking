---
title: 'Story 4.6: Manager evaluates a closed assignment; employee sees it'
type: 'feature'
created: '2026-10-16'
status: 'in-review'
baseline_revision: '6df80d84bbc0c41b66e8877c72ceea93e3d7d660'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-5-manager-assignments.md'
warnings: ['oversized']
deferred: []
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

## Review Triage Log

## Design Notes

Authority follows the **assignment's** stored department (AD-4: "the Assignment's Department's own manager, plus every ancestor…"), not the employee's current department. That is why the evaluation copies `department_id` from the assignment and the policies use `manages_department(department_id)`. After a 4.8 transfer, the manager who ran the work can still evaluate it. Read access also includes `manages_employee`, so the employee's current manager sees their history (PRD FR-9).

AD-4 makes evaluations upsert-with-authorship, not insert-once. The epic AC still forbids a second record, so there are two entry points: `create`, which refuses when one exists, and `amend`. `created_by` keeps the first author. `authored_by` and `updated_at` are the latest writer, so an amendment by another manager is recorded without an extra history table.

Assumptions, which are conservative and recorded so the owner can revisit them: the evaluation is limited to 4000 characters and client feedback to 2000; client feedback may be cleared on amend; an evaluation can be written for an archived employee's assignment.

## Verification

**Commands:**
- `npm run typecheck`: no errors.
- `npm test`: all pass, except the live DB tests that need the 4.1–4.6 migrations. Those may fail only with 42P01, 42703, 42883, PGRST202, PGRST204 or PGRST205.
- `npm run build`: success.
- e2e with Chromium, via a local uncommitted config that sets `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"` and `channel: undefined` (run as `npx playwright test -c <that config>`): pass, or fail only with the same schema-missing errors.

**Manual checks:**
- The migration has no `alter` or `drop` of existing objects and no delete policy, and its header says ADDITIVE.
