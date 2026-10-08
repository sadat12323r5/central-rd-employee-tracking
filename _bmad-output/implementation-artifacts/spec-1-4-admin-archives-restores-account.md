---
title: 'Story 1.4 — Administrator archives and restores an account'
type: 'feature'
created: '2026-10-08'
status: 'blocked'
baseline_revision: '9e7b8162b33ad0289f514e94b63554fb08b333f6'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-admin-provisions-staff-account.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** There is no way to end someone's access when they leave. Today the only option would be deleting the auth user or the employee row, which loses history and cannot be undone. Nothing records who changed an account's access.

**Approach:** An Administrator archives an employee from the employee's profile and can restore them later. Archiving sets `employees.archived_at`. Archive and restore each go through `accounts-store.archive()` / `restore()`, which call one Postgres function that changes the row and writes one append-only `audit_events` row in the same transaction. A staff session is checked against the archive state on every request, and at sign-in. The directory hides archived employees unless the "Archived" filter is chosen.

## Boundaries & Constraints

**Always:**
- Archive state lives in a new nullable column `employees.archived_at timestamptz` (null = active). Archiving changes nothing else on the row; nested profile data is untouched (history kept).
- `audit_events` (new table): `id bigint generated always as identity primary key`, `actor uuid not null` (the acting Administrator's auth user id; no FK, so history survives a deleted user), `target text not null` (the Employee ID), `action text not null check (action in ('archive','restore'))`, `occurred_at timestamptz not null default now()` (server timestamp). RLS enabled with no policies. `update`, `delete` and `truncate` revoked from `anon`, `authenticated` and `service_role`, and a `before update or delete` row trigger plus a `before truncate` statement trigger that raise an exception, so no code path, the service role included, can change or remove rows.
- One function, `public.set_employee_archived(p_employee_id text, p_archived boolean, p_actor uuid)`, does the state change and the audit insert in one transaction. It raises distinct errors (SQLSTATE `P0001` with messages `employee_not_found`, `already_archived`, `not_archived`, `cannot_archive_self`) for: no such employee; archive of an archived row; restore of an active row; archive where the row's `auth_user_id = p_actor`. `execute` is revoked from `public`, `anon` and `authenticated` and granted to `service_role` only.
- `accounts-store.archive({ employeeId, actorId })` and `restore({ employeeId, actorId })` are the only callers of that function (zod: `^BS-\d{4}$`, uuid). They map the function's errors to typed errors and network/other errors to `AccountsUnavailableError`.
- Server actions `archiveEmployeeAction` / `restoreEmployeeAction` check `getSession()` is `admin` first; any other session or none gets an error state and the store is never called. The actor id comes from the validated Supabase user (`auth.getUser()`), never from form data. Input is validated with zod; results are `ActionState`.
- `getSession()` for a staff identity also checks the linked employee row through the JWT client (RLS): row not visible or `archived_at` set → sign the session out locally and return `null`. A read error returns `null` without signing out. Administrator sessions do not need this check (Administrator accounts have no employee row).
- Staff sign-in: if the linked row is archived, sign out and return the same generic INCORRECT message.
- Directory (Administrator portal): archived employees are hidden by default, from the table, the Overview stats and the nav count. A "Show" select with options "Active employees" (default) and "Archived employees" shows them. An archived employee's profile shows an "Archived" text label, not colour alone.
- Profile "Overview" tab: an "Account access" panel. Active → explanation ("Archiving ends this person's sign-in access immediately. Their records are kept and can be restored.") and an "Archive employee" button. Archived → "Archived" label and a "Restore employee" button. Errors use `role="alert"`, success `role="status"`. Keyboard operable.

**Never:**
- Hard deletes of employees or auth users, auth-user bans, or changes to existing RLS policies, constraints or columns (the migration is additive only).
- An `update` policy on `employees` or any grant that lets `authenticated` change `archived_at`.
- Archiving or restoring through any path other than `accounts-store.archive()` / `restore()` (e2e cleanup that deletes throwaway rows is the test exception).
- Manager archiving (Story 4.9), attendance persistence (Story 1.5), an audit-log viewer, or recording provisioning in `audit_events`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Archive happy path | admin; active employee | `archived_at` set; one `audit_events` row (actor, target, 'archive'); "<name> was archived. Their sign-in access has ended." | — |
| Restore happy path | admin; archived employee | `archived_at` null; one audit row 'restore'; "<name> was restored." | — |
| Already archived / not archived | archive an archived row, or restore an active one | "<name> is already archived." / "<name> is not archived."; no audit row | `AccountStateError` |
| Own account | target's `auth_user_id` = actor id | "You cannot archive your own account."; nothing changes | `ArchiveSelfError` |
| Unknown employee / bad id | not found, or not `BS-nnnn` | "Choose an existing employee." | `AccountValidationError(["employeeId"])` |
| Supabase down | network/5xx | "Accounts are temporarily unavailable. Nothing was changed." | `AccountsUnavailableError` |
| Staff or no session calls an action | staff / none | "Only an Administrator can archive or restore accounts."; store not called | — |
| Staff JWT calls the function directly | `rpc('set_employee_archived')` with a staff or anon client | permission denied; nothing changes | — |
| Live staff session after archive | staff signed in, then archived | next request: `getSession()` → null, page shows sign-in | — |
| Archived staff signs in | correct email + password | generic INCORRECT message, no session | — |
| Restored staff signs in | correct email + password | staff portal | — |
| Update/delete an audit row | any client, service role included | error; row unchanged | — |

</intent-contract>

## Code Map

- `supabase/migrations/20261008000000_archive_and_audit.sql` (new) -- `alter table public.employees add column archived_at timestamptz;`, the `audit_events` table, the append-only triggers and revokes, and `set_employee_archived` (`language plpgsql`, `security invoker`, `set search_path = public`). Inside the function: `select ... for update` the row; raise on the error cases; `update employees set archived_at = case when p_archived then now() else null end`; `insert into audit_events`. Follow the comment style of `supabase/migrations/20261006000000_employees.sql`.
- `src/server/accounts-store.ts` -- add `archive()` / `restore()` to `AccountsStore` plus `AccountStateError` (with `state: "archived" | "active"`) and `ArchiveSelfError`. Reuse `client()`, the try/catch-to-`AccountsUnavailableError` pattern and `validationFields`. Map the PostgREST error `message` from `rpc()` (`employee_not_found` → validation, `already_archived`/`not_archived` → state, `cannot_archive_self` → self). Return `{ employeeId, name, archived }`, reading `name` for the message via the same service client (or have the function `return` the name). Keep type-only imports (strip-types loader). Update the header comment.
- `src/server/auth.ts` -- export `getActor(): Promise<{ identity: SessionIdentity; userId: string } | null>` built from the existing `supabaseSession()` (which already has `data.user`); `getSession()` returns `(await getActor())?.identity ?? null`. In the staff path call `employeesStore.isActive(identity)`. Replace the sign-in `getFor` check (line ~126) with `isActive` (false → INCORRECT; `EmployeesUnavailableError` → UNAVAILABLE as today).
- `src/server/employees-store.ts` -- add `isActive(session: StaffIdentity): Promise<boolean>` (select `archived_at` for the session's own `employee_id` through `userClient`; null row → false; errors → `EmployeesUnavailableError`). Add `archived_at` to `ADMIN_COLUMNS` and map it to `archived: boolean` in `toEmployee` when `withAccount` (Administrator reads only).
- `src/data/employees.ts` -- `Employee` gains optional `archived?: boolean`.
- `src/server/account-actions.ts` -- `archiveEmployeeAction` / `restoreEmployeeAction(prev: ActionState, form)`: `getActor()` admin check, zod `employeeId`, call the store with `actorId: actor.userId`, map errors to the matrix messages, `revalidatePath("/")`. Keep `provisionStaffAccountAction` unchanged.
- `src/components/account-access-panel.tsx` (new, client) -- mirrors `staff-account-panel.tsx`: two forms with `useActionState`, hidden `employeeId`, the matrix messages.
- `src/components/portal.tsx` -- `const active = employees.filter(e => !e.archived)`; use `active` for the default view, nav count, stats and Overview; add the "Show" select (`aria-label="Show employees"`) to `filters` and include it in Reset; render `AccountAccessPanel` beside `StaffAccountPanel` (line 57) with `archived` read from refreshed props first, like `hasAccount`; show an "Archived" label in the profile header when archived. Counts in the table footer use the current view.
- `tests/e2e/global-setup.ts` / `global-teardown.ts` -- add a fourth throwaway employee linked to a Staff user for the archive spec (`E2E_STAFF_ARCHIVE_*`); adjust the `BS-98nn` slot arithmetic so four rows fit without overlap.
- `tests/e2e/archive-account.spec.ts` (new) -- staff signs in (context B); admin (context A) archives that employee and sees the success message; staff reloads → sign-in page; staff sign-in → generic incorrect message; directory default hides the employee, "Archived employees" shows them; admin restores; staff signs in again → staff portal. The spec restores in a `finally`-style step so teardown is unaffected.
- `tests/employees-rls.test.ts` / `tests/accounts-store.test.ts` -- show the live-test pattern (skip without env, throwaway `BS-99nn` rows, cleanup).
- Docs: `docs/ARCHITECTURE.md` (archive/restore, `audit_events`, per-request archive check), `README.md` if it lists features, `docs/DEPLOYMENT.md` (the new migration).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261008000000_archive_and_audit.sql` -- column, audit table, append-only guards, function and grants -- AC 1, 6, 7.
- `src/data/employees.ts`, `src/server/employees-store.ts` -- `archived` on admin reads, `isActive` -- directory and session checks.
- `src/server/accounts-store.ts` -- `archive()` / `restore()` and typed errors -- the single archive/restore path.
- `src/server/auth.ts` -- `getActor()`, per-request and sign-in archive checks -- AC 2, 3, 5.
- `src/server/account-actions.ts` -- admin-only archive/restore actions -- AC 7, 8.
- `src/components/account-access-panel.tsx`, `src/components/portal.tsx` -- profile panel, "Show" filter, active-only counts -- AC 4, 5.
- `tests/accounts-store.test.ts` -- fake-client tests for each store matrix row; live block (skipped without env): archive and restore a throwaway `BS-99nn` row and check `archived_at`, one audit row per call with the right actor/target/action, other columns unchanged; the self case; update and delete of an audit row fail with the service role.
- `tests/employees-rls.test.ts` -- live: a staff JWT and the anon client cannot call `set_employee_archived` or update `archived_at`.
- `tests/account-actions.test.ts` -- staff/no session rejected without calling the store; admin happy paths; each typed error → message; actor id taken from the session even when the form carries one.
- `tests/auth.test.ts` / `tests/staff-session.test.ts` -- archived staff: `getSession()` null and signed out; read error → null, not signed out; sign-in → INCORRECT; restored → session; `getActor()` returns the user id.
- `tests/employees-store.test.ts` -- `archived` mapping (admin only) and `isActive` rows.
- `tests/components/` -- `account-access-panel.test.tsx`; portal: archived hidden by default, shown under "Archived employees", counts exclude archived.
- `tests/e2e/*` -- fixture and `archive-account.spec.ts` as in the Code Map.
- Docs listed in the Code Map; append a 2026-10-08 Story 1.4 amendment to `_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/.memlog.md` (archive = `employees.archived_at`; the Postgres function is the transaction boundary; staff sessions check archive state per request through RLS; no auth-user ban).

**Acceptance Criteria:**
- Given the migration is applied, when any client (service role included) updates or deletes an `audit_events` row, then it fails and the row is unchanged.
- Given a staff member with a live session, when an Administrator archives them, then their next request is treated as signed out (e2e).
- Given an archived account, when it signs in with the correct password, then it gets the generic "incorrect" message (e2e).
- Given an archived employee, when the Administrator opens the directory, then they are hidden by default and listed under "Archived employees", with their profile data unchanged (e2e + live test).
- Given an archived account, when the Administrator restores it, then the employee can sign in again and reappears in the default directory (e2e).
- Given an archive or restore, when it completes, then it went through `accounts-store.archive()` / `restore()` and exactly one `audit_events` row was written in the same database transaction.
- Given a Staff session, when it calls the archive or restore action or the database function directly, on any account including its own, then it is rejected at the server.
- Given the Administrator's own account, when they try to archive it, then it is rejected and nothing changes.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why a Postgres function.** PostgREST runs each request in its own transaction, so two client calls (update, then insert) cannot be atomic. One `rpc()` is one transaction, which the AC requires.

**Why no auth-user ban.** The epic says to check archive status on every request rather than rely on token expiry. The staff session already reads through RLS; checking `archived_at` there ends access on the next request, and restore needs only the one function. A ban would be a second, non-transactional write.

**"Own account".** Administrator accounts are not linked to employee rows today, so the self case is the row whose `auth_user_id` is the actor. The function enforces it, so it holds even if a future path links an Administrator to an employee.

**Test residue.** `audit_events` is append-only, so live tests and e2e leave audit rows behind in the shared project. They reference throwaway `BS-98nn`/`BS-99nn` ids. That is acceptable for synthetic data and is the point of the table.

## Verification

**Commands:**
- `npm run db:push` -- expected: the additive migration applies to the shared project.
- `npm run check` -- expected: typecheck, all unit tests (live Supabase blocks included when env is present) and the build pass.
- `npm run test:e2e` -- expected: all specs pass, including `archive-account.spec.ts`.

## Auto Run Result

Status: blocked
Blocking condition: implementation verification failed. The additive migration `supabase/migrations/20261008000000_archive_and_audit.sql` could not be applied: `npm run db:push` timed out three times, because the automation container cannot open a TCP connection to the Supabase Postgres pooler on port 5432 (outbound access is HTTPS-only). Without the migration, `npm run check` fails 4 live tests (313 pass, 4 fail: the archive/restore and audit tests in `tests/accounts-store.test.ts` and the RLS tests for `set_employee_archived` / `archived_at` in `tests/employees-rls.test.ts`), and `npm run test:e2e` cannot pass, because the shared project returns `column employees.archived_at does not exist`. The step-04 review did not run.

**Implemented (not yet verified against the live project):** the migration (`employees.archived_at`, the append-only `audit_events` table with revokes and triggers, and the service-role-only `set_employee_archived` function); `accounts-store.archive()` / `restore()` with the typed errors `AccountStateError` and `ArchiveSelfError`; `employeesStore.isActive()` and `archived` on Administrator reads; `getActor()`, plus the per-request and sign-in archive checks in `auth.ts`; the Administrator-only `archiveEmployeeAction` / `restoreEmployeeAction`; the "Account access" panel; the "Show employees" directory filter, with counts that exclude archived employees; unit, live and e2e tests (`tests/e2e/archive-account.spec.ts`); and the docs and memlog amendment. The implementer checked the migration against a throwaway local Postgres 16: the function's four errors, one audit row per change, rollback when the audit insert fails, and audit update/delete/truncate refused for the service role and the table owner.

**Deviation:** the `already_archived` / `not_archived` errors carry the employee's name from the database, so the "<name> is already archived." message does not depend on form input.

**To unblock:** apply the migration (`npm run db:push` from a machine that can reach the database, or run the SQL in the Supabase SQL editor). Then run `npm run check` and `npm run test:e2e`, and run the step-04 review (re-dispatch this spec after setting its status to `in-review`).

**Deploy-order risk:** this code reads `employees.archived_at` on every Administrator directory load and every Staff request. Deployed before the migration, the directory shows "unavailable" and Staff sessions end. Apply the migration first.
