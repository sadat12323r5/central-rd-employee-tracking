---
title: 'Story 1.2 — Administrator signs in with a named account'
type: 'feature'
created: '2026-10-06'
status: 'done'
baseline_revision: '01c98cd800963214d88f3730a71e6d2c3fb69a26'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Sign-ups are still enabled on the hosted Supabase project; anyone with the public anon key can create an Auth user.
    evidence: |-
      supabase/config.toml enable_signup = false only affects a local stack. Such a user gets no admin session (role check) and no RLS rows, but AD-6 says no self-registration anywhere. The dashboard setting must be turned off by a human (docs/DEPLOYMENT.md); afterwards a live test calling anon.auth.signUp and expecting failure can be added.
    location: >-
      supabase/config.toml, docs/DEPLOYMENT.md
    severity: medium
  - summary: >-
      Throwaway e2e/test Administrators are left behind if a run is killed before teardown, and they make db:seed-admin refuse to run.
    evidence: |-
      tests/e2e/global-setup.ts and the live accounts-store test create admin-role users; cleanup is in globalTeardown/afterAll only. A setup-time sweep of stale e2e-admin-*/accounts-test-* users would fix it.
    location: >-
      tests/e2e/global-setup.ts
    severity: medium
  - summary: >-
      The seed script's "Administrator already exists" exit is tested only below the script (seedFirstAdministrator), not via the spawned process.
    evidence: |-
      Reaching that branch from a spawned process needs a live or stubbed Supabase Auth endpoint; the decision logic is unit-tested.
    location: >-
      scripts/seed-admin.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Administrator signs in with one shared demo credential (`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD`, defaulting to public values), so access to employee data is not tied to a person, and Administrator employee reads bypass RLS through the service-role client.

**Approach:** Administrators sign in through Supabase Auth (email + password); the session is the Supabase auth cookie, and `admin` comes from `app_metadata.role`. Add `accounts-store.create()` as the single account-creation path and a one-time seed script that creates the first Administrator through it. Administrator employee reads switch to a per-request client carrying the user's JWT, so RLS is enforced. Staff demo sign-in stays unchanged until Story 1.3 (staged cutover).

## Boundaries & Constraints

**Always:**
- A wrong email, wrong password, unknown account, or a valid Supabase user whose `app_metadata.role` is not `admin` all return the same message: "The email or password is incorrect. Please try again." Supabase/network failure returns "Sign-in is temporarily unavailable. Please try again shortly."
- `getSession()` returns `{ role: "admin" }` only for a Supabase user verified with `auth.getUser()` (server-validated, never `getSession()` from cookies alone) whose `app_metadata.role === "admin"` and whose `last_sign_in_at` is under 8 hours old (keeps FR-SESS-002's 8-hour Administrator session); otherwise it falls through to the staff HMAC cookie.
- The HMAC cookie now yields only `staff` identities; an old HMAC `admin` token is treated as signed out.
- `accounts-store.create()` validates input with zod (email, password ≥ 12 chars, role `admin`), creates the auth user with `email_confirm: true` and `app_metadata: { role }`, and throws typed errors: `AccountValidationError`, `AccountExistsError` (duplicate email), `AccountsUnavailableError` (other failures).
- The seed script refuses to run if any Administrator already exists, reads `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` from the environment or `.env.local`, and never prints the password or keys.
- Supabase keys come only from environment variables (NFR-SEC-002).
- Admin/staff routing in `page.tsx` is unchanged.

**Never:**
- Any sign-up/registration route, form, link, or `auth.signUp` call.
- Any runtime route or server action that creates accounts (Story 1.3 adds the Administrator-session one).
- Staff provisioning, linking `auth_user_id`, archive/restore, or a database migration.
- Hard-coding or committing credentials; keeping the `DEMO_ADMIN_*` branch or its on-screen hint.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin signs in | correct email/password of a Supabase user with role `admin` | Supabase auth cookies set, redirect to `/`, Administrator workspace renders | — |
| Wrong password | admin email, wrong password | generic "incorrect" message, no cookie | — |
| Unknown email | email with no account | same generic message | — |
| Non-admin Supabase user | valid credentials, role missing or `staff` | same generic message; the Supabase session is signed out | — |
| Old demo credentials | `manager@example.com` / `Brain23Demo!` | same generic message | — |
| Staff demo sign-in | employee email + staff demo password | unchanged: staff HMAC session | DB down → "temporarily unavailable" |
| Supabase unreachable | network/5xx from auth | "temporarily unavailable" message | logged without values |
| Stale admin session | `last_sign_in_at` older than 8h | treated as signed out → sign-in page | — |
| Seed with no admin | env set, no admin exists | creates one admin via `create()`, prints the email only | — |
| Seed when admin exists | any admin already exists | exits non-zero, creates nothing | — |
| Seed with missing/invalid env | missing or short password | exits non-zero with a message naming the variable | — |
| Duplicate account | `create()` with an existing email | `AccountExistsError` | — |

</intent-contract>

## Code Map

- `src/server/auth.ts` — `signIn`, `signOut`, `getSession`, `isSignedIn`; drop the `DEMO_ADMIN_*` branch (lines 27-35), add the Supabase admin path; keep the staff branch (lines 36-50) as is.
- `src/server/session.ts` — HMAC sessions; `readSession` (line 30) must stop accepting `role: "admin"`. `SessionIdentity` type stays.
- `src/server/supabase.ts` — add `getUserClient()`: `createServerClient` from `@supabase/ssr` with the anon key and `cookies()` (`setAll` wrapped in try/catch, since Server Components cannot set cookies).
- `src/middleware.ts` (new) — standard `@supabase/ssr` session refresh (`auth.getUser()`), matcher excluding `_next/static`, `_next/image`, favicon and image files.
- `src/server/employees-store.ts:65,103` — `createEmployeesStore` takes `{ userClient: () => Promise<SupabaseClient>, serviceClient: () => SupabaseClient }`; admin `listFor`/`getFor` use `userClient` (RLS-enforced); staff reads and `findByEmail` keep `serviceClient` with app-layer scoping until Story 1.3. Update the header comment.
- `src/server/accounts-store.ts` (new) — `createAccountsStore(getClient)` with `create()` and `hasAdministrator()`. Import only types from other `src/` modules (`import type`) so Node can load it from the seed script.
- `scripts/seed-admin.ts` (new) — mirror `scripts/seed-employees.ts` (env loading, dynamic import by URL, service client); `package.json` script `db:seed-admin`.
- `src/app/page.tsx:12` and `src/components/login.tsx:25` — remove the manager demo hint; show only the staff hint, when `DEMO_STAFF_PASSWORD` is unset.
- `supabase/config.toml` — `[auth] enable_signup = false` (documents intent; the hosted project setting is a manual step).
- `playwright.config.ts` — drop `DEMO_ADMIN_*`; add `globalSetup`/`globalTeardown` (`tests/e2e/global-setup.ts`, `global-teardown.ts`) that create and delete a throwaway admin (`e2e-admin-<runid>@example.test`, random password) with the service-role admin API and expose it via `process.env.E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD`. Keep the existing `channel` handling.
- `tests/e2e/portal.spec.ts`, `tests/e2e/accessibility.spec.ts` — sign in with the throwaway admin.
- `tests/auth.test.ts`, `tests/attendance-actions.test.ts`, `tests/components/login.test.tsx`, `tests/session.test.ts`, `tests/staff-session.test.ts`, `tests/employees-store.test.ts` — existing tests to adapt; mock `@/server/supabase` (or inject) so unit tests stay offline.
- `tests/employees-rls.test.ts` — the pattern for live tests: skip without env, throwaway users, cleanup in `afterAll`.
- `.env.example`, `docs/DEPLOYMENT.md`, `README.md`, `docs/ARCHITECTURE.md` — replace `DEMO_ADMIN_*` docs with the seed step and the manual "disable sign-ups" step.

## Tasks & Acceptance

**Execution:**
- `src/server/supabase.ts` -- add `getUserClient()` -- per-request JWT client.
- `src/middleware.ts` -- refresh Supabase auth cookies -- tokens expire hourly; Server Components cannot set cookies.
- `src/server/accounts-store.ts` -- `create()`, `hasAdministrator()`, typed errors -- AD-6 single creation path.
- `scripts/seed-admin.ts`, `package.json` -- one-time first-Administrator seed -- the sanctioned AD-6 exception.
- `src/server/session.ts`, `src/server/auth.ts` -- Supabase admin sign-in/out, 8h check, HMAC staff-only -- AC 1-2, 5.
- `src/server/employees-store.ts` -- admin reads via `userClient` -- RLS enforced for Administrators.
- `src/app/page.tsx`, `src/components/login.tsx` -- remove manager demo hint -- old credentials retired.
- `supabase/config.toml` -- `enable_signup = false`.
- `playwright.config.ts`, `tests/e2e/*` -- throwaway admin; add an e2e test that the old demo credentials are rejected and that `/signup` and `/register` return 404.
- `tests/accounts-store.test.ts` -- fake-client unit tests for validation, role metadata, duplicate → `AccountExistsError`, failure → `AccountsUnavailableError`, `hasAdministrator`; plus a live block (skipped without env) that creates an admin through `create()`, signs in with the anon client, checks `app_metadata.role`, and deletes it.
- `tests/auth.test.ts` -- cover every I/O matrix sign-in/session row with a mocked Supabase client.
- `tests/employees-store.test.ts` -- admin uses user client, staff/findByEmail use service client.
- `tests/no-registration.test.ts` -- scan `src/` for routes/files named `signup|sign-up|register` and for `auth.signUp`; expect none.
- Docs files listed above -- updated setup.
- `_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/.memlog.md` -- append a 2026-10-06 amendment: Story 1.2 enforces RLS for Administrator reads; the staff interim service-role read and pre-session `findByEmail` lookup remain until Story 1.3 gives staff Supabase accounts linked by `auth_user_id`.

**Acceptance Criteria:**
- Given an Administrator account in Supabase Auth, when the L&D manager signs in, then the existing Administrator workspace renders (e2e) and `getSession()` returns `{ role: "admin" }`.
- Given the app's routes and source, when inspected, then no sign-up or registration route, form or call exists.
- Given no Administrator exists, when `npm run db:seed-admin` runs, then exactly one Administrator is created through `accounts-store.create()`, and no other code path in `src/` or `scripts/` calls `auth.admin.createUser` (tests excepted).
- Given an Administrator session, when the directory loads, then employees are read with the user's JWT (RLS), not the service-role key.
- Given the old `DEMO_ADMIN_*` credentials, when submitted, then they are rejected, and no Supabase key appears in source.

## Design Notes

**Why staff stay on the service-role read.** Staff have no Supabase accounts until Story 1.3, and seeded rows have `auth_user_id` NULL, so a JWT client cannot serve them. The Story 1.1 amendment's "retire the runtime service-role read" is satisfied for Administrators now and for staff in 1.3; the epic's staged-cutover rule keeps demo staff sign-in working until then.

**Why there is no runtime accounts-store singleton.** Nothing at runtime creates accounts until Story 1.3; keeping `accounts-store.ts` free of value imports lets `node --experimental-strip-types` load it from the seed script.

**Throwaway e2e admin.** Matches the RLS-test convention (dedicated test accounts, created and removed by the test), so e2e never needs a real Administrator's password.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, all unit tests (live Supabase tests included when env is present), and the build pass.
- `npm run test:e2e` -- expected: all specs pass, including the new rejection/404 checks.
- `grep -rn "Brain23Demo\|DEMO_ADMIN" src tests playwright.config.ts` -- expected: no matches except a test asserting rejection.

## Auto Run Result

Status: done

**Summary:** Administrators now sign in with named Supabase Auth accounts. `admin` comes from `app_metadata.role`, validated with `getUser()` on each request, and the 8-hour limit is checked against both the user's last sign-in and the session's own password sign-in time. The old `DEMO_ADMIN_*` credentials are gone. `accounts-store.create()` is the single account-creation path, and `npm run db:seed-admin` creates the first Administrator through it. Administrator employee reads use a per-request JWT client, so RLS is enforced. Demo staff sign-in is unchanged until Story 1.3. There is no database migration.

**Files changed:**
- `src/server/auth.ts`: Supabase admin sign-in, sign-out and session checks. Staff stay on HMAC, and staff sign-in ends any admin session.
- `src/server/session.ts`: the HMAC cookie now yields staff identities only; `verifySession` is removed.
- `src/server/supabase.ts`: `getUserClient()`.
- `src/middleware.ts`: Supabase cookie refresh.
- `src/server/employees-store.ts`: admin reads use the user client; staff reads and `findByEmail` keep the service client.
- `src/server/accounts-store.ts`: `create`, `hasAdministrator`, `seedFirstAdministrator` and the typed errors.
- `scripts/seed-admin.ts`, `package.json` (`db:seed-admin`): the one-time seed.
- `src/app/page.tsx`, `src/components/login.tsx`: the manager demo hint is removed.
- `supabase/config.toml`: `enable_signup = false`.
- `playwright.config.ts`, `tests/e2e/*`: a throwaway e2e admin, plus checks for rejected demo credentials and 404 on sign-up routes.
- Tests: new `accounts-store`, `middleware`, `no-registration` and `seed-admin` tests; updated `auth`, `employees-store`, `page`, `session`, `staff-session`, `attendance-actions` and `login`.
- Docs: `.env.example`, `docs/DEPLOYMENT.md`, `README.md`, `docs/ARCHITECTURE.md`, and a memlog amendment.

**Review:** 29 findings:
- 12 patch rows: 5 medium, 6 low, 1 maybe-false, by entry verdict.
- 4 defer rows, covering 3 unique items.
- 13 rejected, with reasons in the triage log.

**Follow-up review recommended:** true, because more than one medium entry was patched. The unverified risk: the `amr`-based session check and the middleware refresh haven't been exercised across a real access-token refresh, about an hour after sign-in. e2e runs finish within minutes.

**Verification:**
- `npm run check` passed: 18 files, 183 tests including the live Supabase tests, plus the build.
- `npm run test:e2e` passed 12/12 locally, using the preinstalled Chromium.
- A grep finds `Brain23Demo`/`DEMO_ADMIN` only in tests asserting rejection.

**Residual risks / human actions:**
- No Administrator exists on the shared project yet. Someone must run `npm run db:seed-admin` with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. Until then nobody can reach the admin workspace on the deployed app.
- Disable sign-ups in the hosted Supabase dashboard.
- Staff reads still use the service-role client until Story 1.3.

