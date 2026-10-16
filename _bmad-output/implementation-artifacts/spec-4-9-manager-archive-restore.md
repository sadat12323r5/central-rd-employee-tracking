---
title: 'Story 4.9: Managers archive and restore accounts in their own department'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: '72b9ba0c1580bd12940db902459405d032f8385a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-manager-scoping.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Archiving a sub-department manager leaves that department's manager_user_id pointing at an account that cannot sign in; nothing prompts reassignment.
    evidence: |-
      manager_set_employee_archived only sets archived_at; same as Story 1.4's Administrator path.
    location: >-
      supabase/migrations/20261014040000_manager_archive.sql
    severity: low
  - summary: >-
      Live manager-archive RLS test cleans up by a per-run prefix, so departments and auth users from aborted runs are never removed.
    evidence: |-
      Same pattern as the deferred Story 4.3 item in tests/manager-scope-rls.test.ts.
    location: >-
      tests/manager-archive-rls.test.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Only the Administrator can archive or restore an account (Story 1.4). Department managers (Stories 4.2, 4.3) can see their subtree but cannot handle leavers on their own team.

**Approach:** Let a manager session archive and restore accounts of employees in its department subtree, with the same behaviour as Story 1.4 (access ends on the next request, history kept, reversible, one `audit_events` row in the same transaction). Enforce it twice: a new SECURITY DEFINER Postgres function that takes the actor from `auth.uid()` and checks scope, self and rank, called through the manager's own JWT; and a store-level pre-check using the existing manager scope. The profile's "Account access" panel appears for managers too.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261014040000_manager_archive.sql`, ADDITIVE (one new function, grants). No existing function, policy, column or constraint changes. `set_employee_archived` stays service-role only and untouched.
- `public.manager_set_employee_archived(p_employee_id text, p_archived boolean) returns text`: `language plpgsql`, `security definer`, `set search_path = ''`, fully qualified names. Execute revoked from `public, anon`, granted to `authenticated`. Inside, in order:
  1. `auth.uid()` null → `not_authorized`.
  2. `select ... for update` the employee (name, archived_at, auth_user_id); not found → `employee_not_found`.
  3. `public.manages_employee(p_employee_id)` false → `not_authorized` (same error whether outside the subtree or a plain Staff caller).
  4. Target's `auth_user_id = auth.uid()` → `cannot_archive_self` (archive only, as in 1.4; restoring yourself cannot happen, you are signed out).
  5. Rank (archive and restore): `insufficient_authority` when the target's `auth_user_id` is not null and either (a) `auth.users.raw_app_meta_data->>'role' = 'admin'` for it, or (b) it is `manager_user_id` of any department on the ancestor-or-self chain (walk `parent_department_id` with a `UNION` recursive CTE) of the caller's own employee department or of any department whose `manager_user_id = auth.uid()`.
  6. State checks `already_archived` / `not_archived` with the name as `detail`, exactly as 1.4.
  7. Update `employees.archived_at` and insert one `audit_events (actor, target, action)` row with `actor = auth.uid()`, action `archive`/`restore`. Return the name.
  All errors use `errcode = 'P0001'`.
- **Store.** In `src/server/accounts-store.ts` add `createManagerAccessStore({ userClient, scope })` with `archive(session: ManagerIdentity, employeeId)` and `restore(...)` returning `ArchiveResult`. It zod-validates the id (`^BS-\d{4}$`), then pre-checks: the id equals `session.employeeId` and archiving → `ArchiveSelfError`; id not in `scope.forManager(session).employeeIds` → new `ArchiveNotAuthorizedError` without any rpc. Then `rpc("manager_set_employee_archived")` through the user client. Map `employee_not_found` → `AccountValidationError(["employeeId"])`, `not_authorized` → `ArchiveNotAuthorizedError`, `insufficient_authority` → new `ArchiveRankError`, the 1.4 state/self codes as today, anything else and `ManagerScopeUnavailableError` → `AccountsUnavailableError`. Keep the module type-only-imports-safe for the seed scripts: inject the client and scope, do not import runtime singletons into `accounts-store.ts`.
- **Action.** `archiveEmployeeAction`/`restoreEmployeeAction`: admin path unchanged byte-for-byte; `manager` identity uses the manager store with the real `getUserClient` and `managerScope`; Staff or no session still rejected before any store call, with message "Only an Administrator or a department manager can archive or restore accounts." New messages: not authorized → "You can only archive or restore accounts in your own department."; rank → "You cannot archive or restore an account with equal or higher authority than yours.". The employee id comes only from the form; the actor only from the session.
- **UI.** `src/components/portal.tsx`: render `AccountAccessPanel` for managers too (the provisioning and activity-export panels stay admin-only). Archived in-scope employees already reach managers through 4.3's `listFor`; the "Show employees" filter works the same.
- Live DB tests sign each test user in once per file; bulk inserts pass `{ defaultToNull: false }`.

**Never:**
- No service-role call on the manager path; no new table or policy; no change to Admin or Staff behaviour.
- No change to who may provision accounts or export activity.
- Never take the actor or rank from the form or session token.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Archive in subtree | Manager of L&D archives an active Central R&D employee | Archived, one audit row with the manager's user id | — |
| Restore in subtree | Same manager restores them | Restored, one audit row | — |
| Outside subtree | Manager of Central R&D targets an L&D employee | Rejected, nothing changes, no rpc call from the store | "own department" message |
| Self | Manager archives own record (in subtree) | Rejected | `ArchiveSelfError` → existing self message |
| Higher authority | Central R&D manager targets the L&D manager's employee record placed inside Central R&D | Rejected by the function | `ArchiveRankError` |
| Equal authority | Target manages the caller's own department, or a department the caller manages | Rejected | `ArchiveRankError` |
| Administrator target | Target's auth user has role admin | Rejected | `ArchiveRankError` |
| Lower authority | Target manages a sub-department of the caller's department | Allowed | — |
| Staff caller | Staff session calls the action, or calls the function directly with its JWT | Rejected (action before store; function `not_authorized`) | — |
| Anon | Anon key calls the function | Permission denied | — |
| Already in state | Archive an archived / restore an active employee | 1.4 state messages with the name | — |
| Scope unavailable | Scope read fails | "temporarily unavailable", nothing changed | — |

</intent-contract>

## Code Map

- `supabase/migrations/20261008000000_archive_and_audit.sql` -- `set_employee_archived` body to mirror (locking, error codes, `detail = v_name`, audit insert). Do not modify.
- `supabase/migrations/20261014020000_manager_scope.sql` -- `manages_employee` (reuse inside the new function), header comment and grant style, `UNION` recursive CTE.
- `supabase/migrations/20261013000000_activity_export_audit.sql` / `20261013010000_bulk_activity_export_audit.sql` -- current `audit_events.action` check (`archive`/`restore` still allowed) and columns.
- `src/server/accounts-store.ts` -- `setArchived`, error classes, `validationFields`; add the manager store and the two errors here. Header comment update.
- `src/server/account-actions.ts:73-110` -- `setArchived` action; add the manager branch and messages.
- `src/server/manager-scope.ts` -- `managerScope`, `ManagerScopeUnavailableError`, `ManagerScope` interface (inject a fake in tests).
- `src/server/supabase.ts` -- `getUserClient` (per-request JWT client).
- `src/server/session.ts` -- `ManagerIdentity` (`employeeId`, `userId`).
- `src/components/portal.tsx:167` -- `{!isManager && <>...<AccountAccessPanel .../>...</>}`; move `AccountAccessPanel` out of the admin-only fragment.
- `src/components/account-access-panel.tsx` -- reused as is; update its doc comment ("Administrator or department manager").
- `tests/accounts-store.test.ts`, `tests/account-actions.test.ts` -- fake-client patterns and live blocks to extend.
- `tests/manager-scope-rls.test.ts` -- live pattern: throwaway parent/child departments, Staff accounts made managers, single sign-in per user, service-role cleanup.
- `tests/components/portal.test.tsx` (or the existing portal test file) -- manager role rendering.
- `tests/e2e/global-setup.ts`, `global-teardown.ts`, `staff.ts`, `department-manager.spec.ts`, `archive-account.spec.ts` -- throwaway users, slot arithmetic ("six consecutive ids"), manager department setup, archive/restore UI steps.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list/checklist and the archive section.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261014040000_manager_archive.sql` -- the function and grants -- DB-level enforcement (ADDITIVE).
- `src/server/accounts-store.ts` + `tests/accounts-store.test.ts` -- manager store, errors, mapping; fake-client tests for every matrix row the store owns (pre-checks skip rpc; each error code mapped; scope failure → unavailable).
- `src/server/account-actions.ts` + `tests/account-actions.test.ts` -- manager branch; Staff/no session rejected without store calls; admin path unchanged; messages.
- `src/components/portal.tsx`, `src/components/account-access-panel.tsx` + portal test -- panel shown for managers; provisioning and export panels still hidden for managers.
- `tests/manager-archive-rls.test.ts` (new, live, skipped without env) -- throwaway parent P and child C departments; Staff accounts: manager of P (`mP`, employee in P), manager of C (`mC`, employee in C), a lower manager of a grandchild G under C (`mG`, employee in C), a plain member of C, a plain member of P; one sign-in per user. Assert via each user's JWT: `mC` archives and restores the C member (audit rows with `mC`'s user id); `mC` on the P member → `not_authorized`; `mC` on self → `cannot_archive_self`; `mC` on `mP`'s employee row moved into C → `insufficient_authority`; `mP` on `mG` → allowed (restore after); the C member (plain Staff) → `not_authorized`; anon → permission denied. Clean up departments/employees/auth users with the service role and always restore archived rows.
- `tests/e2e/global-setup.ts`, `global-teardown.ts`, `staff.ts` -- one more throwaway linked Staff employee for this spec, keeping slots non-overlapping.
- `tests/e2e/manager-archive.spec.ts` (new) -- the e2e manager gets a throwaway department containing that employee; manager opens the profile, archives (success message, "Archived" label), the employee's sign-in gets the generic incorrect message, manager restores, the employee can sign in again; cleanup in `finally` (restore via service client if still archived, clear `department_id`, delete the department).
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- the new migration and manager archive authority.

**Acceptance Criteria:**
- Given a department manager, when they archive or restore an account in their subtree, then it behaves as in Story 1.4 (next request signed out, history kept, reversible, one audit row) (e2e + live).
- Given an account outside the manager's subtree, when they try to archive or restore it, then it is rejected at the server and by the database function.
- Given an account with equal or higher authority, or an Administrator, when the manager tries to archive it, then it is rejected.
- Given the manager's own account, when they try to archive it, then it is rejected.

## Spec Change Log

## Review Triage Log

### 2026-10-14 — Review pass
- verdicts: 28 findings — high 0, medium 3, low 16, false 9, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: function raises employee_not_found before the scope check (ID-existence oracle, row lock by any signed-in user) — real but the order is fixed by the intent contract; fixing it means editing the spec. App path pre-checks scope first. Noted in the PR.
  - `[low]` `[reject]` Blind: a manager can restore a Staff member an Administrator archived — the story limits restore by subtree only; the rank-on-restore note is about the target's rank, not the archiver's.
  - `[false]` `[reject]` Blind: peer/sibling-department managers are not treated as equal authority — epics.md defines equal or higher as "the manager of their own department or any ancestor, or an Administrator"; the function implements that list (plus managed departments' chains).
  - `[low]` `[reject]` Blind: Archive button shown on the manager's own or a higher-ranked profile — server rejects with a clear message; hiding needs new props for a rare case.
  - `[low]` `[defer]` Blind: archiving a sub-department manager leaves that department managed by an account that cannot sign in — same as Story 1.4's Administrator path; reassignment is an Administrator task.
  - `[false]` `[reject]` Blind: audit row does not record the route — the actor is recorded; the 1.4 audit shape (actor, target, action) is the decided minimal AuditEvent.
  - `[low]` `[patch]` Blind: NOT_IN_DEPARTMENT says "own department" but the rule is the subtree — message now names sub-departments. (Staff-facing "Only an Administrator or a department manager" text rejected: it states who may act, as the 1.4 message did.)
  - `[false]` `[reject]` Blind: no confirmation before archiving — pre-existing Story 1.4 panel behaviour, not introduced here; restore is the undo.
  - `[low]` `[patch]` Blind: e2e inserts the department before try and ignores cleanup errors — insert moved inside try, cleanup errors checked.
  - `[medium]` `[patch]` Blind: e2e never shows an existing session ending on its next request — added a signed-in second context that is signed out on reload after the archive.
  - `[low]` `[patch]` Blind: live test gaps (own-department rank branch, rejected cases writing no audit row) — own-department case added (see VerificationGap row); remaining sub-gaps (admin restore, employee_not_found) rejected: same code path as covered rows.
  - `[low]` `[reject]` Blind: action/portal unit-test gaps (service client uncalled on manager throw, own-profile panel) — routing is asserted by the mocked factory calls; no behaviour left unasserted that a user would meet.
  - `[medium]` `[patch]` EdgeCase: archived manager with a still-valid JWT can call the function directly — function now rejects callers whose own employee row is archived; live case added.
  - `[low]` `[reject]` EdgeCase: employee_not_found before scope check — duplicate of the first Blind row.
  - `[false]` `[reject]` EdgeCase: peer managers not rejected — duplicate of the Blind peer row; matches the epic's definition.
  - `[low]` `[patch]` EdgeCase: audit assertions filter only by target, so leftover rows from a same-slot earlier run make them flaky — audit query also filtered by this run's actors.
  - `[low]` `[defer]` EdgeCase: aborted-run departments and auth users leak (cleanup by per-run prefix) — same pre-existing pattern deferred in Story 4.3.
  - `[low]` `[reject]` EdgeCase: Archive button on self/higher profiles — duplicate of the Blind row.
  - `[low]` `[patch]` EdgeCase: e2e cleanup ignores errors — same patch as the Blind e2e cleanup row.
  - `[false]` `[reject]` EdgeCase claim: docs say equal-or-higher is rejected while peers pass — the docs use the epic's definition; see the peer row.
  - `[medium]` `[patch]` VerificationGap: the rank check's own-employee-department branch is never exercised alone — added a live case (caller lives in X managed by Y, manages unrelated Z, Y moved into Z → insufficient_authority on archive and restore).
  - `[false]` `[reject]` Intent: no e2e of an existing session ending — duplicate of the Blind e2e row, now patched.
  - `[false]` `[reject]` Intent: a second archive path instead of accounts-store.archive()/restore() — the epic context says accounts-store archive/restore "are extended"; the manager path lives in accounts-store.ts and keeps one transaction per change; the AC asks for the 1.4 behaviour, which it has.
  - `[false]` `[reject]` Intent: rejections never tested end-to-end through action + real DB — each layer is tested and the DB is the enforcing layer; descriptive only.
  - `[low]` `[reject]` Intent: rank also applied to restore beyond the literal text — recorded decision in Design Notes; affects only out-of-rank targets.
  - `[false]` `[reject]` Intent: rank list is a superset of C1 — the extra (managed departments' chains) is the same rule for a manager who works outside the department they manage; descriptive.
  - `[low]` `[reject]` Intent: UI shows the panel for self/higher targets — duplicate of the Blind row.
  - `[false]` `[reject]` Intent: e2e does not check default-directory hiding/history on the manager path — the directory filter and history are the unchanged Story 1.4/4.3 code paths with their own tests; descriptive only.

## Design Notes

Why a new SECURITY DEFINER function instead of reusing `set_employee_archived` through the service role: the manager's authority, rank and the audit actor must come from `auth.uid()`, not from a parameter the app could get wrong, and the rank check needs ancestor departments and `auth.users` that a manager's JWT cannot read. It is one rpc, so the change and its audit row stay in one transaction.

Rank: "equal or higher" means the target has authority over the caller — the target manages the caller's own department, a department the caller manages, or an ancestor of either; or the target is an Administrator. A target who only manages departments below the caller is lower and may be archived. The rank check also applies to restore (decision: the AC names archive; applying it to restore too stops a subordinate from undoing an archive made above them and changes nothing for in-rank targets).

## Verification

**Commands:**
- `npm run typecheck` -- expect no errors.
- `npm test` -- all pass, except live DB tests needing the 4.1–4.3 and 4.9 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205).
- `npm run build` -- expect success.
- `npm run test:e2e` (Chromium via `/opt/pw-browsers/chromium` if needed) -- pass, or fail only with schema-missing errors until the migrations are applied.
- Optional: apply all migrations to a throwaway local Postgres (as Story 4.3 did) to exercise the function's matrix rows.

## Auto Run Result

Status: done

**Summary:** Department managers can archive and restore accounts in their own department subtree, with Story 1.4's behaviour (access ends on the next request, history kept, reversible, one audit row in the same transaction). A new ADDITIVE SECURITY DEFINER function `manager_set_employee_archived` takes the actor from `auth.uid()` and enforces scope, self, rank and caller-not-archived; the store pre-checks scope and self first; the Account access panel shows for managers.

**Files changed:**
- `supabase/migrations/20261014040000_manager_archive.sql`: new function and grants (ADDITIVE).
- `src/server/accounts-store.ts`: `createManagerAccessStore`, `ArchiveNotAuthorizedError`, `ArchiveRankError`.
- `src/server/account-actions.ts`: manager branch and messages; the admin path is unchanged.
- `src/components/portal.tsx`, `src/components/account-access-panel.tsx`: panel shown to managers.
- Tests:
  - `tests/accounts-store.test.ts`, `tests/account-actions.test.ts`, `tests/components/portal.test.tsx`: unit.
  - `tests/manager-archive-rls.test.ts`: new, live.
  - `tests/e2e/manager-archive.spec.ts`: new.
  - `tests/e2e/global-setup.ts`, `tests/e2e/staff.ts`, `playwright.config.ts`: a seventh throwaway e2e employee.
- `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`: the migration and the manager archive authority.

**Review:** 28 findings: 3 medium, 16 low, 9 false.
- **Patched (8 rows, 6 distinct fixes):**
  - medium: archived-manager direct rpc;
  - medium: the own-department rank branch had no test;
  - medium: e2e did not show an existing session ending;
  - low: the subtree wording of the message;
  - low: e2e cleanup ordering and error checks;
  - low: flaky audit filtering.
- **Deferred (2):** a dangling sub-department manager; aborted-run cleanup in the live test.
- **Rejected:** all others, with the reasons in the triage log.

Follow-up review recommended: false (patched: high 0, medium 3 entries, which are independent fixes verified on local Postgres and in unit tests). The medium patches are covered by the new live tests, which cannot run until the migrations are applied.

**Verification:**
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm test`: 1052 passed, 35 skipped. Three live files fail only with PGRST205 (`public.departments` missing): `departments-rls`, `manager-scope-rls` and `manager-archive-rls`. Two 5-second network timeouts in `interviews-rls` and `lms-rls` passed on re-run (26/26).
- `npm run test:e2e` (Chromium via executablePath): 11 passed, 16 failed. Every failure is schema-missing (12× 42703 `employees.department_id`, 4× PGRST205).
- The implementer applied all migrations to a throwaway local Postgres 16 and confirmed every matrix row, plus the archived-caller and own-department-branch cases.

**Residual risks:**
- The live RLS and e2e tests have not run against the real schema. Re-run them after applying the 4.1, 4.2, 4.3 and 4.9 migrations.
- The function reports `employee_not_found` before the scope check, which leaves a small ID-existence oracle on direct rpc calls (the order is fixed by the spec).
