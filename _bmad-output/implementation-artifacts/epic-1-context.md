# Epic 1 Context: Real Accounts & Durable Data

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the shared demo credentials and fixture/in-memory data with named, Administrator-provisioned Supabase Auth accounts and Supabase Postgres persistence protected by Row-Level Security, so Administrators and Staff sign in as accountable individuals and everything they enter survives a restart. Identity and persistence together are the release gate: until both land, the workspace must not hold real employee data under any configuration, and every other roadmap epic except colour-contrast remediation depends on this one. Employee records move first because sign-in, provisioning and archiving all need them.

## Stories

- Story 1.1: Employee records persist with role-scoped access
- Story 1.2: Administrator signs in with a named account
- Story 1.3: Administrator provisions a Staff account
- Story 1.4: Administrator archives and restores an account
- Story 1.5: Staff attendance survives restarts

## Requirements & Constraints

- **Release gate:** the build must never be exposed with real employee data until named accounts and per-record authorization both exist.
- **No self-registration, anywhere.** Administrators create every account. The only exceptions are seed scripts with no runtime route (first Administrator, demo Staff account).
- **Staff credential delivery:** the Administrator sets an initial password when provisioning and passes it on outside the app. No invite/magic-link email (no SMTP on the shared project); no forced password change at first sign-in.
- **Provisioning:** one account per employee; a second is rejected with a validation error. Staff sessions calling provisioning, archive or restore are rejected at the server, not just hidden in the UI.
- **Archive, never delete.** Archiving ends access on the account's next request, keeps all history, hides the employee from the default directory (an "archived" filter still shows them) and is reversible by restore. Each archive/restore writes a minimal audit record. Staff can never archive/restore any account, including their own; an Administrator cannot archive their own account.
- **Failed sign-in** shows one generic "incorrect" message without saying which field was wrong; archived accounts get the same message. Old `DEMO_ADMIN_*` credentials and the shared `DEMO_STAFF_PASSWORD` are rejected.
- **Secrets** come only from environment configuration; demo credentials never appear on the sign-in page or in the repo.
- **Network failure is visible:** an unreachable database yields an explicit error, stale or unavailable state, never an empty or partial list, and failed data is never presented as saved or fresh. This applies to the directory, profiles and attendance.
- **Uniqueness:** database constraints enforce unique Employee ID and primary email.
- **Settled config:** org timezone `Asia/Dhaka`; records kept indefinitely. The "all data is fictional" banner stays (removing it is a System Owner decision).
- **Definition of Done:** zod validation in every new server action before any store call; store-level check plus RLS policy on every new table (neither substitutes for the other); own-record identity from the session, never form data; no hard-delete paths; a `tests/*.test.ts` per new `src/server`/`src/domain` module with every acceptance criterion tested; `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Layering (hexagonal, horizontal):** `src/domain/` stays pure (no framework or database imports); `src/server/` holds store interfaces and implementations shaped like `AttendanceStore`; `src/data/` holds raw storage only; `src/app` and `src/components` form the UI. No feature folders. No direct fixture/DB imports from UI, domain or server actions. Not-found reads return `null`; validation/authorization failures throw typed errors. Invariants are enforced at the store layer, which is the load-bearing point.
- **Stores:** `employees-store.ts` (replaces every direct fixture import, including in `auth.ts`) and `accounts-store.ts`. Any other action that needs an account calls `create()` rather than building one inline. Nested profile data (skills, employment history, evaluation, attendance summary) stays fixture-backed behind `employees-store` for this epic.
- **Role scoping / RLS:** `admin` reads any employee (recognised via `app_metadata.role`); `staff` reads only rows where `employees.auth_user_id = auth.uid()`. Every employee read uses the per-request client carrying the user's JWT, so RLS is the enforced rule; the store also applies admin-all / staff-own scoping.
- **Session (Supabase Auth):** validated per request with `auth.getUser()`, with an 8-hour limit from `last_sign_in_at`. Role comes from `app_metadata.role`; staff identity comes from `app_metadata.employee_id`, so `getSession()` needs no database round trip (RLS still decides what the JWT can read). Session stays a discriminated union by role (`admin`, `manager`, `staff`); `manager` is derived fresh per request and only becomes real in Epic 4; an Administrator is always `admin`. Admin/staff routing in `page.tsx` is unchanged. Archive status is checked on every request, not left to token expiry.
- **Account creation:** `accounts-store.create()` is the sole creation path (seed scripts included). For Staff, `create({ role: "staff", employeeId, password })` uses the employee's own primary email, sets `app_metadata { role: "staff", employee_id }`, and links `employees.auth_user_id` with a conditional update, deleting the new auth user if the link fails or loses a race. Provisioning is triggered from the employee's profile.
- **Retired by Story 1.3:** the HMAC demo cookie, `DEMO_SESSION_SECRET`, `DEMO_STAFF_PASSWORD`, and the pre-session `findByEmail` sign-in lookup.
- **Service-role key** (`SUPABASE_SERVICE_ROLE_KEY`, server-only): runtime use limited to the Administrator-only provisioning action; otherwise only seed scripts (`scripts/seed-admin.ts`, `scripts/seed-demo-staff.ts`) and test provisioning. CI/e2e create throwaway Staff accounts through it. `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` live in Vercel and `.env.local`.
- **Archive/restore:** only via `accounts-store.archive()` / `restore()`, each writing one `audit_events` row in the same transaction. `audit_events` is append-only (actor, target, action, server timestamp); no code path updates or deletes its rows. Only this minimal form is decided; it is reused later for department transfers.
- **Attendance:** `AttendanceStore` interface unchanged while its implementation moves from in-memory to Supabase; existing tests must still pass. Staff see only their own entries and Administrators see everyone's, enforced by RLS.
- **Environments:** one shared free-tier Supabase project for local dev, Vercel Previews and the demo (fictional data only; production gets its own project before real data). No local Docker.
- **Migrations:** forward-only SQL in `supabase/migrations/` via the Supabase CLI pinned in devDependencies, applied to the shared project only after the story's PR is approved.
- **RLS tests:** Vitest integration tests sign in per role against the shared project using dedicated test accounts and rows they create and remove (never seeded demo employees); run under `npm test` when Supabase credentials are present.
- **Cutover:** staged, one story at a time in story order.
- **Conventions:** ISO 8601 date strings at rest; Employee IDs match `^BS-\d{4}$`; server actions return `ActionState` (`{ error, message }`); kebab-case file names.
- **Stack:** Next.js 15.5.26, React 19.3, TypeScript 5.9.3, @supabase/supabase-js 2.117.2, @supabase/ssr 0.12.7, zod 4.6.5, Vitest 3.2.7, Playwright 1.63.0.

## UX & Interaction Patterns

- Directory, profile and portal views render as before against persisted data.
- Staff-account provisioning lives on the employee's profile (Administrator only).
- Directory hides archived employees by default, with an "archived" filter.
- Signed-in Staff see only their own portal and cannot reach the Administrator portal.
- Database-unreachable states are explicit messages. Keep keyboard operability, text labels alongside colour, and `D MMM YYYY` dates.

## Cross-Story Dependencies

- Stories are cut over one at a time, in order (1.1 → 1.5). Each merges on its own, and the demo credentials keep working until the story that replaces them lands.
- **Precondition:** the shared Supabase project exists with keys in `.env.local` and Vercel.
- **1.1** creates `employees-store`, the employees table, uniqueness constraints and the RLS policies.
- **1.2** adds `accounts-store.create()`, the first-Administrator seed and Administrator sign-in with JWT-client reads.
- **1.3** completes the staff cutover: Staff provisioning, `auth_user_id` linking, `app_metadata.employee_id` session identity, JWT-client reads for everyone, HMAC/`findByEmail` retirement, demo Staff seed and e2e throwaway accounts.
- **1.4** extends `accounts-store` with archive/restore and creates `audit_events` (reused by Epic 4 for transfers and manager archiving).
- **1.5** relies on 1.3's Staff session identity and `auth_user_id` linking for attendance RLS.
- **Later epics:** this epic gates Epics 2–5 and 7; Epic 4 adds the `manager` role and subtree-scoped RLS on the employees and attendance tables built here, and extends archive and restore rights to Department Managers for their own subtree.
