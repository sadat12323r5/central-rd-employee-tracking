---
title: 'Story 7.1: Add a new employee'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '0c39da18417ee81e7f6a0d88a317d6055f7d403b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-manager-scoping.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** New joiners can only be added by a developer seeding rows; the L&D manager and department managers cannot add an employee, so new people cannot be tracked or given an account.

**Approach:** An "Add employee" form in the management portal's Employees view, for the Administrator (any department) and department managers (departments in their subtree). A server action validates the input and calls a new `employeesStore.create()`, which pre-checks department authority and inserts through the signed-in user's JWT; new ADDITIVE insert policies on `employees` enforce the same rule in the database. The new employee then appears in the directory and can be given an account through Story 1.3's panel.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261015000000_employee_create.sql`, ADDITIVE: two new insert policies on `public.employees`, nothing else. No column, constraint, index or existing policy is changed (`department_id` stays nullable at the column; the policies require it).
  - `employees_insert_admin`: `for insert to authenticated with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' and department_id is not null and auth_user_id is null and archived_at is null)`.
  - `employees_insert_managed`: `for insert to authenticated with check (department_id is not null and public.manages_department(department_id) and auth_user_id is null and archived_at is null)`.
  - No update or delete policies.
- **Fields.** Required: Employee ID (`^BS-\d{4}$`), name, title, team, email, department (an id from the list), reporting manager (the existing free-text `manager` column), office, employment type (one of `Permanent`, `Trainee`, `Intern`, the values in use). Optional: join date (`YYYY-MM-DD`, valid calendar date; defaults to today in Asia/Dhaka). Text fields are trimmed, inner whitespace collapsed, 1–120 chars; email trimmed, lower-cased, valid (zod `email()`), max 254.
- **Derived, never from the form:** `status = 'Available'`, `initials` = first letter of the first and last name words, upper-cased (one word → its first letter), `avatar_color` = one of `lavender, mint, peach, blue, rose, yellow` chosen deterministically from the Employee ID digits, `summary = ''`. `auth_user_id` and `archived_at` are never set. Pure helpers in `src/domain/employee-input.ts` (no framework or DB imports).
- **Store.** `employeesStore.create(session, input)` in `src/server/employees-store.ts`, through the per-request user client (never the service role):
  - Staff → `EmployeeForbiddenError` without a query.
  - Manager → `input.departmentId` must be in `scope.forManager(session).departmentIds`, else `EmployeeForbiddenError` without an insert; scope failure → `EmployeesUnavailableError`.
  - Insert without `.select()` (no read-back needed). Map Postgres errors: `23505` on the primary key → `EmployeeExistsError("employeeId")`, on the email unique constraint → `EmployeeExistsError("email")`; `23503` (unknown department) → `EmployeeValidationError(["departmentId"])`; `42501` (RLS) → `EmployeeForbiddenError`; anything else → `EmployeesUnavailableError`.
  - Returns `{ employeeId, name }`.
- **Action.** `createEmployeeAction(prev, form)` in a new `src/server/employee-actions.ts` (`"use server"`): `getActor()`; only `admin` and `manager` continue, others get "Only an Administrator or a department manager can add employees." before any store call; zod-validate (messages name the field to fix); a missing department gets "Choose a department. Every employee needs one."; call the store; `revalidatePath("/")`; success "<Name> was added." Error messages: duplicate ID "An employee with this Employee ID already exists."; duplicate email "An employee with this email already exists."; forbidden "You can only add employees to your own department or its sub-departments."; unavailable "Employee records are temporarily unavailable. Nothing was added."
- **UI.** New client component `src/components/add-employee-panel.tsx` (`useActionState`, labelled inputs, `aria-label="Add an employee"` on the form, error in `role="alert"`, success in `role="status"`, form reset on success), shown in the Employees view of `src/components/portal.tsx` for `admin` and `manager` roles. The department select lists the departments the portal already receives (admin: all; manager: their subtree via `departmentsStore.listFor`), with no empty default option selected as valid. Keyboard operable; no colour-only status.
- Live DB tests sign each test user in once per file; bulk inserts pass `{ defaultToNull: false }`. Test Employee IDs use a range no other test file uses (check `tests/` for `BS-9xxx` ranges; `BS-90`–`BS-99` prefixes are partly taken).

**Never:**
- No account creation as a side effect (accounts only via `accounts-store.create()`, Story 1.3).
- No editing of existing employees (Story 7.2), no transfers (4.8), no deletes.
- No service-role writes on the runtime path; no change to Staff behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin adds | Valid fields, any department | Row inserted with derived fields; appears in directory; Story 1.3 panel offers "create account" | — |
| Manager adds in subtree | Department is the manager's or a descendant | Inserted | — |
| Manager outside subtree | Department not in scope | Rejected at the store (no insert); RLS also rejects a direct insert | forbidden message |
| Staff | Staff session calls the action, or inserts with its JWT | Rejected before the store; RLS rejects | "Only an Administrator…" |
| No department | Department empty | Rejected by action validation; RLS rejects a null `department_id` | "Choose a department…" |
| Duplicate ID | Employee ID exists (even outside the manager's scope) | Rejected | duplicate ID message |
| Duplicate email | Email exists (case-insensitive after lower-casing input) | Rejected | duplicate email message |
| Unknown department id | Forged id | Rejected (23503 / not in scope) | department message |
| Bad input | ID not `BS-dddd`, invalid email, bad date, blank field, unknown employment type | Rejected, nothing inserted | field message |
| Forged extras | Form carries `auth_user_id`/`status` | Ignored | — |
| DB down | Insert or scope read fails | Nothing added | unavailable message |

</intent-contract>

## Code Map

- `supabase/migrations/20261006000000_employees.sql` -- table columns (all NOT NULL except `auth_user_id`), `email unique`, admin select policy style.
- `supabase/migrations/20261014020000_manager_scope.sql` -- `manages_department(uuid)` (reuse in the insert policy); header comment style.
- `src/server/employees-store.ts` -- `createEmployeesStore`, `run`, `EmployeesUnavailableError`, injected `scope`; add `create` and the new error classes here. `toEmployee`/`nestedFor` already give non-fixture ids an empty nested profile.
- `src/server/manager-scope.ts` -- `forManager(session).departmentIds`.
- `src/server/departments-store.ts` -- `listFor(session)` (already feeds `departments` into the portal for admin and manager).
- `src/server/auth.ts` -- `getActor()`.
- `src/server/account-actions.ts` -- action shape, `ActionState`, message style to mirror.
- `src/components/staff-account-panel.tsx`, `src/components/departments-panel.tsx` -- client form patterns with `useActionState`.
- `src/components/portal.tsx` -- `role` prop, `departments` prop, Employees section (`section === "Employees"`), `isManager`.
- `src/domain/dates.ts` -- date helpers (Asia/Dhaka today, if present; otherwise add a small helper in the new domain file).
- `tests/employees-store.test.ts`, `tests/account-actions.test.ts`, `tests/components/*`, `tests/employees-rls.test.ts`, `tests/manager-scope-rls.test.ts` -- unit and live test patterns.
- `tests/e2e/departments.spec.ts`, `tests/e2e/admin.ts`, `tests/e2e/supabase-admin.ts` -- e2e patterns and service-role cleanup.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list and employee write path.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261015000000_employee_create.sql` -- the two insert policies (ADDITIVE).
- `src/domain/employee-input.ts` + `tests/employee-input.test.ts` -- normalisation, initials, colour, default join date.
- `src/server/employees-store.ts` + `tests/employees-store.test.ts` -- `create`, errors, mapping; every store-owned matrix row with fake clients.
- `src/server/employee-actions.ts` + `tests/employee-actions.test.ts` -- role gate, validation messages, error messages, forged extras ignored.
- `src/components/add-employee-panel.tsx`, `src/components/portal.tsx` + component tests -- form shown for admin and manager, not for staff; department options from props.
- `tests/employee-create-rls.test.ts` (new, live, skipped without env) -- throwaway departments P > C and an unrelated U; Staff accounts made managers of C; admin, manager and plain Staff JWTs. Assert: admin insert succeeds; manager insert into C succeeds, into U fails; Staff insert fails; null department fails for admin; duplicate ID/email fail. Clean up through the service role.
- `tests/e2e/add-employee.spec.ts` (new) -- admin adds a throwaway employee to a throwaway department; it appears in the directory with that department; the profile offers the Story 1.3 account panel. Cleanup through the service role in `finally`.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- the migration and the write path.

**Acceptance Criteria:**
- Given an authorized manager, when they add an employee with all required fields, then the employee appears in the directory and can be given an account through Story 1.3 (e2e).
- Given an Employee ID or primary email that already exists, when saved, then it is rejected.
- Given no department, when saved, then it is rejected, at the action and in the database.
- Given a Department Manager, when they add an employee to a department outside their subtree, then it is rejected at the server and by RLS.

## Spec Change Log

## Review Triage Log

## Design Notes

Defaults: the story lists the fields the person enters; the remaining NOT NULL columns get neutral defaults (status "Available", empty summary, derived initials and colour) that Story 7.2 edits. Join date is optional and defaults to today because a new joiner's start date is usually today or known; it is not invented data.

`department_id` stays nullable at the column (making it NOT NULL would be a DESTRUCTIVE tightening while seeded rows may lack it); the insert policies require it, so every employee added through the app has one from the start.

Email uniqueness is the existing case-sensitive `unique`; the store lower-cases input, matching how accounts-store treats emails. A case-insensitive index would tighten an existing column and is left out.

## Verification

**Commands:**
- `npm run typecheck` -- no errors.
- `npm test` -- all pass, except live DB tests needing the 4.1–4.3 and 7.1 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205) — or, for the new insert tests only, with the RLS refusal an unapplied insert policy causes (42501 on an insert the test expects to succeed); quote such lines.
- `npm run build` -- success.
- `npm run test:e2e` (Chromium via `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"` in a temporary config, since the repo config uses the msedge channel) -- pass, or fail only with schema-missing errors.
- Optional: apply all migrations to a throwaway local Postgres (as Stories 4.3 and 4.9 did) to exercise the policies.
