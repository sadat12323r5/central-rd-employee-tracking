# Epic 1 Context: Real Accounts & Durable Data

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the shared demo credentials and the fixture/in-memory data with named, Administrator-provisioned Supabase Auth accounts and Supabase Postgres persistence protected by Row-Level Security. Administrators and Staff then sign in as accountable individuals, and everything they enter survives a restart. Auth and persistence together are the release gate: until both land, the workspace must not hold real employee data under any configuration. Every other roadmap epic except colour-contrast remediation depends on this one. Employee records move first because sign-in, provisioning and archiving all need them.

## Stories

- Story 1.1: Employee records persist with role-scoped access
- Story 1.2: Administrator signs in with a named account
- Story 1.3: Administrator provisions a Staff account
- Story 1.4: Administrator archives and restores an account
- Story 1.5: Staff attendance survives restarts

## Requirements & Constraints

- **No self-registration, anywhere.** Administrators provision every account, Administrator and Staff alike. The only exception is a one-time seed script with no runtime route, which creates the first Administrator. Seed steps for demo accounts are not runtime routes either.
- **Staff credential delivery (decided 2026-10-06):** the Administrator sets an initial password when creating a Staff account and passes it on outside the app. There is no invite or magic-link email, because the shared project has no SMTP and the default mailer is rate-limited. A forced password change at first sign-in is out of scope.
- **Provisioning rules:** one account per employee; a second one is rejected with a validation error. A Staff session calling provisioning, archive or restore directly is rejected at the server, not only hidden in the UI.
- **Archive, never delete.** Archiving ends access on the account's next request, keeps all history, hides the employee from the default directory (an "archived" filter still shows them), and is reversible by restoring. Each archive or restore writes a minimal audit record. Staff can never archive or restore any account, including their own. An Administrator cannot archive their own account.
- **Failed sign-in** shows one generic "incorrect" message that doesn't say which field was wrong. Archived accounts get the same message. Once Supabase auth is configured, the old `DEMO_ADMIN_*` credentials and the shared `DEMO_STAFF_PASSWORD` are rejected.
- **Secrets** come only from environment configuration and are never hard-coded or committed. Demo account credentials are never shown on the sign-in page or in the repo.
- **Network failure is visible.** When the database is unreachable, reads show a clear error, loading or unavailable state, never an empty or partial list. A write is never shown as saved when it wasn't.
- **Uniqueness:** database constraints enforce unique Employee ID and primary email.
- **Settled configuration:** the org timezone is `Asia/Dhaka` and records are kept indefinitely.
- The "all data is fictional" banner stays until real data is loaded. Removing it is a System Owner decision, not part of any story.
- **Definition of Done for every story:** zod validation in each new server action; both a store-level check and an RLS policy on each new table; own-record identity taken from the session, never from form data; no hard-delete paths; a matching `tests/*.test.ts` for each new `src/server`/`src/domain` module, with every acceptance criterion tested; `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Layering:** `src/domain/` stays pure. `src/server/` holds store interfaces and implementations, following the shape of `AttendanceStore`. The UI never imports fixtures or the database directly. A not-found read returns `null`; validation and authorization failures throw typed errors.
- **Stores in this epic:** `employees-store.ts` and `accounts-store.ts`. `auth.ts` must not import `src/data/employees.ts` directly. Nested profile data (skills, employment history, evaluation, attendance summary) stays fixture-backed behind `employees-store` for this epic.
- **Role scoping and RLS:** an `admin` may read any employee; a `staff` caller reads only its own session's `employeeId`. In RLS, `admin` is recognised by the role in Supabase `app_metadata`, and `staff` matches rows where `employees.auth_user_id = auth.uid()`.
- **Staged move off the service-role client:** Story 1.1 read employees through the server-only service-role client, with scoping enforced in the app layer, because requests still carried the HMAC demo session. Story 1.2 moved only Administrators to Supabase Auth. **Story 1.3 carries over the rest:** link `employees.auth_user_id` when an account is created, switch staff reads and the sign-in lookup to the per-request JWT client so RLS is enforced, and retire the HMAC staff cookie. Seeded rows have `auth_user_id` NULL until linked, so the staff RLS policy matches no one before then.
- **Accounts (one path for each operation):** `accounts-store.create()` is the only way to create an account (seed scripts included). `archive()` and `restore()` are the only archive and restore paths, and each writes its audit row in the same transaction. Check archive status on every request instead of relying on token expiry.
- **Demo and test Staff accounts (decided 2026-10-06):** a seed step creates one real demo Staff account linked to a fictional seeded employee, with its email and password taken from environment variables. CI and e2e provision their own throwaway Staff account through the service role.
- **Audit table:** `audit_events` is append-only (actor, target, action, server timestamp), and no code path may update or delete its rows. Only this minimal form is decided.
- **Session:** Supabase Auth replaces the HMAC cookie. The session stays a discriminated union by role (`admin`, `manager`, `staff`). `manager` is derived fresh on each request and only becomes real in Epic 4. An Administrator is always `admin`. The admin/staff routing in `page.tsx` is unchanged.
- **Attendance:** the `AttendanceStore` interface stays the same while its implementation moves from in-memory to Supabase, and the existing tests must still pass.
- **Environments:** one shared, hosted, free-tier Supabase project serves local dev, Vercel Previews and the demo. That is acceptable only while all data is fictional; production gets its own project before real data. There is no local Docker.
- **Migrations:** forward-only SQL in `supabase/migrations/`, applied with the pinned Supabase CLI. A story's migration is applied to the shared project only after its PR is approved.
- **RLS tests:** Vitest integration tests sign in as each role against the shared project, using dedicated test accounts and rows the test creates and removes itself (never the seeded demo employees). They run with `npm test` when Supabase credentials are present.
- **Secrets:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set in Vercel (Preview and Production) and in `.env.local`. `SUPABASE_SERVICE_ROLE_KEY` is server-only and used only by seed scripts, test provisioning and Administrator-only server actions such as provisioning. The `DEMO_*` variables are retired by the end of Story 1.3.
- **Cutover:** staged, one story at a time in story order. The demo credentials keep working until the story that replaces them.
- **Conventions:** dates are ISO 8601 strings at rest. Employee IDs match `^BS-\d{4}$`. Server actions return `ActionState` (`{ error, message }`). File names are kebab-case.

## UX & Interaction Patterns

- Existing directory, profile and portal views render as before against persisted data.
- The directory hides archived employees by default, with an "archived" filter to show them.
- A signed-in Staff member sees only their own portal and cannot reach the Administrator portal.
- Database-unreachable states are explicit messages, never blank or partial lists.
- Keep keyboard operability, text labels alongside colour for status, and `D MMM YYYY` dates.

## Cross-Story Dependencies

- **Before any story:** the shared Supabase project exists, with its keys in `.env.local` and Vercel.
- **Story 1.1** creates `employees-store`, the employees table and the RLS foundation.
- **Story 1.2** adds `accounts-store.create()`, the first-Administrator seed and Administrator sign-in via Supabase Auth.
- **Story 1.3** builds on `accounts-store` and finishes the staff cutover: `auth_user_id` linking, JWT-client staff reads and sign-in lookup, HMAC staff cookie retired, demo Staff seed and e2e throwaway accounts.
- **Story 1.4** builds on `accounts-store` and creates `audit_events`, which Epic 4 later reuses for department transfers and manager archiving.
- **Story 1.5** needs the Staff session identity and `auth_user_id` linking from Story 1.3 for its RLS.
- **Later epics:** this epic gates Epics 2–5 and 7. Epic 4 adds the `manager` role and subtree-scoped RLS on the employees and attendance tables built here.
