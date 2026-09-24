# Architecture and data model

**Status:** describes the implemented prototype — supersedes the previous version, which described an unbuilt GitHub-webhook/logbook system. See [SRS.md](SRS.md) Section 12 for why that scope was dropped.

## Current architecture

The application is a single Next.js (App Router) deployable with no database and no external services in its runtime path.

| Layer | Choice | Responsibility |
|---|---|---|
| Web | Next.js 15 App Router + React 19 + TypeScript | The one route (`src/app/page.tsx`), layout, and client components |
| Session | Hand-rolled HMAC-signed cookie (`src/server/session.ts`, `src/server/auth.ts`) | Demo administrator sign-in/out; not Supabase, despite `@supabase/*` being installed |
| Data | Compiled TypeScript fixture (`src/data/employees.ts`) | The entire dataset; regenerated from source on every build, not persisted or mutated at runtime |
| Domain | Framework-independent TypeScript (`src/domain/leave.ts`) | Pure leave-calculation logic; implemented and tested but not yet called from any route or component |
| Verification | Vitest (domain + server-action unit tests) and Playwright (browser scenarios) | See `tests/` |
| Hosting | Vercel | Static/serverless deployment of the demo (`vercel.json`) |

`@supabase/ssr` and `@supabase/supabase-js` are dependencies but are not imported anywhere in `src/`. They were added ahead of the production identity/persistence work described in [SRS.md](SRS.md) Section 11 and are currently dead weight in `package.json`.

## Trust boundaries (as implemented)

1. Every request to `src/app/page.tsx` calls `isSignedIn()`; a missing, malformed, tampered, or expired session cookie renders the sign-in page instead of the workspace.
2. The session secret (`DEMO_SESSION_SECRET`) is read from the environment and never sent to the browser; without it, a random secret is generated per process start, so every restart invalidates existing sessions.
3. Password comparison in `signIn` hashes both sides and uses `timingSafeEqual` to avoid a timing side channel.
4. There is exactly one identity and no per-record authorization: once signed in, that identity can read every fixture employee. This is acceptable only because the data is fictional (see [SRS.md](SRS.md) NFR-SEC-004) — it is not a model to extend with real data.
5. There is no write path anywhere in the application. Nothing a user does in the browser is persisted past the in-memory React state for that page load.

## Current data model

One TypeScript type, `Employee` (`src/data/employees.ts`), holds everything: identity fields, an evaluation summary, assessed skills, employment history, training entries, one current-work assignment (including a fixture "commits" count shown with a disclaimer), external interviews, and an attendance summary with dated records. There is no schema, no foreign keys, and no uniqueness enforcement — it is a literal array, not a database.

`src/domain/leave.ts` defines `CalendarPolicy`, `LeaveCategory`, and pure functions (`countWorkingDays`, `categoryForWorkingDays`, `rangesOverlap`) that are fully implemented and tested but have no caller in `src/app` or `src/components`. It exists ahead of the leave workflow described in [SRS.md](SRS.md) Section 11.4.

## Module boundaries (as implemented)

```text
src/domain       Pure rules; no database or framework imports (leave.ts only, currently unused by the UI)
src/server       Session signing/verification and the demo sign-in/out server actions
src/data         The entire dataset, as compiled TypeScript literals
src/components   Client components: login form, and the portal (directory + profile + org-wide views)
src/app          The single route, root layout, and global styles
tests            Domain, server-action, component, and end-to-end scenarios (see tests/README below)
```

There is no `supabase/` directory, no migrations, and no RLS policies in this repository yet.

## Test layout

```text
tests/leave.test.ts             Domain: leave calculation, categories, overlap
tests/session.test.ts           Domain: session token signing/verification
tests/auth.test.ts              Server actions: signIn/signOut/isSignedIn (src/server/auth.ts)
tests/csv.test.ts               Domain: CSV row building/escaping extracted from the directory export
tests/components/login.test.tsx    Component: sign-in form validation and submission
tests/components/portal.test.tsx   Component: directory search/filter/reset/export, profile tab rendering
tests/e2e/portal.spec.ts        Browser: full login → directory → profile → export → sign-out flow, desktop and mobile
```

Vitest runs `tests/**/*.test.ts` and `tests/**/*.test.tsx` under Node by default; component test files under `tests/components/` run under `jsdom` (configured via `environmentMatchGlobs` in `vitest.config.ts`) so they can render React components without a browser.

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
