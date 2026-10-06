# Architecture and data model

**Status:** describes the implemented prototype — supersedes the previous version, which described an unbuilt GitHub-webhook/logbook system. See [SRS.md](SRS.md) Section 12 for why that scope was dropped.

> **For new work, follow the architecture spine, not this document's "Production architecture" section.** As of 30 September 2026 the binding decisions for everything not yet built (accounts and roles, departments and managers, assignments and evaluations, the LMS adapter, archiving) live in [`_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md`](../_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md). The target entity list below predates it and is incomplete. This document stays accurate for the prototype as it exists today.

## Current architecture

The application is a single Next.js (App Router) deployable backed by one hosted Supabase project (Auth and Postgres).

| Layer | Choice | Responsibility |
|---|---|---|
| Web | Next.js 15 App Router + React 19 + TypeScript | The one route (`src/app/page.tsx`), layout, and client components |
| Session | Supabase Auth for Administrators and Staff (`src/server/auth.ts`, `src/server/supabase.ts`, `src/middleware.ts`); session types in `src/server/session.ts` | Administrators (Story 1.2) and Staff (Story 1.3) sign in with named Supabase accounts; the HMAC demo cookie is retired |
| Accounts | `src/server/accounts-store.ts`, `src/server/account-actions.ts` | The single account-creation path (`create()`), used by the Administrator-only Staff provisioning action and by the `db:seed-admin` / `db:seed-demo-staff` seed scripts |
| Data | Supabase `employees` table (`supabase/migrations/`) behind `src/server/employees-store.ts`, plus the TypeScript fixture (`src/data/employees.ts`) | Basic employee details and account links are in Postgres with RLS; nested profile data still comes from the fixture, merged by Employee ID |
| Domain | Framework-independent TypeScript (`src/domain/leave.ts`) | Pure leave-calculation logic; implemented and tested but not yet called from any route or component |
| Verification | Vitest (domain + server-action unit tests) and Playwright (browser scenarios) | See `tests/` |
| Hosting | Vercel | Static/serverless deployment of the demo (`vercel.json`) |

Employee basic details live in the Supabase `employees` table behind `src/server/employees-store.ts` (Story 1.1). Every read (Administrator and Staff) uses a per-request client carrying the user's Supabase JWT, so the RLS policies are enforced. At runtime the server-only service-role client is used only by Administrator provisioning.

## Trust boundaries (as implemented)

1. Every request to `src/app/page.tsx` calls `getSession()`. It validates the Supabase user server-side with `auth.getUser()` and returns `admin` for `app_metadata.role === "admin"` signed in under 8 hours ago, or `{ staff, employeeId }` for `role === "staff"` with an `employee_id` matching `^BS-\d{4}$`, signed in under 12 hours ago (both the account's last sign-in and the session's own password sign-in count). Anything else renders the sign-in page.
2. `src/middleware.ts` refreshes the Supabase auth cookies on each request, since Server Components cannot write cookies.
3. Accounts are created only through `accounts-store.create()`: by the seed scripts, and by `provisionStaffAccountAction`, which checks for an Administrator session at the server before anything else. A Staff account gets the employee's own primary email and `app_metadata.employee_id`, and `employees.auth_user_id` is linked conditionally (compensated by deleting the new user on failure). There is no sign-up route, form, invite or `auth.signUp` call, and sign-ups are disabled in Supabase Auth.
4. A wrong password, an unknown email, a valid Supabase user without a recognised role and a Staff user whose own employee row is not visible through RLS all get the same generic message. The retired `DEMO_ADMIN_*` credentials, the shared staff password and any old HMAC demo cookie are rejected or ignored.
5. Supabase keys come only from environment variables; the service-role key is server-only.
6. The only application write path is Staff provisioning (above). Attendance records are held in server memory until Story 1.5.

## Current data model

One TypeScript type, `Employee` (`src/data/employees.ts`), holds everything: identity fields, an evaluation summary, assessed skills, employment history, training entries, one current-work assignment (including a fixture "commits" count shown with a disclaimer), external interviews, and an attendance summary with dated records. Its basic fields (and `auth_user_id`, the link to the employee's Supabase account) are stored in the `employees` table, with unique Employee ID, primary email and `auth_user_id`; the nested fields are still a literal fixture array, merged in by `employees-store`.

`src/domain/leave.ts` defines `CalendarPolicy`, `LeaveCategory`, and pure functions (`countWorkingDays`, `categoryForWorkingDays`, `rangesOverlap`) that are fully implemented and tested but have no caller in `src/app` or `src/components`. It exists ahead of the leave workflow described in [SRS.md](SRS.md) Section 11.4.

## Module boundaries (as implemented)

```text
src/domain       Pure rules; no database or framework imports (leave.ts only, currently unused by the UI)
src/server       Sign-in/out and provisioning server actions, Supabase clients, stores (employees, accounts, attendance), session types
src/middleware.ts  Supabase auth cookie refresh
src/data         The Employee type and the fixture that still supplies nested profile data
src/components   Client components: login form, and the portal (directory + profile + org-wide views)
src/app          The single route, root layout, and global styles
tests            Domain, server-action, component, and end-to-end scenarios (see tests/README below)
```

`supabase/migrations/` holds the forward-only migrations: the `employees` table with RLS policies (admin reads all rows via `app_metadata.role`; staff read only the row whose `auth_user_id = auth.uid()`; no write policies, so writes are service-role only).

## Test layout

```text
tests/leave.test.ts             Domain: leave calculation, categories, overlap
tests/session.test.ts           Session module: HMAC helpers gone, 8 h / 12 h session lengths
tests/staff-session.test.ts     Staff Supabase sessions: 12-hour window, malformed employee_id claims rejected
tests/auth.test.ts              Server actions: Supabase Administrator and Staff signIn/signOut/getSession (mocked Supabase); shared demo password rejected
tests/accounts-store.test.ts    accounts-store.create() for admin and staff (link, duplicates, race compensation), hasAdministrator() (fake client, plus live blocks when Supabase env is set)
tests/account-actions.test.ts   Administrator-only Staff provisioning action: session check, error mapping, password never echoed
tests/seed-demo-staff.test.ts   Offline environment checks of scripts/seed-demo-staff.ts
tests/no-registration.test.ts   No sign-up/registration route or call; only accounts-store creates auth users
tests/csv.test.ts               Domain: CSV row building/escaping extracted from the directory export
tests/components/login.test.tsx    Component: sign-in form validation/submission, axe scan
tests/components/portal.test.tsx   Component: directory search/filter/reset/export, profile tab rendering, axe scans
tests/e2e/admin-auth.spec.ts    Browser: retired demo credentials rejected; /signup and /register return 404
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
| Identity | Supabase Auth, administrator-provisioned accounts, two roles (**done**, Stories 1.2–1.3); archiving next (Story 1.4) | The retired HMAC demo cookie |
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
