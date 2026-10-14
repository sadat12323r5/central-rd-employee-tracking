# Deploy the L&D demonstration

Target: Vercel, using the Next.js preset and Node.js 24.x. The repository includes `vercel.json` for reproducible install/build commands. Employee records are read from a Supabase Postgres `employees` table (Story 1.1), so every environment needs the Supabase variables below.

## One shared Supabase project

Local development, Vercel Previews, the demo and CI all use **one shared hosted Supabase project** (free-plan limit). That is acceptable only while all data is fictional:

- Anything written to it (a migration, a seed, a test row) is immediately visible to every environment, including the live demo.
- Additive migrations (for example a new table the deployed code does not read yet) may be applied during development. Changing or destructive migrations are applied only after their PR is approved.
- The RLS integration tests create and delete their own throwaway auth users and `BS-99xx` rows; they never touch the seeded demo employees.
- **Before any real employee data is loaded, production must move to its own Supabase project.**

## Environment variables

| Variable | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (Preview + Production), `.env.local`, GitHub secret | The project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (Preview + Production), `.env.local`, GitHub secret | The anon (public) key. Subject to Row-Level Security. |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (Preview + Production), `.env.local`, GitHub secret | **Server-only.** Bypasses RLS. Read only under `src/server/` and by `scripts/`; never prefix it with `NEXT_PUBLIC_`. |
| `SUPABASE_DB_URL` | `.env.local` only | Postgres connection string (percent-encoded), used by `npm run db:push`. Not needed at runtime or in CI. |
| `SEED_ADMIN_EMAIL` | `.env.local` only, one-time | Email of the first Administrator, read by `npm run db:seed-admin`. |
| `SEED_ADMIN_PASSWORD` | `.env.local` only, one-time | Its password (at least 12 characters). Never printed; remove it from `.env.local` after seeding. |
| `SEED_DEMO_STAFF_EMAIL` | `.env.local` only | A seeded employee's primary email, read by `npm run db:seed-demo-staff`. |
| `SEED_DEMO_STAFF_PASSWORD` | `.env.local` only | That demo Staff account's password (at least 12 characters). Never printed or committed. |

`DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` (Story 1.2), and `DEMO_SESSION_SECRET` and `DEMO_STAFF_PASSWORD` (Story 1.3), are retired: delete them from Vercel and `.env.local`. The old `manager@example.com` credentials and the shared staff password are rejected.

Store these in Vercel's environment settings and `.env.local` (git-ignored), never in repository files or `vercel.json`. In GitHub, set the three Supabase values as repository secrets (`gh secret set NAME < value-file`, or the repository settings page); CI passes them to both jobs. Pull requests from forks do not receive secrets, so their RLS and live accounts tests are skipped, and their whole e2e job fails: e2e global setup throws without `SUPABASE_SERVICE_ROLE_KEY` because it cannot create the throwaway Administrator.

## Administrator accounts (Story 1.2)

Administrators sign in with a named Supabase Auth account (email + password). The session is the Supabase auth cookie, refreshed by `src/middleware.ts`, and lasts at most 8 hours from sign-in. The `admin` role comes from the user's `app_metadata.role`, which only the service role can set. Employee reads use a per-request client carrying the user's JWT, so the RLS policies are the enforced rule.

There is no self-registration. One-time setup for the shared project:

1. **Disable sign-ups (manual).** In the Supabase dashboard, open Authentication → Sign In / Providers and turn off **Allow new users to sign up**. (`supabase/config.toml` sets `enable_signup = false` to document this, but the hosted project setting is changed by hand.)
2. **Seed the first Administrator.** Put `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (at least 12 characters) in `.env.local` and run `npm run db:seed-admin`. It creates the account through `accounts-store.create()`, prints only the email, and refuses to run (exit code 1, nothing created) if any Administrator already exists. Remove both variables from `.env.local` afterwards.

Further accounts are provisioned by an Administrator in the app (Story 1.3). Tests and e2e create and delete their own throwaway Administrators (`e2e-admin-*@example.test`, `accounts-test-*@example.test`), so they never need a real Administrator's password.

## Staff accounts (Story 1.3)

An Administrator opens an employee's profile and, on the Overview tab's **Sign-in account** panel, types an initial password (12 to 72 characters, meeting the project's password policy) twice and selects **Create Staff account**. The server action checks the Administrator session first, then calls `accounts-store.create()` with the service-role client, which:

- creates a confirmed Supabase Auth user with the employee's own primary email (never typed into the form) and `app_metadata: { role: "staff", employee_id: "BS-nnnn" }`;
- links `employees.auth_user_id` only if the row is still unlinked, deleting the new user if that link fails or loses a race;
- refuses an employee who already has an account, before creating anything.

There is no invite or magic-link email (the shared project has no SMTP): the Administrator passes the initial password on outside the app. Staff sign in with their employee email; the session lasts at most 12 hours, and their own employee row is read through RLS (`employees_select_own`). At runtime the service-role key is used only by this Administrator-only provisioning action. There is no in-app password reset yet: to reset a Staff password (for example after a mistyped initial password), someone with access to the Supabase dashboard (service role) opens Authentication → Users → the user and resets or sets a new password.

**Demo Staff account.** Put `SEED_DEMO_STAFF_EMAIL` (a seeded employee's email, e.g. one from `npm run db:seed`) and `SEED_DEMO_STAFF_PASSWORD` (at least 12 characters) in `.env.local` and run `npm run db:seed-demo-staff`. It creates and links the account through `accounts-store.create()` and prints only the email. If that employee already has an account it exits 0 and creates nothing; missing or short variables exit non-zero naming the variable.

e2e global setup inserts throwaway employees (`BS-98nn`, team/title `E2E Throwaway`, emails `e2e-staff-<run>-<n>@example.test`), links three of them to throwaway Staff users through the service role (one is archived and restored by the archive spec), and leaves one unlinked for the provisioning spec. Teardown deletes them; setup first sweeps leftovers of an aborted run.

## Database migrations and seed

Migrations are forward-only SQL files in `supabase/migrations/`, applied with the Supabase CLI pinned in `devDependencies`.

```sh
npm run db:push   # applies pending migrations to the database in SUPABASE_DB_URL
npm run db:seed-admin   # one-time, BEFORE db:seed: creates the first Administrator (see above)
npm run db:seed   # idempotently inserts the L&D and Central R&D departments, sets L&D's manager to the Administrator (only while it has none), upserts the 8 fictional employees' basic details, places fixture employees with no department in Central R&D, and inserts their missing external interviews, completed training and LMS stub enrolments
npm run db:seed-demo-staff   # optional: creates the demo Staff account (see above)
```

- `db:push` reads `SUPABASE_DB_URL` from the environment or `.env.local` and never prints it.
- `20261008000000_archive_and_audit.sql` (Story 1.4) is additive: it adds `employees.archived_at`, the append-only `audit_events` table and the `set_employee_archived` function. The Story 1.4 code reads `archived_at` on every Administrator directory load and every Staff request, so apply this migration before deploying that code; otherwise the directory reports "Employee records are unavailable" and Staff sessions end. `audit_events` rows cannot be updated or deleted by any API role, the service role included; live tests and e2e leave audit rows for their throwaway `BS-98nn`/`BS-99nn` ids behind by design.
- `db:seed` reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the same way and upserts employees by Employee ID, so it is safe to rerun. Migrations never seed data. For interviews, training and LMS stub enrolments it is insert-only by deterministic ids (`interviewSeedId`, `trainingSeedId`, `lmsStubSeedId`): existing rows are never updated, so staff edits and withdrawals of seeded demo interviews survive a re-run. Completed training (`progress` 100) goes into `training_history`; in-progress entries go only into `lms_stub_enrolments` (`status` `in_progress`, `synced_at` = insert time), never into `training_history`. Because re-seeding does not refresh `synced_at`, seeded stub data shows as "Stale … as of" once it is more than 24 hours old, which is truthful.
- Data sources: interviews are read only from `external_interviews` (through `interviews-store`); training only through `training-store` (completed entries from `training_history`; current enrolments from the LMS adapter `lms-client`, a stub over `lms_stub_enrolments` until real LMS access exists). Nothing reads the fixture for training at runtime. Other nested profile data (skills, history, attendance summary, review) still comes from `src/data/employees.ts` through `employees-store`.
- Departments (Story 4.1): `db:seed` needs `20261014000000_departments.sql` applied first. It inserts L&D (top level) and Central R&D (under L&D) by fixed ids, insert-only, so later renames or re-parents survive a re-run, and sets `department_id` to Central R&D only for fixture employees whose `department_id` is null. Administrator directory reads select `employees.department_id`, so apply this migration before deploying the Story 4.1 code.
- Department managers (Story 4.2): `20261014010000_department_managers.sql` adds `departments.manager_user_id` (an auth user id; null = no manager), its index and the `departments_select_managed` policy (a user reads the departments they manage). Run `npm run db:seed-admin` before `npm run db:seed`: the seed sets L&D's manager to the Administrator account — the user whose email is `SEED_ADMIN_EMAIL` when that is set, else the earliest-created Administrator — only while L&D has no manager. With no Administrator yet it prints a warning to run `db:seed-admin` first and carries on; re-run `db:seed` afterwards. Central R&D gets no manager. Administrator department reads select `manager_user_id`, so apply this migration before deploying the Story 4.2 code. A Staff account that manages at least one department gets the management portal (role `manager`, derived on every request; session length stays 12 hours); an Administrator stays `admin`. An Administrator assigns or removes managers in **Departments → Set manager**; the person must already have a sign-in account.
- Manager scoping (Story 4.3): `20261014020000_manager_scope.sql` adds the `manages_department(uuid)` / `manages_employee(text)` SECURITY DEFINER helpers (execute for `authenticated` only) and select-only policies so a department manager reads the departments in their subtree (the ones they manage and every sub-department), the employees in them, and those employees' attendance, training history and LMS enrolments. No write policy is added, and interviews get no manager policy. The app re-derives the same scope at the store on every request (`src/server/manager-scope.ts`). Until it is applied, a manager's scope covers only the departments they manage directly (sub-departments are not visible), and their directory lists only the employees RLS lets them read in those departments, which is at most their own record and only when it sits in one of them; Administrators and Staff are unaffected.
- Activity export (Stories 8.1-8.3): every export writes one `audit_events` row (action `export_activity`, the period) through a service-role-only function: `record_activity_export` (target = the Employee ID, single export by an Administrator or a department manager), `record_bulk_activity_export` (target `all-employees[+archived]`, the Administrator's bulk export) and, from `20261015050000_department_activity_export_audit.sql` (Story 8.3), `record_department_activity_export` (target `departments:<the manager's subtree department ids, sorted>[+archived]`, a department manager's bulk export). A manager's exports cover only their department subtree and never contain interview rows. Until the function an export needs is applied, that export shows the "could not be exported because a record source is unavailable" message and nothing downloads.
- The `db:seed` script runs TypeScript directly and needs Node 24 (or Node 22 with `--experimental-strip-types`, which the script passes).

**Deploy checklist** (in this order):

1. Apply every pending migration with `npm run db:push`, which applies them in filename order. Every employee read (the Administrator directory, staff sign-in and the staff page) reads interviews and training, so until a migration below is applied those reads show "employee records unavailable".
   1. `20261006000000_employees.sql` (Story 1.1): the `employees` table and its RLS. ADDITIVE (new table).
   2. `20261008000000_archive_and_audit.sql` (Story 1.4): `employees.archived_at`, the append-only `audit_events` table and the `set_employee_archived` function. ADDITIVE. Missing: Postgres 42703 (the directory and Staff sessions read `archived_at`).
   3. `20261012000000_attendance.sql` (Story 1.5): `attendance_entries`. ADDITIVE.
   4. `20261012010000_external_interviews.sql` (Story 2.1): `external_interviews`. ADDITIVE. Missing: PGRST205 / 42P01.
   5. `20261012020000_external_interview_updates.sql` (Story 2.2): `external_interviews.withdrawn_at` (null default), the own-row UPDATE policy and the `external_interviews_guard` trigger that locks company, role, date and employee and makes withdrawn rows immutable for every role, including the service role. ADDITIVE. Missing: Postgres 42703.
   6. `20261012030000_training_history.sql` (Story 3.1): `training_history` (completed training, no department column), its `employee_id` index and two select-only RLS policies (employee-own and Administrator; no insert, update or delete policy). ADDITIVE. Missing: PGRST205 / 42P01.
   7. `20261012040000_lms_stub_enrolments.sql` (Story 3.2): `lms_stub_enrolments` (the LMS adapter stub's data: status `in_progress`/`completed`, progress, target and completion dates, result, `synced_at`; no department column), its status/progress/date checks, `employee_id` index and two select-only RLS policies (employee-own and Administrator; no insert, update or delete policy). ADDITIVE. Missing: PGRST205 / 42P01. Until it is applied, every "Current enrolments" view shows the "unavailable" alert (history still shows).
   8. `20261013000000_activity_export_audit.sql` (Story 8.1): the `audit_events` period columns, the `export_activity` action and `record_activity_export`. ADDITIVE. Missing: every activity export shows the unavailable message.
   9. `20261013010000_bulk_activity_export_audit.sql` (Story 8.2): `record_bulk_activity_export`. ADDITIVE. Missing: the Administrator's bulk activity export shows the unavailable message.
   10. `20261014000000_departments.sql` (Story 4.1): `departments` and `employees.department_id`. ADDITIVE. Missing: PGRST205 / 42703.
   11. `20261014010000_department_managers.sql` (Story 4.2): `departments.manager_user_id`, its index and the `departments_select_managed` policy. ADDITIVE. Missing: 42703 (the Departments section and the Administrator page report departments unavailable).
   12. `20261014020000_manager_scope.sql` (Story 4.3): the `manages_department` / `manages_employee` helpers and the `departments_select_managed_subtree`, `employees_select_managed`, `attendance_select_managed`, `training_history_select_managed` and `lms_stub_enrolments_select_managed` policies. ADDITIVE. Missing: a manager's directory is empty, or shows only their own record when it sits in a department they manage directly (no error).
   13. `20261015050000_department_activity_export_audit.sql` (Story 8.3): `record_department_activity_export(uuid, uuid[], boolean, date, date)` (errors `invalid_period`, `invalid_scope`; execute for `service_role` only). ADDITIVE. Missing: PGRST202; a department manager's bulk activity export shows the unavailable message (their single-employee export still works).
2. On a fresh project run `npm run db:seed-admin` first, then `npm run db:seed` (the seed makes that Administrator L&D's manager). Until it runs after migration 6 the demo employees show no completed training, and until it runs after migration 7 they show no current enrolments.
3. Deploy the code.

If the database is unreachable, the app shows an "Employee records are unavailable" alert instead of an empty or partial directory, and Staff sign-in reports that it is temporarily unavailable.

## Publish and verify

1. Apply any pending migrations (`npm run db:push`) and seed if the table is new (`npm run db:seed`). On a fresh project, disable sign-ups and run `npm run db:seed-admin` once.
2. Run `npm run check` (includes the RLS integration test when Supabase variables are set) and `npm run test:e2e` before publishing changed application code.
3. Deploy the current source through the connected Vercel account. A CLI alternative is `npx vercel` after `npx vercel login`; use `--prod` for a production deployment.
4. Wait for successful deployment and capture the returned HTTPS URL.
5. Confirm unauthenticated visits show sign-in, an incorrect password, the retired `manager@example.com` credentials and the old shared staff password are rejected, the Administrator's named account opens the employee directory, and a provisioned Staff account opens only its own portal.
6. Refresh after sign-in to check session persistence, open an employee profile, verify filtering and sign out.

This is a demonstration with fictional records. Administrators and Staff have named accounts. An Administrator can archive and restore an employee's access from their profile (Story 1.4) and Staff attendance is persisted (Story 1.5); external integrations remain separate implementation work.

References: [Vercel CLI](https://vercel.com/docs/cli), [environment variables](https://vercel.com/docs/environment-variables) and [Supabase CLI](https://supabase.com/docs/reference/cli).
