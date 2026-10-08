# Architecture and data model

**Status:** describes the implemented prototype — supersedes the previous version, which described an unbuilt GitHub-webhook/logbook system. See [SRS.md](SRS.md) Section 12 for why that scope was dropped.

> **For new work, follow the architecture spine, not this document's "Production architecture" section.** As of 30 September 2026 the binding decisions for everything not yet built (accounts and roles, departments and managers, assignments and evaluations, the LMS adapter, archiving) live in [`_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md`](../_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md). The target entity list below predates it and is incomplete. This document stays accurate for the prototype as it exists today.

## Current architecture

The application is a single Next.js (App Router) deployable with no database and no external services in its runtime path.

| Layer | Choice | Responsibility |
|---|---|---|
| Web | Next.js 15 App Router + React 19 + TypeScript | The one route (`src/app/page.tsx`), layout, and client components |
| Session | Supabase Auth for Administrators (`src/server/auth.ts`, `src/server/supabase.ts`, `src/middleware.ts`); HMAC-signed cookie for demo staff (`src/server/session.ts`) | Administrators sign in with named Supabase accounts (Story 1.2); demo staff keep the HMAC cookie until Story 1.3 |
| Accounts | `src/server/accounts-store.ts` | The single account-creation path (`create()`), used only by the one-time `npm run db:seed-admin` until Story 1.3 |
| Data | Compiled TypeScript fixture (`src/data/employees.ts`) | The entire dataset; regenerated from source on every build, not persisted or mutated at runtime |
| Domain | Framework-independent TypeScript (`src/domain/leave.ts`) | Pure leave-calculation logic; implemented and tested but not yet called from any route or component |
| Verification | Vitest (domain + server-action unit tests) and Playwright (browser scenarios) | See `tests/` |
| Hosting | Vercel | Static/serverless deployment of the demo (`vercel.json`) |

Employee basic details live in the Supabase `employees` table behind `src/server/employees-store.ts` (Story 1.1). Administrator reads use a per-request client carrying the user's Supabase JWT, so the RLS policies are enforced; staff reads and the pre-session staff sign-in lookup still use the server-only service-role client until Story 1.3.

## Trust boundaries (as implemented)

1. Every request to `src/app/page.tsx` calls `getSession()`. It returns `admin` only for a Supabase user validated server-side with `auth.getUser()` whose `app_metadata.role` is `admin` and who signed in under 8 hours ago; otherwise it falls back to the HMAC staff cookie. Anything else renders the sign-in page.
2. `src/middleware.ts` refreshes the Supabase auth cookies on each request, since Server Components cannot write cookies.
3. Administrator accounts are created only through `accounts-store.create()` (one-time seed script now; an Administrator-only action in Story 1.3). There is no sign-up route, form or `auth.signUp` call, and sign-ups are disabled in Supabase Auth.
4. A wrong password, an unknown email and a valid Supabase user without the `admin` role all get the same generic message. The old HMAC `admin` tokens and the retired `DEMO_ADMIN_*` credentials are rejected.
5. The staff HMAC secret (`DEMO_SESSION_SECRET`) is read from the environment and never sent to the browser; the staff password comparison hashes both sides and uses `timingSafeEqual`.
6. There is no write path anywhere in the application. Nothing a user does in the browser is persisted past the in-memory React state for that page load.

## Current data model

One TypeScript type, `Employee` (`src/data/employees.ts`), holds everything: identity fields, an evaluation summary, assessed skills, employment history, training entries, one current-work assignment (including a fixture "commits" count shown with a disclaimer), external interviews, and an attendance summary with dated records. There is no schema, no foreign keys, and no uniqueness enforcement — it is a literal array, not a database.

`src/domain/leave.ts` defines `CalendarPolicy`, `LeaveCategory`, and pure functions (`countWorkingDays`, `categoryForWorkingDays`, `rangesOverlap`) that are fully implemented and tested but have no caller in `src/app` or `src/components`. It exists ahead of the leave workflow described in [SRS.md](SRS.md) Section 11.4.

## Module boundaries (as implemented)

```text
src/domain       Pure rules; no database or framework imports (leave.ts only, currently unused by the UI)
src/server       Sign-in/out server actions, Supabase clients, stores (employees, accounts, attendance), staff HMAC sessions
src/middleware.ts  Supabase auth cookie refresh
src/data         The entire dataset, as compiled TypeScript literals
src/components   Client components: login form, and the portal (directory + profile + org-wide views)
src/app          The single route, root layout, and global styles
tests            Domain, server-action, component, and end-to-end scenarios (see tests/README below)
```

There is no `supabase/` directory, no migrations, and no RLS policies in this repository yet.

## Test layout

```text
tests/leave.test.ts             Domain: leave calculation, categories, overlap
tests/session.test.ts           Staff HMAC token signing/verification; legacy admin tokens rejected
tests/auth.test.ts              Server actions: Supabase Administrator and demo staff signIn/signOut/getSession (mocked Supabase)
tests/accounts-store.test.ts    accounts-store.create()/hasAdministrator() (fake client, plus a live block when Supabase env is set)
tests/no-registration.test.ts   No sign-up/registration route or call; only accounts-store creates auth users
tests/csv.test.ts               Domain: CSV row building/escaping extracted from the directory export
tests/components/login.test.tsx    Component: sign-in form validation/submission, axe scan
tests/components/portal.test.tsx   Component: directory search/filter/reset/export, profile tab rendering, axe scans
tests/e2e/admin-auth.spec.ts    Browser: retired demo credentials rejected; /signup and /register return 404
tests/e2e/portal.spec.ts        Browser (throwaway Supabase Administrator from tests/e2e/global-setup.ts): full login → directory → profile → export → sign-out flow, desktop and mobile
tests/e2e/accessibility.spec.ts Browser: axe scan (WCAG 2.2 AA, colour-contrast excluded — see SRS.md 11.7) of the sign-in page, dashboard, and an open profile
```

Vitest runs `tests/**/*.test.ts` and `tests/**/*.test.tsx` under Node by default; component test files opt into `jsdom` per-file via the `// @vitest-environment jsdom` pragma so they can render React components without a browser. `tests/setup.ts` registers Testing Library's DOM cleanup and the `jest-axe` matcher for every test file.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: one job runs `npm run check` (typecheck, the full Vitest suite, and the production build), a second installs Chromium and runs `npm run test:e2e` (overriding the default `msedge` Playwright channel, since GitHub's Ubuntu runners don't have Edge installed) including the accessibility specs.

## Production architecture (not yet implemented)

[SRS.md](SRS.md) Section 11 specifies the production requirements this section maps to a target shape. Do not build against this section as if it exists today.

| Layer | Target choice | Replaces |
|---|---|---|
| Identity | Supabase Auth, administrator-provisioned accounts, two roles | The single hand-rolled demo cookie |
| Data | Supabase PostgreSQL with forward-only migrations and RLS | `src/data/employees.ts` |
| Domain | `src/domain/leave.ts` gains a caller: a leave-record service and UI | Currently orphaned code |
| Verification | Add RLS/policy tests and integration tests against a real database | Today's fixture-only test suite |

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
