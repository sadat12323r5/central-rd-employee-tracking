# Architecture and data model

**Status:** describes the implemented prototype — supersedes the previous version, which described an unbuilt GitHub-webhook/logbook system. See [SRS.md](SRS.md) Section 12 for why that scope was dropped.

> **For new work, follow the architecture spine, not this document's "Production architecture" section.** As of 30 September 2026 the binding decisions for everything not yet built (accounts and roles, departments and managers, assignments and evaluations, the LMS adapter, archiving) live in [`_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md`](../_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md). The target entity list below predates it and is incomplete. This document stays accurate for the prototype as it exists today.

## Current architecture

The application is a single Next.js (App Router) deployable backed by one hosted Supabase project (Auth and Postgres).

| Layer | Choice | Responsibility |
|---|---|---|
| Web | Next.js 15 App Router + React 19 + TypeScript | The one route (`src/app/page.tsx`), layout, and client components |
| Session | Supabase Auth for Administrators and Staff (`src/server/auth.ts`, `src/server/supabase.ts`, `src/middleware.ts`); session types in `src/server/session.ts` | Administrators (Story 1.2) and Staff (Story 1.3) sign in with named Supabase accounts; the HMAC demo cookie is retired |
| Accounts | `src/server/accounts-store.ts`, `src/server/account-actions.ts` | The single account-creation path (`create()`), used by the Administrator-only Staff provisioning action and by the `db:seed-admin` / `db:seed-demo-staff` seed scripts; the single archive/restore path (`archive()` / `restore()`, Story 1.4), used by the Administrator archive and restore actions; and the department manager's archive/restore path (`createManagerAccessStore`, Story 4.9) |
| Data | Supabase `employees` table (`supabase/migrations/`) behind `src/server/employees-store.ts`, plus the TypeScript fixture (`src/data/employees.ts`) | Basic employee details and account links are in Postgres with RLS; nested profile data still comes from the fixture, merged by Employee ID |
| Domain | Framework-independent TypeScript (`src/domain/leave.ts`) | Pure leave-calculation logic; implemented and tested but not yet called from any route or component |
| Verification | Vitest (domain + server-action unit tests) and Playwright (browser scenarios) | See `tests/` |
| Hosting | Vercel | Static/serverless deployment of the demo (`vercel.json`) |

Employee basic details live in the Supabase `employees` table behind `src/server/employees-store.ts` (Story 1.1). Every read (Administrator and Staff) uses a per-request client carrying the user's Supabase JWT, so the RLS policies are enforced. At runtime the server-only service-role client is used only by the Administrator-only account actions (provisioning, archive, restore).

## Trust boundaries (as implemented)

1. Every request to `src/app/page.tsx` calls `getSession()`. It validates the Supabase user server-side with `auth.getUser()` and returns `admin` for `app_metadata.role === "admin"` signed in under 8 hours ago, or `{ staff, employeeId }` for `role === "staff"` with an `employee_id` matching `^BS-\d{4}$`, signed in under 12 hours ago (both the account's last sign-in and the session's own password sign-in count). For a Staff identity it also reads the employee's own `archived_at` through the JWT client (RLS) on every request: a row that is archived or not visible signs the session out and returns no session, so archiving ends access on the next request (Story 1.4). A read error returns no session without signing out. Administrator accounts have no employee row and skip this check. Anything else renders the sign-in page.
2. `src/middleware.ts` refreshes the Supabase auth cookies on each request, since Server Components cannot write cookies.
3. Accounts are created only through `accounts-store.create()`: by the seed scripts, and by `provisionStaffAccountAction`, which checks for an Administrator session at the server before anything else. A Staff account gets the employee's own primary email and `app_metadata.employee_id`, and `employees.auth_user_id` is linked conditionally (compensated by deleting the new user on failure). There is no sign-up route, form, invite or `auth.signUp` call, and sign-ups are disabled in Supabase Auth.
   Archiving and restoring go only through `accounts-store.archive()` / `restore()`, called by `archiveEmployeeAction` / `restoreEmployeeAction` after an Administrator-session check. Both call the Postgres function `set_employee_archived`, which sets or clears `employees.archived_at` and inserts one `audit_events` row (actor = the Administrator's auth user id from the validated session, target = Employee ID, action, server timestamp) in the same transaction. Only the service role may execute it. It refuses an Administrator archiving the employee linked to their own account. Nothing is deleted and no auth user is banned: archived employees keep all their data and are hidden from the default directory (a "Show: Archived employees" filter lists them). Department managers (Story 4.9) archive and restore employees in their own department subtree through `createManagerAccessStore()`: the store first refuses the manager's own record and any employee outside the manager scope (no database call), then calls the SECURITY DEFINER function `manager_set_employee_archived` through the manager's own JWT client (never the service role). The function takes the actor from `auth.uid()`, re-checks scope with `manages_employee`, refuses the manager's own record and targets with equal or higher authority (an Administrator, or the manager of the caller's own department, of a department the caller manages, or of an ancestor of either; a manager of a sub-department below the caller is lower and may be archived), and writes the change and one `audit_events` row in one transaction. The rank check applies to restore too.
4. A wrong password, an unknown email, a valid Supabase user without a recognised role, a Staff user whose own employee row is not visible through RLS, and an archived Staff account all get the same generic message. The retired `DEMO_ADMIN_*` credentials, the shared staff password and any old HMAC demo cookie are rejected or ignored.
5. Supabase keys come only from environment variables; the service-role key is server-only.
6. Activity export (Stories 8.1-8.3): `exportActivityAction` / `exportAllActivityAction` (`src/server/activity-actions.ts`) accept only an Administrator or a department manager session, checked at the server before any read; Staff and no session get "Only an Administrator or a department manager can export activity." The pipeline (`src/server/activity-export.ts`) reads every source through its store and is all or nothing. The single export and the employee, training and LMS reads pass the caller's session; the bulk export reads attendance with `attendance-store.listAll()` (bounded by RLS under the caller's JWT) and keeps only the rows of the scoped employee list. A manager's single export reads the employee through `employees-store.getFor` (null outside the subtree: refused with "You can only export employees in your own department or its sub-departments.", nothing else read) and attendance through the session-aware `attendance-store.listFor`; their bulk export covers `employees-store.listFor(manager)` re-checked against `manager-scope`. A manager's export never reads the interviews store and never contains `interview` rows. Each successful export writes exactly one `audit_events` row through the service role after every read and before the CSV is returned: target = the Employee ID (single), `all-employees[+archived]` (Administrator bulk) or `departments:<subtree department ids>[+archived]` (manager bulk, `record_department_activity_export`).
7. The application write paths are Staff provisioning, archive/restore (above) and Staff attendance (Story 1.5). Attendance entries live in the Supabase `attendance_entries` table behind `src/server/attendance-store.ts`, written through the user's JWT client: RLS lets staff read only entries of the employee linked to their auth user (`employees.auth_user_id`) and insert or update only that employee's entry for today (Dhaka date), lets Administrators read all, and has no delete policy. The staff employee id always comes from the session, never the form.

## Current data model

One TypeScript type, `Employee` (`src/data/employees.ts`), holds everything: identity fields, an evaluation summary, assessed skills, employment history, training entries, one current-work assignment (including a fixture "commits" count shown with a disclaimer), external interviews, and an attendance summary with dated records. Its basic fields (and `auth_user_id`, the link to the employee's Supabase account) are stored in the `employees` table, with unique Employee ID, primary email and `auth_user_id`; external interviews are stored in the `external_interviews` table (Story 2.1, read through `interviews-store`; RLS: the reporting employee or an Administrator only); skills and the evaluation summary are stored in `employee_skills` and `employee_evaluations` (Story 7.4, read through `assessments-store`, skills strongest first; RLS: Administrator, the employee, or a manager of the employee's department subtree), and the fixture is seed-only for them; the other nested fields are still a literal fixture array, merged in by `employees-store`. Training is read only through `src/server/training-store.ts`, and nothing reads the fixture for training at runtime (`src/data/employees.ts` is seed-only for training). Completed history comes from the RLS-protected `training_history` table (Story 3.1). Current enrolments come from the LMS adapter `src/server/lms-client.ts` (Story 3.2), whose fixed contract is `listCurrentEnrolments(employeeId): Promise<{ data, asOf, stale }>` (it throws `LmsUnavailableError` only when the LMS is unreachable). Until real LMS access exists it is a stub over the RLS-protected `lms_stub_enrolments` table (seeded from the fixture's in-progress entries), and data synced more than 24 hours ago (`LMS_STALE_AFTER_MS`, the stub's own constant) is marked stale. Only `training-store` imports `lms-client`: its `currentFor` makes one call per employee in parallel, splits the result into in-progress entries ("Current") and LMS-completed courses (appended to history, minus those already stored, matched on trimmed, case-insensitive programme and provider), and returns `unavailable` as a value. The page never awaits it: `src/app/page.tsx` passes the always-resolving promise to the client components, which read it with `use()` inside `<Suspense>` so history renders at once and Current shows loading, stale ("as of …") or unavailable states.

`src/domain/leave.ts` defines `CalendarPolicy`, `LeaveCategory`, and pure functions (`countWorkingDays`, `categoryForWorkingDays`, `rangesOverlap`) that are fully implemented and tested but have no caller in `src/app` or `src/components`. It exists ahead of the leave workflow described in [SRS.md](SRS.md) Section 11.4.

## Module boundaries (as implemented)

```text
src/domain       Pure rules; no database or framework imports (leave.ts only, currently unused by the UI)
src/server       Sign-in/out and provisioning server actions, Supabase clients, stores (employees, accounts, attendance, interviews, training), the LMS adapter (lms-client, called only by training-store), session types
src/middleware.ts  Supabase auth cookie refresh
src/data         The Employee type and the fixture that still supplies nested profile data
src/components   Client components: login form, and the portal (directory + profile + org-wide views)
src/app          The single route, root layout, and global styles
tests            Domain, server-action, component, and end-to-end scenarios (see tests/README below)
```

`supabase/migrations/` holds the forward-only migrations: the `employees` table with RLS policies (admin reads all rows via `app_metadata.role`; staff read only the row whose `auth_user_id = auth.uid()`; no write policies, so writes are service-role only), and (Story 1.4) `employees.archived_at`, the append-only `audit_events` table (RLS on with no policies; `update`/`delete`/`truncate` revoked from every API role including the service role, and triggers that raise on any update, delete or truncate) and the `set_employee_archived` function (execute granted to the service role only). Story 7.1 adds the app path for inserting `employees` rows: `createEmployeeAction` (`src/server/employee-actions.ts`, Administrator or department manager, zod-validated) calls `employeesStore.create()`, which refuses Staff, checks a manager's department against `manager-scope`, derives status, initials, avatar colour and summary (`src/domain/employee-input.ts`), and inserts through the signed-in user's JWT; the `employees_insert_admin` / `employees_insert_managed` RLS policies (`20261015000000_employee_create.sql`) enforce the same department rule and require a department, with no account link and not archived. Accounts are still created only by `accounts-store.create()`. Story 7.2 adds the only app path for updating existing `employees` rows (besides archive/restore): `updateEmployeeDetailsAction` (Administrator or department manager; refuses any form carrying a department; zod-validated) calls `employeesStore.updateDetails()`, which refuses Staff, checks a manager's employee against `manager-scope`, normalises and validates the five fields, and calls the SECURITY DEFINER function `update_employee_details` (`20261015010000_employee_details_update.sql`) through the signed-in user's JWT. The function re-checks authority (Administrator JWT or `manages_employee`, caller not archived) before any lookup and updates only title, team, manager, office and employment type; there is still no update policy on `employees`, so an employee's department changes only through a transfer. Story 7.4 adds the write paths for skills and the evaluation: `rateSkillAction` and `saveEvaluationAction` (`src/server/assessment-actions.ts`; Administrator or department manager, zod-validated) call `assessmentsStore.rateSkill()` / `saveEvaluation()` (`src/server/assessments-store.ts`), which refuse Staff (even on their own record), check a manager's employee against `manager-scope`, normalise and validate the input (`src/domain/assessment-input.ts`), and call the SECURITY DEFINER functions `rate_employee_skill` and `update_employee_evaluation` (`20261015030000_skills_and_evaluation.sql`) through the signed-in user's JWT. The functions re-check authority before any lookup and take the author (`updated_by`, the reviewer label) and the review date from the session; `employee_skills` and `employee_evaluations` have select-only RLS (Administrator, own, `manages_employee`) and no write policy.

## Test layout

```text
tests/leave.test.ts             Domain: leave calculation, categories, overlap
tests/session.test.ts           Session module: HMAC helpers gone, 8 h / 12 h session lengths
tests/staff-session.test.ts     Staff Supabase sessions: 12-hour window, malformed employee_id claims rejected
tests/auth.test.ts              Server actions: Supabase Administrator and Staff signIn/signOut/getSession (mocked Supabase); shared demo password rejected
tests/accounts-store.test.ts    accounts-store.create() for admin and staff (link, duplicates, race compensation), hasAdministrator() (fake client, plus live blocks when Supabase env is set)
tests/account-actions.test.ts   Administrator-only provisioning; Administrator and department-manager archive and restore actions: session check, actor from the session, error mapping, password never echoed
tests/manager-archive-rls.test.ts  Live (Supabase env): manager_set_employee_archived through each user's JWT: subtree, self, rank, Administrator target, plain Staff and anon rejected
tests/seed-demo-staff.test.ts   Offline environment checks of scripts/seed-demo-staff.ts
tests/no-registration.test.ts   No sign-up/registration route or call; only accounts-store creates auth users
tests/csv.test.ts               Domain: CSV row building/escaping extracted from the directory export
tests/components/login.test.tsx    Component: sign-in form validation/submission, axe scan
tests/components/portal.test.tsx   Component: directory search/filter/reset/export, profile tab rendering, axe scans
tests/e2e/admin-auth.spec.ts    Browser: retired demo credentials rejected; /signup and /register return 404
tests/e2e/manager-archive.spec.ts  Browser: a department manager archives a throwaway Staff account in their department (sign-in rejected) and restores it
tests/e2e/archive-account.spec.ts  Browser: Administrator archives a signed-in throwaway Staff account (session ends, sign-in rejected, hidden from the default directory) and restores it
tests/e2e/provision-staff.spec.ts  Browser: Administrator creates a Staff account for a throwaway employee, who then signs in to their own portal
tests/e2e/staff-attendance.spec.ts Browser: throwaway Staff accounts clock in/out; Administrator portal hidden; shared demo password rejected
tests/e2e/portal.spec.ts        Browser (throwaway Supabase Administrator from tests/e2e/global-setup.ts): full login → directory → profile → export → sign-out flow, desktop and mobile
tests/e2e/accessibility.spec.ts Browser: axe scan (WCAG 2.2 AA, colour-contrast excluded — see SRS.md 11.7) of the sign-in page, dashboard, and an open profile
```

Vitest runs `tests/**/*.test.ts` and `tests/**/*.test.tsx` under Node by default; component test files opt into `jsdom` per-file via the `// @vitest-environment jsdom` pragma so they can render React components without a browser. `tests/setup.ts` registers Testing Library's DOM cleanup and the `jest-axe` matcher for every test file.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: one job runs `npm run check` (typecheck, the full Vitest suite, and the production build), a second installs Chromium and runs `npm run test:e2e` (overriding the default `msedge` Playwright channel, since GitHub's Ubuntu runners don't have Edge installed) including the accessibility specs.

## Production architecture (partly implemented)

[SRS.md](SRS.md) Section 11 specifies the production requirements this section maps to a target shape. Rows marked **done** exist today; do not build against the rest as if it exists.

| Layer | Target choice | Replaces |
|---|---|---|
| Identity | Supabase Auth, administrator-provisioned accounts, two roles, archive/restore with an audit record (**done**, Stories 1.2–1.4) | The retired HMAC demo cookie |
| Data | Supabase PostgreSQL with forward-only migrations and RLS (**done** for employee basic details) | The remaining nested profile data in `src/data/employees.ts` |
| Domain | `src/domain/leave.ts` gains a caller: a leave-record service and UI | Currently orphaned code |
| Verification | RLS/policy and live account integration tests against the shared project (**done** for employees and accounts); extend to each new table | — |

### Target entities

| Entity | Important fields and constraints |
|---|---|
| `employees` | UUID PK, unique employee ID, unique canonical primary email, name, role enum, status enum, unique auth user ID, timestamps |
| `skills` / `employee_skills` | Skill name, employee FK, 1–5 level, evidence text, assessor, timestamp |
| `training_enrolments` | Employee FK, programme, provider, progress, target/completion date, result |
| `assignments` | Employee FK, project/workspace name, role, allocation, date range |
| `interviews` | Employee FK, external company, role, date, stage, outcome, feedback |
| `leave_records` | Employee FK, date range, working days > 0, category enum, calendar-version FK, timestamps — mirrors `src/domain/leave.ts` exactly |
| `holiday_calendars` / `holidays` | Version, jurisdiction, timezone, supported year range; calendar FK + date composite unique key |
| `audit_events` | Append-only UUID PK, actor, target, action, safe metadata, server timestamp |

PostgreSQL exclusion constraints should enforce same-employee leave-range non-overlap, matching [SRS.md](SRS.md) Section 11.4.

## Open decisions

- Whether `@supabase/ssr`/`@supabase/supabase-js` are removed now (unused) or kept pending near-term production work
- Organisation IANA timezone and holiday jurisdiction/source/supported years (SRS 11.5)
- Supabase organisation/project ownership and environments
- Retention periods and authorised production operators
- Whether deployment remains Vercel/Supabase after the demonstration
