---
title: "Story 7.2: Edit an employee's basic details"
type: 'feature'
created: '2026-10-14'
status: 'done'
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

### 2026-10-14 — Review pass
- verdicts: 26 findings — high 0, medium 1, low 13, false 12, maybe-false 0
- findings:
  - `[medium]` `[patch]` VerificationGap: the panel's legacy employment-type branch is untested; removing it would silently save "Permanent" — component test added for a "Contract" value.
  - `[low]` `[reject]` EdgeCase: archived target employees are editable — the intent does not forbid it; archived records are kept, and correcting them is harmless.
  - `[low]` `[reject]` EdgeCase: panel offered on archived profiles — same as above.
  - `[false]` `[reject]` EdgeCase: a manager can edit their own record inside their subtree — the recorded decision in Design Notes (the Epic 4 authority rule; the story only restricts Staff).
  - `[low]` `[reject]` EdgeCase: revalidatePath throwing after commit shows "Nothing was changed" — the same pattern as every existing action; no realistic trigger.
  - `[low]` `[reject]` EdgeCase: UTF-16 vs code-point length for emoji-heavy values — the app is stricter than the DB; only exotic input is affected, and nothing invalid is stored.
  - `[low]` `[reject]` EdgeCase: Postgres `\s` may not match NBSP — exotic input; the app normalises first.
  - `[low]` `[patch]` EdgeCase: the panel keyed only by employee keeps stale values after a refresh — the key now includes the five current values.
  - `[false]` `[reject]` Blind: no audit row for detail edits — audit is decided only for archive/restore, transfer and exports; the story does not ask for it.
  - `[low]` `[reject]` Blind: archived employees editable — duplicate of the EdgeCase row.
  - `[false]` `[reject]` Blind: manager self-edit unaddressed — addressed in Design Notes.
  - `[low]` `[patch]` Blind: ARCHITECTURE.md says 7.1 is "the only" write path — reworded.
  - `[low]` `[patch]` Blind: concurrent or stale edits resubmit old values — same patch as the panel key row; last-write-wins is acceptable for these free-text fields.
  - `[low]` `[reject]` Blind: DB-level invalid_input gives a generic message — the action's zod messages name the field first; the DB path is reached only by direct calls.
  - `[low]` `[reject]` Blind: app/DB whitespace and length disagreement — duplicate of the EdgeCase rows.
  - `[false]` `[reject]` Blind: legacy type branch contradicts the migration comment — the column has no check constraint, so rows created outside the app can hold other values; the branch is a safeguard.
  - `[low]` `[reject]` Blind: the success message stays while editing — cosmetic; same as the other panels.
  - `[low]` `[patch]` Blind: missing tests (Staff absence in portal, manager department refusal, manager e2e, keyboard) — added the Staff-absence test; the others repeat covered paths (the action's department refusal runs before the role-specific code).
  - `[low]` `[reject]` Blind: test id slots can collide across concurrent runs — BS-87xx is used only by this story's files; the same per-slot pattern as the existing live tests.
  - `[false]` `[reject]` Blind: refusals matched on the message without the P0001 code — the function names are unique, and the pattern matches Story 1.4's mapping.
  - `[false]` `[reject]` Intent: the manager path is not driven end to end — covered by the live function test and unit tests; the Administrator e2e covers AC1's user surface.
  - `[false]` `[reject]` Intent: other forged department keys are silently dropped — R2b: the department cannot change through this feature at any layer.
  - `[false]` `[reject]` Intent: DB coverage depends on env vars — CI passes the secrets; descriptive.
  - `[false]` `[reject]` Intent: a function instead of an RLS policy — the deliberate choice in Design Notes; the intent is met by both layers.
  - `[false]` `[reject]` Intent: the panel is shown to managers on any open profile — managers can only open in-scope profiles (Story 4.3).
  - `[false]` `[reject]` Intent: no audit (R5) — not in the story.

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

## Auto Run Result

Status: done

**Summary:** The Administrator (anyone) and department managers (their subtree) can edit an employee's title, team, reporting manager, office and employment type from an "Edit details" form on the profile. The save goes through `employeesStore.updateDetails()` and a new SECURITY DEFINER function, `update_employee_details`, which updates only those five columns. A department change is refused at the action and is impossible at the database. `employees` still has no update policy.

**Files changed:**
- `supabase/migrations/20261015010000_employee_details_update.sql`: the function and its grants (ADDITIVE).
- `src/domain/employee-input.ts`: details normalisation and validation.
- `src/server/employees-store.ts`: `updateDetails`, `EmployeeNotFoundError`, refusal mapping.
- `src/server/employee-actions.ts`: `updateEmployeeDetailsAction`.
- `src/components/employee-details-panel.tsx`, `src/components/portal.tsx`, `src/app/styles.css`: the panel for admin and manager. The open profile now re-reads refreshed data.
- Tests:
  - new: `tests/components/employee-details-panel.test.tsx`, `tests/employee-details-rls.test.ts` (live, BS-87xx), `tests/e2e/edit-employee.spec.ts`;
  - extended: the input, store, action, portal and staff-attendance tests;
  - de-flaked: two Story 7.1 tests in `tests/components/add-employee-panel.test.tsx`, which now wait for the success text instead of the always-present status region.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`.

**Review:** 26 findings: 1 medium, 13 low, 12 false.
- **Patched (4 distinct fixes across 5 rows):**
  - medium: the legacy employment-type safeguard had no test;
  - low: the panel key now includes the current values (stale form after a refresh);
  - low: a test that Staff get no edit form;
  - low: ARCHITECTURE wording.
- **Deferred:** none.
- **Rejected:** all others, with the reasons in the triage log (main ones: no audit row, which the story does not ask for; archived targets stay editable; a manager editing their own in-subtree record, as decided in Design Notes).

Follow-up review recommended: false (patched: high 0, medium 1).

**Verification:**
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm test`: 1159 passed, 41 skipped. Four live files fail only with PGRST205: `departments-rls`, `manager-scope-rls`, `employee-create-rls` and `employee-details-rls`.
- `npm run test:e2e` (Chromium): 11 passed, 17 failed, all schema-missing (13× 42703, 4× PGRST205).
- Local Postgres 16 with all migrations applied (by the implementer):
  - the Administrator and an in-subtree manager save the five fields, and the other columns (department included) are unchanged;
  - `not_authorized` for: a manager outside the subtree, a missing id from a manager, Staff on their own record, an archived caller, and no user;
  - `invalid_input` for: a blank value, an unknown employment type, and 121 characters;
  - `employee_not_found` for an unknown id from the Administrator;
  - anon is denied;
  - a direct UPDATE with a manager or admin JWT changes 0 rows.

**Residual risks:**
- The live and e2e tests must be re-run after the 4.1–4.3, 7.1 and 7.2 migrations are applied.
- Until the 7.2 migration is applied, saving details shows "temporarily unavailable".
