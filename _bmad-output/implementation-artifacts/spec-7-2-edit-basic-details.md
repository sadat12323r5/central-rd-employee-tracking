---
title: "Story 7.2: Edit an employee's basic details"
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '6dec410dfd264ee85e8d5dc7a9fb3dcb7b897fc4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-1-add-new-employee.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** After Story 7.1 an employee can be added, but their title, team, reporting manager, office and employment type can never change, so the directory drifts out of date.

**Approach:** An "Edit details" form on the employee profile for the Administrator (anyone) and department managers (employees in their subtree). A server action validates the five fields and calls a new `employeesStore.updateDetails()`, which pre-checks authority and calls a new SECURITY DEFINER Postgres function through the user's JWT. The function updates only those five columns, so a department (or any other column) can never change here. No update policy is added to `employees`.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261015010000_employee_details_update.sql`, ADDITIVE: one new function and its grants; nothing existing changes, and still no update policy on `employees`.
- `public.update_employee_details(p_employee_id text, p_title text, p_team text, p_manager text, p_office text, p_employment_type text) returns text`: `plpgsql`, `security definer`, `set search_path = ''`, fully qualified names; execute revoked from `public, anon`, granted to `authenticated`. In order:
  1. `auth.uid()` null → `not_authorized`.
  2. A caller whose own employee row (`auth_user_id = auth.uid()`) is archived → `not_authorized`.
  3. Caller is neither Administrator (`auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'`) nor `public.manages_employee(p_employee_id)` → `not_authorized` (before any lookup, so a non-admin learns nothing about ids outside scope).
  4. Each value trimmed with inner whitespace collapsed; any empty or longer than 120 chars, or employment type not in `('Permanent','Trainee','Intern')` → `invalid_input`.
  5. `select ... for update` the row; not found → `employee_not_found`.
  6. `update public.employees set title, team, manager, office, employment_type` (only these five) for that id; return the name.
  All errors `errcode = 'P0001'`.
- **Domain.** Reuse `normalizeText`, `TEXT_FIELD_MAX` and `EMPLOYMENT_TYPES` from `src/domain/employee-input.ts`; add `EmployeeDetailsInput` and `normalizeEmployeeDetails`/`invalidEmployeeDetailsFields` there.
- **Store.** `employeesStore.updateDetails(session, employeeId, input)` in `src/server/employees-store.ts`, via the per-request user client, never the service role:
  - Staff → `EmployeeForbiddenError` with no rpc.
  - Manager → `employeeId` must be in `scope.forManager(session).employeeIds`, else `EmployeeForbiddenError` with no rpc; scope failure → `EmployeesUnavailableError`.
  - Validates and normalises the input → `EmployeeValidationError(fields)`.
  - Maps rpc errors: `not_authorized` → `EmployeeForbiddenError`; `invalid_input` → `EmployeeValidationError(["details"])`; `employee_not_found` → `EmployeeNotFoundError` (new); else `EmployeesUnavailableError`. Returns `{ employeeId, name }`.
- **Action.** `updateEmployeeDetailsAction(prev, form)` in `src/server/employee-actions.ts`:
  - `getActor()`; only `admin`/`manager`, else "Only an Administrator or a department manager can edit employee details." before any store call.
  - If the form carries a `departmentId` (or `department`) field at all → "An employee's department can only change through a transfer." with no store call.
  - Zod-validates `employeeId` and the five fields (messages name the field); employment type must be one of the three values.
  - Success: `revalidatePath("/")`, "<Name>'s details were saved."
  - Errors: forbidden → manager: "You can only edit employees in your own department or its sub-departments."; admin: the unavailable message. Not found → "Choose an existing employee." Unavailable → "Employee records are temporarily unavailable. Nothing was changed."
- **UI.** New client component `src/components/employee-details-panel.tsx` on the profile Overview (`src/components/portal.tsx`) for `admin` and `manager` roles, prefilled with the employee's current title, team, reporting manager, office and employment type. Labelled inputs, a select for employment type, `aria-label="Edit employee details"` on the form, alert/status regions, keyboard operable. It has no department control and shows the department read-only with the note "Changes through a transfer." Keep entered values and focus after a refusal (follow add-employee-panel's `onSubmit` + `startTransition` pattern). Remount it per selected employee (`key`).
- Live DB tests sign each test user in once per file; bulk inserts pass `{ defaultToNull: false }`. Use test Employee IDs in a range no other file uses (BS-87xx; check `tests/`).

**Never:**
- No change to name, email, department, status, join date, summary, avatar, account link or archive state here.
- No update/insert/delete policy on `employees`; no service-role write on the runtime path.
- No change to Staff behaviour or to Story 7.1's add path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin edits | Any employee, valid five fields | Saved; other columns unchanged; profile shows new values | — |
| Manager edits in subtree | Employee in a department the manager manages or below | Saved | — |
| Manager outside subtree | Employee not in scope | Store refuses without rpc; function `not_authorized` on a direct call | scope message |
| Staff (incl. own record) | Staff session, action or direct rpc | Action refuses before store; function `not_authorized` | "Only an Administrator…" |
| Department change | Form carries `departmentId` | Rejected, nothing changed | transfer message |
| Direct table update | Manager or admin JWT `PATCH employees` | 0 rows changed (no update policy) | — |
| Invalid values | Blank, >120 chars, unknown employment type | Rejected at action, store and function | field message |
| Unknown employee | Admin, id that does not exist | Rejected | "Choose an existing employee." |
| Archived caller | Manager whose own row is archived calls the function directly | `not_authorized` | — |
| DB down | rpc or scope read fails | Nothing changed | unavailable message |

</intent-contract>

## Code Map

- `supabase/migrations/20261014020000_manager_scope.sql` -- `manages_employee(text)`; reuse. Header comment style.
- `supabase/migrations/20261015000000_employee_create.sql` -- Story 7.1 insert policies and header style; admin JWT check expression.
- `src/domain/employee-input.ts` -- `normalizeText`, `TEXT_FIELD_MAX`, `EMPLOYMENT_TYPES`, `invalidNewEmployeeFields` pattern.
- `src/server/employees-store.ts` -- `create()`, `insertRefusal`, error classes (`EmployeeForbiddenError`, `EmployeeValidationError`, `EmployeeExistsError`), injected `scope` and `userClient`; add `updateDetails` and `EmployeeNotFoundError` next to them.
- `src/server/employee-actions.ts` -- `createEmployeeAction` shape, messages, role-dependent forbidden mapping; add the new action here.
- `src/server/accounts-store.ts` (`createManagerAccessStore`) on `story/4-9` is NOT on this branch; mirror the rpc-error mapping style from `setArchived` in this file's `createAccountsStore` instead.
- `src/components/add-employee-panel.tsx` -- form pattern (onSubmit + startTransition, key only on success, alert/status).
- `src/components/portal.tsx` -- profile Overview grid; `role`, `isManager`, `departments` (for the read-only department name), selected employee fields (`title`, `team`, `manager`, `location`, `type`, `departmentId`).
- `tests/employees-store.test.ts`, `tests/employee-actions.test.ts`, `tests/components/add-employee-panel.test.tsx`, `tests/components/portal.test.tsx`, `tests/employee-create-rls.test.ts` -- patterns to extend or mirror.
- `tests/e2e/add-employee.spec.ts` -- e2e pattern with a throwaway department and employee (service-role setup and cleanup).
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list and write paths.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261015010000_employee_details_update.sql` -- the function and grants (ADDITIVE).
- `src/domain/employee-input.ts` + `tests/employee-input.test.ts` -- details normalisation and validation.
- `src/server/employees-store.ts` + `tests/employees-store.test.ts` -- `updateDetails`, `EmployeeNotFoundError`, mapping; store-owned matrix rows with fakes.
- `src/server/employee-actions.ts` + `tests/employee-actions.test.ts` -- the action, role gate, department refusal, messages.
- `src/components/employee-details-panel.tsx`, `src/components/portal.tsx` + component tests -- panel for admin and manager, prefilled, no department control, not shown to staff.
- `tests/employee-details-rls.test.ts` (new, live, skipped without env) -- throwaway departments P > C and unrelated U; employees in C and U (BS-87xx); a Staff account made manager of P; a plain Staff account in C; the admin. Assert through each JWT: admin and the P manager update the C employee's five fields (other columns unchanged, including `department_id`); the P manager on the U employee → `not_authorized`; the plain Staff on itself → `not_authorized`; `invalid_input` for a blank title and an unknown employment type; a direct `update` of `department_id` or `title` through a manager or admin JWT changes 0 rows; anon → permission denied. Cleanup via the service role.
- `tests/e2e/edit-employee.spec.ts` (new) -- admin opens a throwaway employee's profile, edits title and office, sees the success message and the new title in the profile header; there is no department control. Cleanup in `finally`.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- the migration and the details write path.

**Acceptance Criteria:**
- Given an authorized manager, when they change an employee's title, team, manager, office or employment type, then the change is saved and shown on the profile (e2e for the Administrator, live test for a department manager).
- Given any attempt to change an employee's department here, when it is submitted, then it is rejected and the department is unchanged.
- Given a Staff session, when it tries to edit basic details, including its own, then it is rejected at the server and by the database function.

## Spec Change Log

## Review Triage Log

## Design Notes

Why a function instead of an update policy: RLS cannot limit which columns an UPDATE touches, and Supabase grants `authenticated` update on every column, so an update policy would let a manager change `department_id`, `archived_at` or `auth_user_id` through the data API. A SECURITY DEFINER function that names only the five columns makes "department changes only through a transfer" true at the database, and the authority check runs before any lookup.

A manager may edit their own record only when it sits inside their own subtree (the same authority rule as everywhere in Epic 4); the story names no extra restriction.

## Verification

**Commands:**
- `npm run typecheck` -- no errors.
- `npm test` -- all pass, except live DB tests needing the 4.1–4.3, 7.1 and 7.2 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205); quote them.
- `npm run build` -- success.
- `npm run test:e2e` with Chromium via a temporary config (`channel: undefined`, `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`; the repo config uses msedge; delete the temp config afterwards) -- pass, or fail only with schema-missing errors.
- Optional: apply all migrations to a throwaway local Postgres (as Stories 4.3, 4.9 and 7.1 did) to exercise the function.
