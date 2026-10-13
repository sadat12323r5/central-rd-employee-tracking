# Epic 1 Context: Real Accounts & Durable Data

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the single shared demo credential and the compiled fixture and in-memory stores with named, individually provisioned Supabase Auth accounts and Supabase Postgres persistence protected by Row-Level Security. Administrators and Staff each sign in with their own account, and everything they enter survives a restart. This is the production release gate. Auth and persistence must land together before the workspace can hold real employee data, and every other roadmap epic except colour-contrast work depends on it. Employee records move first because sign-in, provisioning, and archiving all depend on them.

## Stories

- Story 1.1: Employee records persist with role-scoped access
- Story 1.2: Administrator signs in with a named account
- Story 1.3: Administrator provisions a Staff account
- Story 1.4: Administrator archives and restores an account
- Story 1.5: Staff attendance survives restarts

## Requirements & Constraints

- **Release gate:** the build must never be exposed with real employee data until named accounts and per-record authorization both exist. Until real data is loaded, the "all data is fictional" banner stays. Removing it is a System Owner decision and is not part of any story.
- **No self-registration anywhere.** Every account (Administrator or Staff) is created by an Administrator. The one sanctioned exception is a one-time seed script that creates the first Administrator. It has no runtime route.
- **Accounts are archived, never deleted or deactivated.** Archiving ends access on the very next request, keeps all history, hides the employee from the default directory (they stay reachable through an "archived" filter), and is reversible through restore. Staff can never archive any account, including their own. An Administrator cannot archive their own account.
- **Sign-in failures** show one generic "incorrect" message that never reveals which field was wrong. The same message applies to archived accounts.
- **Uniqueness:** Employee ID and primary email must be enforced by database constraints.
- **Unavailable dependencies:** every network-dependent read shows a clear error, stale, or loading state. It must never show an empty or partial list, or present failed data as saved or fresh. This applies to the directory, profiles, and attendance.
- **Secrets:** Supabase keys and any credentials are read only from environment configuration, never hard-coded or committed. The old `DEMO_*` credentials stop working as each story replaces them.
- **Definition of Done (every story):** zod validation in every new server action before any store call. Every new table has both a store-level check and an RLS policy, and neither substitutes for the other. Staff own-record identity comes from the session, never from form data. No hard-delete paths. Every new `src/domain/*` or `src/server/*` module has a matching `tests/*.test.ts`, and every acceptance criterion is covered by an automated test. `npm run check` and `npm run test:e2e` pass.
- **Approved settings:** the org timezone is `Asia/Dhaka` for date validation and display. Records are retained indefinitely. Dates display as `D MMM YYYY`, and status is always shown with a text label as well as colour.

## Technical Decisions

- **Layering (hexagonal, horizontal):** `src/domain/` is pure and imports nothing from the framework or database. `src/server/` holds both the store interfaces and their implementations. `src/data/` holds raw storage only. `src/app` and `src/components` form the UI. Do not create feature folders.
- **Store pattern:** every entity is accessed through a store in `src/server/` with the same shape as the existing `AttendanceStore`. A "not found" read returns `null`. Validation and authorization failures throw a typed error. Scoping depends on role: Administrator queries can read any employee, while Staff queries can read only the session's own `employeeId`. Invariants are enforced at the store layer, which is the load-bearing point.
- **`employees-store.ts`** replaces every direct fixture import. In particular, `auth.ts` must stop importing `src/data/employees.ts`. Nested profile data (skills, employment history, evaluation summary, attendance summary) keeps coming from the fixture behind the store until a later story moves it, and callers see no change.
- **`accounts-store.ts`** is the only path for account creation (`create()`), archiving (`archive()`), and restoring (`restore()`). Any other action that needs an account must call `create()` rather than build one inline. Each archive or restore writes one `audit_events` row in the same transaction.
- **`audit_events`** is append-only (actor, target, action, server timestamp). No code path may update or delete its rows. It is created in Story 1.4 and reused later for department transfers.
- **Sessions:** the session is a discriminated union by role. Today that is `admin` or `staff` with `employeeId`. The existing admin/staff routing in `page.tsx` stays unchanged. A `manager` role arrives in Epic 4 and is computed fresh on every request, so do not build anything that blocks it.
- **Staff provisioning (System Owner decisions):**
  - The Administrator sets the initial password and passes it on outside the app. There are no invite or magic-link emails, because the project has no SMTP, and no forced password change.
  - Creating an account links `employees.auth_user_id`.
  - Staff reads and the sign-in lookup move from the service-role client to the per-request JWT client.
  - The HMAC staff cookie and the shared `DEMO_STAFF_PASSWORD` are retired.
  - A seed step creates one demo Staff account linked to a fictional employee. Its credentials come from environment variables and are never shown on the sign-in page or in the repo.
- **Attendance:** the store's implementation moves from in-memory to Supabase, and the `AttendanceStore` interface does not change. Staff see only their own entries and Administrators see everyone's, enforced by RLS.
- **Server actions** return the `{ error, message }` `ActionState` shape. Dates are stored as ISO 8601 strings. Employee IDs must match `^BS-\d{4}$`.
- **Environment:**
  - One shared free-tier Supabase project serves local development, Vercel previews, and the demo. This is acceptable only while all data is fictional.
  - Migrations are forward-only SQL in `supabase/migrations/`, applied with the Supabase CLI. Pin the CLI version in devDependencies. A migration is applied to the shared project only after its PR is approved.
  - RLS is tested with Vitest integration tests that sign in as each role, using dedicated test accounts and rows the tests create and then clean up. Never use seeded demo employees. These tests run under `npm test` when Supabase credentials are present.
  - Environment variables: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` is server-only and used only by seed scripts, Administrator-only actions, and CI/e2e provisioning.
- **Stack:** Next.js 15.5.26, React 19.3, TypeScript 5.9.3, @supabase/supabase-js 2.117.2, @supabase/ssr 0.12.7, zod 4.6.5, Vitest 3.2.7, Playwright 1.63.0.

## Cross-Story Dependencies

- Stories are cut over one at a time, in order (1.1 → 1.5). Each merges on its own, and the demo credentials keep working until the story that replaces them lands.
- Story 1.1 provides the employees table and `employees-store`, which 1.2–1.4 depend on. Until Story 1.3 provisions real Staff, it uses a seeded test auth user.
- Story 1.2 introduces `accounts-store.create()` and the first-Administrator seed. Story 1.3 reuses `create()` for Staff, and Story 1.4 adds `archive()` and `restore()`.
- Story 1.3 carries over leftover work from 1.1 and 1.2: linking `auth_user_id`, moving to the JWT client, and retiring the HMAC cookie.
- Epics 2–5 and 7 all depend on this epic. Epic 4 will extend archive and restore rights to Department Managers for their own subtree, and will add the `manager` session role.
