# Epic 1 Context: Real Accounts & Durable Data

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the shared demo credentials and the fixture/in-memory data with named, Administrator-provisioned Supabase Auth accounts and Supabase Postgres persistence protected by Row-Level Security. Administrators and Staff then sign in as accountable individuals, and everything they enter survives a restart. Auth and persistence together form the release gate: until both land, the workspace must not hold real employee data under any configuration. Every other roadmap epic except colour-contrast remediation depends on this one. Employee records move first because sign-in, provisioning and archiving all need them.

## Stories

- Story 1.1: Employee records persist with role-scoped access
- Story 1.2: Administrator signs in with a named account
- Story 1.3: Administrator provisions a Staff account
- Story 1.4: Administrator archives and restores an account
- Story 1.5: Staff attendance survives restarts

## Requirements & Constraints

- **No self-registration, anywhere.** Administrators provision every account, both Administrator and Staff. The only exception is a one-time seed script, with no runtime route, that creates the first Administrator.
- **Archive, never delete.** Archiving ends access on the account's next request, keeps all history, hides the employee from the default directory (an "archived" filter still shows them), and can be reversed by restoring. Each archive or restore writes a minimal audit record. Staff can never archive or restore any account, including their own, and an Administrator cannot archive their own account.
- **Failed sign-in** shows one generic "incorrect" message that doesn't say which field was wrong. Archived accounts get the same message. Once Supabase auth is configured, the old `DEMO_*` credentials must be rejected.
- **Secrets** come only from environment configuration and are never hard-coded or committed.
- **Network failure is visible.** When the database is unreachable, every read shows a clear error, loading or unavailable state. It never shows an empty or partial list, and a write is never shown as saved when it wasn't.
- **Uniqueness:** database constraints enforce unique Employee ID and primary email.
- **Settled configuration:** the org timezone is `Asia/Dhaka` (for validating and displaying dates), and records are kept indefinitely.
- The "all data is fictional" banner stays until real data is loaded. Removing it is a System Owner decision, not part of any story.
- **Definition of Done for every story:** zod validation in each new server action; both a store-level check and an RLS policy on each new table; own-record identity taken from the session, never from form data; no hard-delete paths; a matching `tests/*.test.ts` for each new `src/server`/`src/domain` module, with every acceptance criterion tested; `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Layering (hexagonal, as horizontal layers):** `src/domain/` stays pure, with no framework or database imports. `src/server/` holds both the store interfaces and their implementations, following the shape of `AttendanceStore`. The UI layer never imports fixtures or the database directly.
- **Store per entity:** new stores in this epic are `employees-store.ts` and `accounts-store.ts`. Fix the existing violation where `auth.ts` imports `src/data/employees.ts` directly. A not-found read returns `null`; validation and authorization failures throw typed errors. Don't mix the two for equivalent cases.
- **Scoping by role:** an `admin` query may read any employee. A `staff` query reads only its session's `employeeId`. In Story 1.1, nested profile data (skills, employment history, evaluation, attendance summary) still comes from the fixture behind `employees-store`, with no change for callers.
- **Employees RLS policy shape:** `admin` is recognised by the role in the user's Supabase `app_metadata`; `staff` matches rows where `auth_user_id = auth.uid()`. These policies are written and integration-tested in Story 1.1.
- **Interim service-role read (Story 1.1 only, amended 2026-10-06):** until Story 1.2, requests still carry the HMAC demo session, not a Supabase JWT, so RLS cannot identify the caller. `employees-store` therefore reads through the server-only service-role client (`src/server/supabase.ts`) and enforces admin-all / staff-own scoping in the app layer. This temporarily stretches the "service role only for seed and Administrator actions" rule. **Story 1.2 must** switch `employees-store` to a per-request Supabase client carrying the signed-in user's JWT, so RLS becomes the enforced rule, and remove the runtime service-role read.
- **Accounts (one path for each operation):** `accounts-store.create()` is the only way to create an account. `archive()` and `restore()` are the only archive and restore paths, and each writes its audit row in the same transaction. Archiving must take effect on the next request, so check archive status per request instead of relying on token expiry.
- **Audit table:** `audit_events` is append-only (actor, target, action, server timestamp). No code path may update or delete its rows. Its minimal form is all that is decided.
- **Session:** Supabase Auth replaces the hand-rolled HMAC cookie. The session stays a discriminated union by role, using the three roles `admin`, `manager` and `staff`. `manager` is derived fresh on each request (it only becomes real in Epic 4), and an Administrator is always `admin`. The admin/staff routing in `page.tsx` stays unchanged.
- **Attendance:** the `AttendanceStore` interface stays unchanged while its implementation moves from in-memory to Supabase. The existing tests must still pass.
- **Environments:** one shared, hosted Supabase project on the free tier serves local dev, Vercel Previews and the demo. It is acceptable only while all data is fictional. Before any real data is loaded, production must move to its own project. There is no local Docker.
- **Migrations:** forward-only SQL in `supabase/migrations/`, applied with the Supabase CLI. Pin the CLI version in devDependencies when Story 1.1 adds it. A story's migration is applied to the shared project only once its PR is approved, never while the story is in progress. CI automation for migrations is deferred.
- **RLS tests:** Vitest integration tests sign in as each role (`admin`, `manager`, `staff`) against the shared project and check what each role can and can't read or write. They use dedicated test accounts and rows the test creates and removes itself, never the seeded demo employees. They run with `npm test` when Supabase credentials are present.
- **Secrets:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set in Vercel for both Preview and Production, and in `.env.local`. `SUPABASE_SERVICE_ROLE_KEY` is server-only (never `NEXT_PUBLIC_`) and is used only by the seed script and Administrator-only server actions. (The Story 1.1 runtime read above is the one temporary exception.) The `DEMO_*` variables are retired as Stories 1.2 and 1.3 land.
- **Cutover:** staged, one story at a time in story order. Each story merges on its own, and the demo credentials keep working until the story that replaces them.
- **Conventions:** dates are ISO 8601 strings at rest. Employee IDs match `^BS-\d{4}$`. Server actions return `{ error, message }` (`ActionState`). Files are kebab-case. Stack: `@supabase/supabase-js` 2.117.2, `@supabase/ssr` 0.12.7, zod 4.6.5, Vitest 3.x, on Next.js 15.5.26 and React 19.

## UX & Interaction Patterns

- Existing directory, profile and portal views must render as before against persisted data.
- The directory hides archived employees by default and has an "archived" filter to show them.
- A signed-in Staff member sees only their own portal and cannot reach the Administrator portal; the server enforces this, not just the UI.
- Error states (database unreachable) are explicit messages, never blank or partial lists.
- Keep keyboard operability, text labels alongside colour for status, and `D MMM YYYY` date formatting.

## Cross-Story Dependencies

- **Before any story starts:** the shared Supabase project must exist, with its keys in `.env.local` and Vercel.
- **Story 1.1 comes first.** It creates `employees-store`, the employees table and the RLS foundation. Its Staff RLS test uses a seeded test auth user until Story 1.3 provisions real accounts.
- **Story 1.2** adds `accounts-store.create()` and the seed script, and replaces Story 1.1's interim service-role employee read with a per-request JWT client so RLS is enforced. Stories 1.3 and 1.4 build on that store.
- **Story 1.4** creates `audit_events`, which Epic 4 later reuses for department transfers and manager archiving.
- **Story 1.5** is independent of 1.2–1.4 but needs the RLS session identity from 1.1/1.2.
- **Later epics:** this epic gates Epics 2–5 and 7. Epic 4 extends the session with the `manager` role and adds subtree-scoped RLS to the employees and attendance tables built here.
