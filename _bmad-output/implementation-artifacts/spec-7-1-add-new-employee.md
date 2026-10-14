---
title: 'Story 7.1: Add a new employee'
type: 'feature'
created: '2026-10-14'
status: 'done'
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

### 2026-10-14 — Review pass
- verdicts: 31 findings — high 0, medium 1, low 15, false 15, maybe-false 0
- findings:
  - `[low]` `[patch]` VerificationGap other: non-UUID departmentId reaches Postgres (22P02) and is shown as "unavailable" — action validates a UUID; store maps 22P02 to a department validation error.
  - `[low]` `[patch]` EdgeCase: 22P02 mapped to unavailable — same root cause and patch as above.
  - `[low]` `[patch]` EdgeCase: departmentId only checked non-empty — same patch.
  - `[low]` `[reject]` EdgeCase: a rejected server action (network drop) escapes useActionState — same pattern as every existing panel (staff-account, account-access, departments); not introduced here.
  - `[low]` `[reject]` EdgeCase: join date has no range — the intent sets no bounds; inventing a window is a product decision; 7.2 can correct dates.
  - `[false]` `[reject]` EdgeCase: employmentType with surrounding whitespace refused by the action — the field is a select with fixed values; no user path sends whitespace.
  - `[low]` `[reject]` EdgeCase: client maxLength counts raw text — only affects >120-char input with runs of spaces; server decides.
  - `[false]` `[reject]` EdgeCase claim: no manager e2e — the Administrator is an "authorized manager" (Epic 7 preamble); the e2e covers AC1 for it and the manager path is covered by store, action and live RLS tests.
  - `[false]` `[reject]` Intent: manager-added employee appearing in the manager's directory not asserted — the manager directory read is Story 4.3's tested path; descriptive.
  - `[false]` `[reject]` Intent: 1.3 provisioning not exercised on a new employee — AC says "can be given"; eligibility is asserted; provisioning itself is Story 1.3's e2e.
  - `[false]` `[reject]` Intent: no table-level NOT NULL on department_id — a DESTRUCTIVE tightening; the intent's "rejected" is met at app and policy level (Design Notes).
  - `[false]` `[reject]` Intent: duplicates not tested from UI to DB — each layer is tested; descriptive.
  - `[low]` `[patch]` Intent: no insert into a grandchild department — live RLS case added (manager of C inserts into G).
  - `[false]` `[reject]` Intent: fields beyond the literal list (join date, enum, defaults) — NOT NULL columns need values; recorded in Design Notes.
  - `[false]` `[reject]` Intent: integration tests need a configured project — the hand-off for unapplied migrations; descriptive.
  - `[false]` `[reject]` Intent: renamed employees-rls test narrows meaning — the assertion is unchanged and now states the real reason the admin insert fails.
  - `[false]` `[reject]` Blind: no audit row for an added employee — audit is decided only for archive/restore, transfer and exports; the intent does not ask for it.
  - `[false]` `[reject]` Blind: manager e2e missing — duplicate of the EdgeCase claim row.
  - `[low]` `[patch]` Blind: no grandchild insert test — same patch as the Intent row.
  - `[low]` `[patch]` Blind: an Administrator refused by RLS sees the manager-only message — admin sessions now get the unavailable message.
  - `[false]` `[reject]` Blind: duplicate errors reveal IDs/emails outside a manager's scope — the intent matrix requires a duplicate ID to be rejected even outside scope; accepted and noted in the PR.
  - `[low]` `[reject]` Blind: DB does not enforce derived fields on direct API inserts — cosmetic fields Story 7.2 makes editable; policy checks would add complexity for no user harm.
  - `[low]` `[reject]` Blind: only the first validation issue is shown, no per-field aria — the existing panels use the same single-alert pattern; the alert names the field.
  - `[low]` `[patch]` Blind: focus lost after every submit (form key changes on refusals) — the key now changes only on success.
  - `[low]` `[reject]` Blind: submit enabled with an empty department list — the select is required, so the browser blocks submit; the panel states there are no departments.
  - `[medium]` `[patch]` Blind: test ID ranges collide (BS-91xx is used by Stories 4.4 and 4.9 tests; BS-90..99 are taken) and cleanup can delete other runs' rows — live test moved to BS-89xx, e2e to BS-88xx.
  - `[low]` `[reject]` Blind: join date sanity range — duplicate of the EdgeCase row.
  - `[low]` `[reject]` Blind: validation rules duplicated across layers (ID regex, field list, email shape) — both layers reject what the DB would; no user-visible disagreement found.
  - `[low]` `[reject]` Blind: unmatched 23505 shown as unavailable — only after a future constraint rename; adding a generic duplicate message is new surface.
  - `[false]` `[reject]` Blind: email uniqueness case-sensitive — acknowledged in Design Notes; the app lower-cases input and seeded emails are lower case.
  - `[low]` `[patch]` Blind: test department constant is not a valid UUID — replaced with a valid UUID.

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

## Auto Run Result

Status: done

**Summary:** The Administrator (any department) and department managers (their subtree) can add a new employee from an "Add employee" form in the Employees view. A server action validates the input, `employeesStore.create()` pre-checks department authority and inserts through the user's JWT, and two new ADDITIVE insert policies enforce the same rule in the database. The new employee appears in the directory, ready for Story 1.3 provisioning.

**Files changed:**
- `supabase/migrations/20261015000000_employee_create.sql`: `employees_insert_admin` and `employees_insert_managed` (ADDITIVE).
- `src/domain/employee-input.ts`: normalisation, validation, derived fields (initials, colour, status, default join date).
- `src/server/employees-store.ts`: `create()`, new errors, Postgres error mapping.
- `src/server/employee-actions.ts`: `createEmployeeAction`.
- `src/components/add-employee-panel.tsx`, `src/components/portal.tsx`, `src/app/styles.css`: the form for admin and manager.
- Tests:
  - new: `tests/employee-input.test.ts`, `tests/employee-actions.test.ts`, `tests/components/add-employee-panel.test.tsx`, `tests/employee-create-rls.test.ts` (live, BS-89xx), `tests/e2e/add-employee.spec.ts` (BS-88xx);
  - extended: `tests/employees-store.test.ts`, `tests/components/portal.test.tsx`, `tests/employees-rls.test.ts` (one test renamed).
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`.

**Review:** 31 findings: 1 medium, 15 low, 15 false.
- **Patched (6 fixes):**
  - medium: the test ID range collided with Stories 4.4 and 4.9;
  - low: department UUID validation and 22P02 mapping;
  - low: an Administrator refused by RLS got the manager message;
  - low: the grandchild-department insert test;
  - low: the form remounted on refusal, losing focus;
  - low: an invalid test UUID.
- **Deferred:** none.
- **Rejected:** all others, with the reasons in the triage log.

Follow-up review recommended: false (patched: high 0, medium 1, low 5).

**Verification:**
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm test`: 1106 passed, 32 skipped. Three live files fail only with PGRST205 (`public.departments` missing): `departments-rls`, `manager-scope-rls` and `employee-create-rls`. One 5-second timeout in `lms-rls` passed on re-run (11/11).
- `npm run test:e2e` (Chromium via executablePath): 11 passed, 16 failed. Every failure is schema-missing (12× 42703, 4× PGRST205).
- The implementer applied all migrations to a throwaway local Postgres 16 and confirmed:
  - admin and in-subtree manager inserts succeed;
  - parent, unrelated or null department, Staff, anon, and forged `auth_user_id`/`archived_at` are refused (42501);
  - duplicate ID and email give 23505 on the expected constraints, and an unknown department gives 23503;
  - no updates are possible.

**Residual risks:**
- The live RLS and e2e tests must be re-run after the 4.1, 4.2, 4.3 and 7.1 migrations are applied.
- A duplicate-ID or duplicate-email error tells a manager that the value exists outside their scope (the intent requires the rejection).
- Email uniqueness stays case-sensitive in the database.
