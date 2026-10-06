---
title: 'Story 1.3 — Administrator provisions a Staff account'
type: 'feature'
created: '2026-10-06'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-admin-named-account.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Staff sign in with one shared demo password (`DEMO_STAFF_PASSWORD`, default `Staff23Demo!`) and an HMAC cookie. Their access is not tied to a person, and staff employee reads bypass RLS through the service-role client.

**Approach:** An Administrator creates a Staff account for an existing employee from the employee's profile and sets an initial password. The account is created through `accounts-store.create()`, which also links `employees.auth_user_id`. Every sign-in (Administrator and Staff) goes through Supabase Auth. The HMAC cookie and `DEMO_STAFF_PASSWORD` are retired, and all employee reads use the per-request JWT client so RLS is enforced. A seed script creates one demo Staff account from env vars. e2e provisions throwaway Staff accounts through the service role.

## Boundaries & Constraints

**Always:**
- Account email for a Staff account = the employee's primary email from the `employees` row (never from the form). The form submits only `employeeId` and the initial password (≥ 12 chars, the same rule as Administrators).
- A Staff auth user gets `app_metadata: { role: "staff", employee_id: "<BS-nnnn>" }` (only the service role can set it) and `email_confirm: true`.
- Linking is atomic in effect: the employee row is updated only `where employee_id = ? and auth_user_id is null`. If that touches 0 rows or fails, the just-created auth user is deleted (best effort) and a typed error is thrown. An employee that already has `auth_user_id` is rejected before any user is created.
- The provisioning server action checks `getSession()` is `admin` at the server first. Any other session, or none, gets an error state and nothing is created. Input is validated with zod; errors are returned as `ActionState` (`{ error, message }`), never thrown to the UI. The initial password is never logged or echoed back.
- `getSession()`: one Supabase path. `getUser()` (server-validated) → `role === "admin"` → `{ role: "admin" }` within 8 h; `role === "staff"` with an `employee_id` matching `^BS-\d{4}$` → `{ role: "staff", employeeId }` within 12 h (`sessionHours`). The window applies to both `last_sign_in_at` and the session's `amr` password timestamp, as for admins today. Anything else → `null`.
- Sign-in: `signInWithPassword` for everyone. Admin → OK. Staff → confirm the linked employee row is visible through the JWT client (RLS `employees_select_own`). Not visible → sign out and return the generic INCORRECT message. A database error → sign out and return UNAVAILABLE. Any other role or no role → sign out and return INCORRECT. The messages and the 4xx/5xx classification stay as they are in `auth.ts` today.
- Staff routing in `page.tsx` is unchanged: a Staff member sees only their own portal and never the Administrator portal.
- Seed script prints only the email; never the password or keys.

**Never:**
- Invite or magic-link emails, `auth.signUp`, a forced password change, or any self-registration route.
- A runtime path that calls `auth.admin.createUser` outside `accounts-store.create()` (e2e/test setup excepted).
- Keeping `DEMO_STAFF_PASSWORD`, `DEMO_SESSION_SECRET`, the HMAC cookie, or any demo-credential hint on the sign-in page.
- Archive/restore (Story 1.4), Supabase attendance (Story 1.5), or a database migration. The existing `employees` schema and RLS policies already cover this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Provision happy path | admin session; employee with no account; 12+ char password | auth user created with the employee's email, row linked; success message "Sign-in account created for <name>." | — |
| Employee already has an account | `auth_user_id` set | error "This employee already has a sign-in account."; nothing created | `AccountExistsError` |
| Email already registered | an auth user has that email | same message as the row above; nothing linked | `AccountExistsError` |
| Unknown employee / bad id | id not found or not `BS-nnnn` | "Choose an existing employee." | `AccountValidationError(["employeeId"])` |
| Short password | < 12 chars | "The initial password must be at least 12 characters." | `AccountValidationError(["password"])` |
| Link race lost | update touches 0 rows | auth user deleted; already-has-account message | `AccountExistsError` |
| Supabase down | network/5xx | "Accounts are temporarily unavailable. Nothing was created." | `AccountsUnavailableError` |
| Staff calls the action | staff session | "Only an Administrator can create accounts."; nothing created | — |
| No session calls the action | none | same as the row above | — |
| Staff signs in | provisioned email + password | staff portal for their own record | — |
| Shared demo password | any employee email + `Staff23Demo!` | generic INCORRECT message | — |
| Staff user with no linked row | `role: staff`, row not visible | INCORRECT, signed out | — |
| Demo seed | `SEED_DEMO_STAFF_EMAIL` = a seeded employee's email, password ≥ 12 | account created and linked; prints email | missing/short env → non-zero exit naming the variable; already linked → exit 0, "already has an account" |

</intent-contract>

## Code Map

- `src/server/accounts-store.ts` -- extend `create()` to a zod discriminated union: `{ role: "admin", email, password }` | `{ role: "staff", employeeId, password }`. The staff path reads `employee_id,email,name,auth_user_id` from `employees` with the same service client, creates the user, links with a conditional update (`.is("auth_user_id", null).select(...)`), and compensates with `auth.admin.deleteUser`. `Account` gains an optional `employeeId`. Keep `import type`-only from other `src/` modules (it is loaded by `node --experimental-strip-types`). `hasAdministrator`/`seedFirstAdministrator` are unchanged.
- `src/server/account-actions.ts` (new, `"use server"`) -- `provisionStaffAccountAction(prev: ActionState, form)`: admin check via `getSession()`, then `createAccountsStore(getServiceClient).create({ role: "staff", ... })`, map typed errors to the matrix messages, `revalidatePath("/")`. Reuse the `ActionState` shape from `attendance-actions.ts:8`.
- `src/server/auth.ts` -- delete `staffSignIn`, HMAC secret/cookie and `timingSafeEqual`; generalise `adminSession()` to `supabaseSession()` covering both roles with the per-role window (`sessionHours`). `signIn` calls one `supabaseSignIn`. The staff check after sign-in uses `employeesStore.getFor(identity, employeeId)` (JWT client). `signOut` signs out of Supabase only. Delete the legacy `bs23-demo-session` cookie in both so old browsers are cleaned.
- `src/server/session.ts` -- keep only the `SessionIdentity`/`StaffIdentity` types and `sessionHours`; remove `createSession`/`readSession` and the HMAC comment.
- `src/server/employees-store.ts:65-116` -- every read uses `userClient` (RLS). Drop `serviceClient` from `EmployeesStoreClients` and remove `findByEmail` (nothing needs it after the sign-in change). Keep the app-layer staff scoping in `listFor`/`getFor` as defence in depth. Map `auth_user_id` to `hasAccount: boolean` on admin reads only (add `auth_user_id` to the selected columns). Update the header comment.
- `src/data/employees.ts:1` -- `Employee` gains optional `hasAccount?: boolean`.
- `src/server/supabase.ts` -- update the comment: the service-role client is used at runtime only by Administrator provisioning.
- `src/components/portal.tsx:55` -- in the profile "Overview" tab, add a "Sign-in account" panel (a small client component, e.g. `src/components/staff-account-panel.tsx`). If `hasAccount`, show "Has a sign-in account". Otherwise show a form with a labelled password field "Initial password", a hidden `employeeId`, and a "Create Staff account" button, using `useActionState(provisionStaffAccountAction)`. Error → `role="alert"`; success → `role="status"`. Keyboard operable, text labels.
- `src/app/page.tsx:12`, `src/components/login.tsx` -- remove the `showDemoCredentials` prop and the staff hint; keep the "synthetic data" note.
- `scripts/seed-demo-staff.ts` (new) + `package.json` `db:seed-demo-staff` -- mirror `scripts/seed-admin.ts`. Env: `SEED_DEMO_STAFF_EMAIL`, `SEED_DEMO_STAFF_PASSWORD`. Look up the employee by lowercase email with the service client, then call `create({ role: "staff", employeeId, password })`.
- `playwright.config.ts` -- drop `DEMO_SESSION_SECRET` from `webServer.env`.
- `tests/e2e/global-setup.ts` / `global-teardown.ts` -- also insert throwaway employee rows (ids `BS-98nn`, team/title `E2E Throwaway`, emails `e2e-staff-<runid>-<n>@example.test`, valid `status`). Two rows get linked Staff users through the service role (`app_metadata { role: "staff", employee_id }`, `auth_user_id` updated); one row is left unlinked for the provisioning e2e. Expose them via `E2E_STAFF_*` env vars. Teardown deletes the users and rows. At setup, first sweep stale `e2e-staff-*`/`BS-98nn` leftovers.
- `tests/e2e/staff-attendance.spec.ts` -- sign in with the throwaway staff accounts (a different one per test, since the first test completes today's entry). Add a test that `Staff23Demo!` is rejected with the generic message.
- `tests/e2e/provision-staff.spec.ts` (new) -- the admin opens the unlinked throwaway employee, creates an account with a generated password, and sees the success message and "Has a sign-in account". Sign out, sign in as that employee, and the staff portal renders. Creating again is impossible from the UI (no form); the duplicate case is covered by unit tests.
- `tests/e2e/portal.spec.ts` -- existing filter/count assertions must still hold with the throwaway rows present (they sort last; adjust selectors only if needed, never weaken the assertions).
- Unit tests to adapt: `tests/auth.test.ts`, `tests/session.test.ts`, `tests/staff-session.test.ts`, `tests/employees-store.test.ts`, `tests/attendance-actions.test.ts`, `tests/components/login.test.tsx`, `tests/page.test.tsx`, `tests/accounts-store.test.ts`. `tests/employees-rls.test.ts` shows the live-test pattern (skip without env, throwaway BS-99nn rows).
- Docs: `.env.example` (drop `DEMO_*`, add the `SEED_DEMO_STAFF_*` vars), `docs/DEPLOYMENT.md`, `README.md`, `docs/ARCHITECTURE.md` (staff sign-in, provisioning, demo seed).

## Tasks & Acceptance

**Execution:**
- `src/data/employees.ts`, `src/server/employees-store.ts`, `src/server/supabase.ts` -- JWT-only reads, `hasAccount`, drop `findByEmail` -- carry-over from Story 1.1/1.2.
- `src/server/accounts-store.ts` -- staff create + link + compensation -- AC 1-2, AD-6 single creation path.
- `src/server/session.ts`, `src/server/auth.ts` -- single Supabase sign-in/session for both roles; HMAC retired -- AC 4-5.
- `src/server/account-actions.ts` -- admin-only provisioning action -- AC 1, 3.
- `src/components/staff-account-panel.tsx`, `src/components/portal.tsx` -- provisioning UI on the profile.
- `src/app/page.tsx`, `src/components/login.tsx` -- remove demo hint.
- `scripts/seed-demo-staff.ts`, `package.json` -- demo Staff seed.
- `playwright.config.ts`, `tests/e2e/*` -- throwaway staff, provisioning e2e, rejected shared password.
- `tests/accounts-store.test.ts` -- fake-client tests for every staff matrix row (link, already linked, email exists, unknown id, short password, race lost → user deleted, unavailable). Add a live block (skipped without env) that provisions a throwaway BS-99nn employee, signs in with the anon client, checks the employee row is readable via RLS, and cleans up.
- `tests/account-actions.test.ts` (new) -- staff/no session rejected without calling the store; admin happy path; each typed error → message; the password never appears in the returned state.
- `tests/auth.test.ts`, `tests/session.test.ts`, `tests/staff-session.test.ts` -- staff sign-in/session rows of the matrix; shared demo password rejected; 12 h staff window; legacy cookie ignored.
- `tests/seed-demo-staff.test.ts` (new) -- offline env checks, mirroring `tests/seed-admin.test.ts`.
- `tests/no-registration.test.ts` -- extend the `createUser` scan so the only `src/`/`scripts/` caller is `accounts-store.ts`.
- Docs listed in the Code Map.
- `_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/.memlog.md` -- append a 2026-10-06 amendment: staff are on Supabase Auth; `app_metadata.employee_id` carries the staff identity; runtime service-role use is limited to Administrator provisioning.

**Acceptance Criteria:**
- Given a signed-in Administrator viewing an employee without an account, when they create a Staff account with an initial password, then it is created through `accounts-store.create()`, `employees.auth_user_id` is linked, and the employee can sign in and sees their own portal (e2e).
- Given an employee who already has an account, when another is created for them, then it is rejected with a validation message and no auth user is left behind.
- Given a Staff session or no session, when `provisionStaffAccountAction` is called directly, then it returns an error state and `accounts-store.create()` is never called.
- Given Supabase auth is configured, when someone signs in with any employee email and `Staff23Demo!`, then they get the generic incorrect message; `DEMO_STAFF_PASSWORD`, `DEMO_SESSION_SECRET` and `createSession` no longer appear in `src/`.
- Given a signed-in Staff member, when the page loads, then their record is read through the JWT client (RLS), and the Administrator portal is not rendered.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why the employee's own email.** Staff signed in with their employee email before this story, and `employees.email` is unique. Using it keeps one email per person. The form also cannot point an account at the wrong address.

**Why `employee_id` in `app_metadata`.** `getSession()` runs on every request and must not need a database round trip for identity. Only the service role can write `app_metadata`, so it is as trustworthy as `role`. RLS still decides what rows the JWT can read (`auth_user_id = auth.uid()`), so a stale claim reads nothing.

**No migration.** The `auth_user_id uuid unique` column and the `employees_select_own` policy were created in Story 1.1. Its unique constraint backs the conditional link.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, all unit tests (live Supabase blocks included when env is present) and the build pass.
- `npm run test:e2e` -- expected: all specs pass, including provisioning and shared-password rejection.
- `grep -rn "Staff23Demo\|DEMO_STAFF\|DEMO_SESSION_SECRET\|createSession\|readSession" src scripts playwright.config.ts` -- expected: no matches.
