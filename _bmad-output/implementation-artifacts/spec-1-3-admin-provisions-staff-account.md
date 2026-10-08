---
title: 'Story 1.3 — Administrator provisions a Staff account'
type: 'feature'
created: '2026-10-06'
status: 'done'
baseline_revision: '13509b49d9865a453afa58573b689fc16549a826'
review_loop_iteration: 0
followup_review_recommended: true
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

### 2026-10-06 — Review pass
- verdicts: 26 findings — high 0, medium 6, low 10, false 10, maybe-false 0
- findings:
  - `[low]` `[patch]` (edge) If the link fails and the compensating `deleteUser` also fails, an orphan auth user keeps the email — a double failure; the store comment claiming "no auth user left behind" was reworded to say the cleanup is best effort and logged. A recovery flow would add guards for a rare path.
  - `[low]` `[patch]` (edge) Supabase `weak_password` is reported as "too short" — the message now covers length and policy.
  - `[medium]` `[patch]` (edge) Employee email already used by another auth user → seed script prints "already has an account" and exits 0 with nothing linked — the seed now exits non-zero in that case. The action's message for that case is fixed by the I/O matrix ("Email already registered"), so it is not changed here.
  - `[false]` `[reject]` (edge) Seed lookup is case-sensitive — `scripts/seed-employees.ts` lowercases every stored email and it is the only writer of `employees`; `ilike` would treat `_` in emails as a wildcard.
  - `[medium]` `[patch]` (edge) e2e setup sweep deletes another concurrent run's throwaway users and rows on the shared project — the sweep is limited to leftovers older than 2 hours.
  - `[false]` `[reject]` (intent) AC3 tested only with a mocked session — the action's first statement is the `getSession()` admin check, and the real `getSession` (`identityFor`, `getUser`) is covered by `auth.test.ts`/`staff-session.test.ts`. The enforcement is server-side, as the AC requires.
  - `[false]` `[reject]` (intent) AC2 raises `AccountExistsError`, not a "validation error" class — the user sees a validation message in the form, which is what the AC observes. The matrix fixed the mapping.
  - `[false]` `[reject]` (intent) e2e Staff fixtures bypass `accounts-store.create()` — the System Owner decision says CI/e2e provision "through the service role", and the provisioning spec exercises `create()` end to end.
  - `[low]` `[patch]` (blind) Orphan user on failed compensation — same root cause as the first edge row; comment reworded.
  - `[medium]` `[patch]` (blind) `AccountExistsError` covers "email taken by another user" and the seed hides it — same root cause as the third edge row; seed fixed.
  - `[low]` `[patch]` (blind) `weak_password` mis-message and no 72-character maximum (a longer password surfaces as "unavailable") — `.max(72)` added to the store and action schemas; message updated.
  - `[medium]` `[patch]` (blind) No confirm field, so a typo locks the employee out with no documented reset — added a "Confirm initial password" field with a server-side match check, and a manual reset procedure in DEPLOYMENT.md.
  - `[low]` `[reject]` (blind) No record of which Administrator provisioned which account — no AC asks for it. `audit_events` is created by Story 1.4 for archive/restore; adding it here needs a new table. Noted in residual risks.
  - `[false]` `[reject]` (blind) Attendance actions trust the `employee_id` claim for 12 h after an unlink — no unlink path exists. `auth_user_id` is cleared only by `on delete set null`, and a deleted auth user fails `getUser()`, which ends the session. Story 1.4's archive must check status on every request (already an epic rule).
  - `[medium]` `[patch]` (blind) e2e sweep deletes other runs' data — same root cause as the fifth edge row.
  - `[low]` `[patch]` (blind) Sweep misses stale `e2e-admin-*` users (the Story 1.2 deferred item) — the age-scoped sweep now covers them. The unchecked staff link in setup and the ignored `deleteUser` errors are rejected: a failed link makes the staff e2e fail loudly.
  - `[false]` `[reject]` (blind) Seed email lookup is case-sensitive — same refutation as the fourth edge row.
  - `[low]` `[patch]` (blind) ARCHITECTURE.md/README.md passages still say there is no database or RLS — corrected.
  - `[low]` `[patch]` (blind) Live test comment claims "no auth user left behind" without checking — fixed.
  - `[low]` `[patch]` (blind) `signInAsStaff` unused — deleted.
  - `[false]` `[reject]` (blind) `ActionState` imported from attendance-actions — a type-only import of the shared action shape the epic defines; no caller diverges.
  - `[false]` `[reject]` (blind) `Boolean(employees.find(...)?.hasAccount ?? selected.hasAccount)` is hard to read — it prefers refreshed props as intended; no named harm.
  - `[low]` `[patch]` (blind) page.test.tsx stubs the retired `DEMO_STAFF_PASSWORD` and asserts a mock prop count — replaced with a no-credentials assertion.
  - `[false]` `[reject]` (blind) Success state lives only in client state — `revalidatePath("/")` in the action re-renders the page, and the portal reads `hasAccount` from the refreshed `employees` prop first. The e2e reload step confirms the persisted state.
  - `[false]` `[reject]` (verification-gap) No verification gaps — informational, nothing to act on.
  - `[medium]` `[patch]` (verification-gap) e2e sweep wipes other runs' data and has few `BS-98nn` slots — same root cause as the fifth edge row; the sweep is age-scoped. An id collision fails loudly on the unique key.

## Design Notes

**Why the employee's own email.** Staff signed in with their employee email before this story, and `employees.email` is unique. Using it keeps one email per person. The form also cannot point an account at the wrong address.

**Why `employee_id` in `app_metadata`.** `getSession()` runs on every request and must not need a database round trip for identity. Only the service role can write `app_metadata`, so it is as trustworthy as `role`. RLS still decides what rows the JWT can read (`auth_user_id = auth.uid()`), so a stale claim reads nothing.

**No migration.** The `auth_user_id uuid unique` column and the `employees_select_own` policy were created in Story 1.1. Its unique constraint backs the conditional link.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, all unit tests (live Supabase blocks included when env is present) and the build pass.
- `npm run test:e2e` -- expected: all specs pass, including provisioning and shared-password rejection.
- `grep -rnw "Staff23Demo\|DEMO_STAFF_PASSWORD\|DEMO_SESSION_SECRET\|createSession\|readSession" src scripts playwright.config.ts` -- expected: no matches (`-w` so the required `SEED_DEMO_STAFF_*` names do not match).

## Auto Run Result

Status: done

**Summary:** An Administrator creates a Staff account from an employee's profile by typing an initial password twice. The account is created through `accounts-store.create()` with the employee's own email and `app_metadata { role: "staff", employee_id }`, and `employees.auth_user_id` is linked only if the row is still unlinked; a failed link removes the new user (best effort). Every sign-in, Administrator and Staff, goes through Supabase Auth, with an 8 h / 12 h session window. The shared `DEMO_STAFF_PASSWORD`, `DEMO_SESSION_SECRET`, the HMAC cookie and the demo-credentials hint are gone. All employee reads use the per-request JWT client (RLS). `npm run db:seed-demo-staff` creates one demo Staff account from env vars. e2e provisions throwaway Staff accounts and employees through the service role. There is no database migration: the Story 1.1 schema and policies already cover this.

**Files changed:**
- `src/server/accounts-store.ts`: staff `create()` with link and compensation; 12–72 character passwords.
- `src/server/account-actions.ts` (new): Administrator-only `provisionStaffAccountAction`.
- `src/server/auth.ts`, `src/server/session.ts`: one Supabase sign-in and session path for both roles; HMAC removed; legacy cookie deleted.
- `src/server/employees-store.ts`, `src/server/supabase.ts`, `src/data/employees.ts`: JWT-only reads, `hasAccount`, `findByEmail` removed.
- `src/components/staff-account-panel.tsx` (new), `src/components/portal.tsx`, `src/app/styles.css`: provisioning panel; the date formatter tolerates empty dates (profiles without fixture data).
- `src/components/login.tsx`, `src/app/page.tsx`: demo hint removed.
- `scripts/seed-demo-staff.ts` (new), `package.json`: demo Staff seed.
- `playwright.config.ts`, `tests/e2e/*`: throwaway staff and employees, an age-scoped leftover sweep (staff and admin), a provisioning spec, and shared-password rejection.
- Unit tests: new `account-actions`, `seed-demo-staff` (with a live block), `staff-account-panel` and `support/fake-auth`; updated auth, session, staff-session, employees-store, accounts-store, attendance-actions, login, page, portal and no-registration.
- Docs: `.env.example`, `README.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, and a memlog amendment.

**Review:** 26 findings:
- **Patched** (13 rows, 7 entries): 3 medium entries (seed false success when the email belongs to another user; no confirm field and no reset procedure; the e2e sweep deleting concurrent runs' data) and 4 low entries (password max and policy message; best-effort cleanup comment; stale docs and test leftovers; stale `e2e-admin-*` users swept, which closes Story 1.2's deferred item).
- **Deferred:** 0.
- **Rejected:** 13 rows, with reasons in the triage log. These include no provisioning audit record (Story 1.4 creates `audit_events`) and the case-insensitive seed lookup (stored emails are always lowercase).

**Follow-up review recommended:** true. Three medium entries were patched. The unverified risk: the Staff session window and the middleware refresh haven't been exercised across a real access-token refresh, about an hour after sign-in. e2e runs finish within minutes.

**Verification:**
- `npm run check` passed: 21 files, 251 tests including live Supabase blocks, plus the build.
- `npm run test:e2e` passed 14/14. It ran with Chromium 1194 aliased as build 1243 in a scratch `PLAYWRIGHT_BROWSERS_PATH`, because the installed Playwright 1.63 expects 1243.
- The `-w` grep for retired demo identifiers finds no matches.

**Residual risks / human actions:**
- After merge, the shared project's staff sign-ins stop working until accounts are provisioned. To keep the demo, run `npm run db:seed-demo-staff` with `SEED_DEMO_STAFF_EMAIL` and `SEED_DEMO_STAFF_PASSWORD`.
- Nothing records which Administrator provisioned an account. Story 1.4's `audit_events` could cover it.
- Two overlapping e2e runs can pick the same `BS-98nn` slot (about a 1-in-33 chance). If so, the second run fails loudly at setup.
- `docs/SRS.md` still describes the old demo credentials.

