---
title: 'Story 4.8: Higher manager transfers an employee between departments'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_revision: '054ea3d92c922ac4e8ae0eecacdfa96b1e2569f7'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-9-manager-archive-restore.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An assignment opened at the same moment as a transfer can be recorded under the employee's old department.
    evidence: |-
      assignments_guard (20261014030000_assignments.sql:62) reads employees.department_id without a row lock; the FK key-share lock waits for the transfer's FOR UPDATE, but only after the guard copied the old value. Fix: `for share` in the guard's select, which replaces an existing function (a DESTRUCTIVE change to Story 4.5's migration surface).
    location: >-
      supabase/migrations/20261014030000_assignments.sql:62
    severity: low
---

<intent-contract>

## Intent

**Problem:** An employee's department can only be changed by hand in the database. When someone finishes training in L&D and moves to Central R&D, nobody in the app can move them, and no record says who moved whom.

**Approach:** Add one transactional database function, `public.transfer_employee`, called through the actor's own JWT. Wrap it in `employees-store.transfer()` (FR-11) behind a server action. Add a "Department" panel with a transfer form to the management portal's profile Overview. The function writes one `audit_events` row with the source and destination departments.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261016020000_department_transfer.sql` is **DESTRUCTIVE**, because it drops and replaces `audit_events_action_check`. The replacement only widens it by adding `'transfer'`, so existing rows still pass. Precedent: 8.1. Everything else is additive:
  - nullable `audit_events.from_department_id uuid` and `to_department_id uuid` (no FK; audit rows outlive everything);
  - a new check: `(action = 'transfer' and to_department_id is not null) or (action <> 'transfer' and from_department_id is null and to_department_id is null)`;
  - the new function.
- **Function** `public.transfer_employee(p_employee_id text, p_to_department_id uuid) returns text` (the employee's name):
  - plpgsql, `security definer`, `set search_path = ''`. The actor is `auth.uid()`, never a parameter.
  - The admin test is `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`, the same test the departments policies use.
  - Errors are P0001, checked in this order:
    1. `not_authorized`: null actor, or the caller's own employee row is archived.
    2. `employee_not_found`: the employee row does not exist. The function locks it `for update`.
    3. `department_not_found`: the destination does not exist.
    4. `not_authorized`: the caller is not an admin, and the source department or the destination fails the authority test. For the source, that is `manages_employee(p_employee_id)`; with a null source department, only an admin passes. For the destination, it is `manages_department(p_to_department_id)`.
    5. `same_department`: the destination is the current department.
    6. `open_assignment`: the employee has an `assignments` row with `status = 'open'`.
  - On success, it updates `employees.department_id` and inserts `audit_events(actor, target, action, from_department_id, to_department_id)` with action `'transfer'`. Both happen in the one rpc transaction.
  - Grants: revoke execute from public and anon; grant it to authenticated.
- **Store:** `employees-store.transfer(session, employeeId, toDepartmentId)` returns `{ employeeId, name, fromDepartmentId, toDepartmentId }`.
  - It validates `^BS-\d{4}$` and the uuid format (`TransferInvalidError`).
  - Staff are refused (`TransferForbiddenError`) before any call.
  - Managers get store-level checks first (defence in depth): the employee must be in `scope.employeeIds` and the destination in `scope.departmentIds`, or `TransferForbiddenError`. A failed scope read is `EmployeesUnavailableError`.
  - The rpc goes through `userClient` for both admin and manager. It never uses the service role.
  - Error mapping:

    | Database error | Store error |
    |---|---|
    | `not_authorized`, 42501 | `TransferForbiddenError` |
    | `employee_not_found` | `TransferNotFoundError` |
    | `department_not_found` | `TransferDepartmentError` |
    | `same_department` | `TransferSameDepartmentError` |
    | `open_assignment` | `TransferOpenAssignmentError` |
    | anything else | `EmployeesUnavailableError` |

  - `fromDepartmentId` is the employee's department read before the rpc call. It is informational only.
- **Action** `transferEmployeeAction` in `src/server/employee-actions.ts`. It returns `{ error, message }`:
  - the session must be admin or manager;
  - the form fields `employeeId` and `toDepartmentId` are validated with zod;
  - the store does the transfer, then `revalidatePath("/")`;
  - the success message is "`<name>` was moved to `<department name>`.", and refusals use the messages in the matrix.
- **UI:** `src/components/transfer-panel.tsx` is a client component, shown on the profile Overview for admin and manager sessions.
  - It shows "Department: `<name>`" (or "No department").
  - It has a labelled `<select>` of the portal's `departments` minus the current one. That is all departments for the admin, and the subtree for a manager, which is where a manager has destination authority.
  - A "Transfer employee" button submits the form. The status and error regions are text.
  - If no other department is available, it says so and shows no form.
- Past assignments keep their recorded `department_id`: nothing updates assignments. Training is keyed by employee, so it follows the employee unchanged.
- Live DB tests sign each user in once per file and use `{ defaultToNull: false }` for bulk inserts.

**Never:**
- No service-role path for transfers. No `is admin`-only shortcut in the store for managers. No caller-supplied actor.
- No change to any assignment, evaluation, backfill or training row. No department edits through 7.2's basic-details path.
- No transfer UI in the staff portal. No audit-log viewer.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Manager over both | Manager of parent P transfers an employee in P to child C | `department_id` = C; one audit row (actor, target, transfer, P, C) | "`<name>` was moved to C." |
| Administrator | Admin transfers any employee, including one with no department | Moved; audit row with `from` null when there was none | Same message |
| Authority over one only | Destination outside the manager's subtree, or the source is | Rejected; nothing written | "You can only move people between departments you manage." |
| Open assignment | The employee has an open assignment | Rejected | "Close this employee's open assignment before moving them." |
| Same department | The destination equals the current department | Rejected | "This employee is already in that department." |
| Unknown department | The destination uuid does not exist | Rejected | "Choose a department from the list." |
| Unknown employee | No such id | Rejected | "Employee not found." |
| Staff | Any transfer, including their own (store, action or direct rpc) | Rejected at the server | Forbidden message (action: "Only an Administrator or a department manager can move employees.") |
| History kept | After a transfer | Past assignments still show their old department, and training is unchanged | — |
| DB down | rpc throws or returns an unknown error | Nothing claimed | "Employee records are temporarily unavailable. Nothing was changed." |

</intent-contract>

## Code Map

- `supabase/migrations/20261014040000_manager_archive.sql` -- the pattern for the function: security definer, `auth.uid()` actor, archived-caller guard, P0001 codes, grants.
- `supabase/migrations/20261014020000_manager_scope.sql` -- `manages_department(uuid)` and `manages_employee(text)` (the authority chain, AD-4).
- `supabase/migrations/20261013000000_activity_export_audit.sql` -- the precedent for widening `audit_events_action_check`, and the existing `audit_events_period_check`. Transfer rows have null periods, so that check still holds.
- `supabase/migrations/20261014030000_assignments.sql` -- the `assignments.status` values ('open'/'closed').
- `src/server/employees-store.ts` -- add `transfer` to `EmployeesStore`, plus the new error classes. `run()`, `userClient` and `scope` are already injected. Default wiring is at the bottom.
- `src/server/accounts-store.ts:312-355` (`createManagerAccessStore`) -- the pattern for rpc error-message mapping and store-level scope checks.
- `src/server/account-actions.ts:63-121` -- the action pattern: `getActor()`, role gate, zod, `revalidatePath`, `failure()`.
- `src/server/session.ts` -- `SessionIdentity` (admin has no userId; manager has `userId` and `employeeId`).
- `src/components/portal.tsx:155,174` -- `departmentName()` and the Overview grid, where `AccountAccessPanel` renders. Add `TransferPanel` there, with `key={`transfer-${selected.id}`}`, passing `departments`, `selected.departmentId` and the refreshed `all` value.
- `src/components/account-access-panel.tsx` -- the client panel pattern (`useActionState`, status/alert regions).
- Tests to copy: `tests/accounts-store.test.ts` (manager access store, fake rpc), `tests/account-actions.test.ts`, `tests/manager-archive-rls.test.ts` (live; use a new slot range BS-86xx), `tests/e2e/manager-archive.spec.ts` (e2e manager plus a throwaway department), `tests/components/portal.test.tsx`, `tests/employees-store.test.ts`.

## Tasks & Acceptance

**Execution:**
1. `supabase/migrations/20261016020000_department_transfer.sql` -- add the columns, the widened check, the transfer check and `transfer_employee`, with a header that classifies the migration DESTRUCTIVE and explains each choice.
2. `src/server/employees-store.ts` + `tests/employees-store.test.ts` -- add `transfer` and the error classes; test every matrix row at the store level with a fake client and an injected scope.
3. `src/server/employee-actions.ts` + `tests/employee-actions.test.ts` -- add the session gate, zod and message mapping.
4. `src/components/transfer-panel.tsx`, `src/components/portal.tsx` + `tests/components/transfer-panel.test.tsx` -- add the panel: current department, options excluding the current one, the no-options text, and status/error regions; the portal renders it for admin and manager.
5. `tests/transfer-single-writer.test.ts` -- only `src/server/employees-store.ts` under `src/` calls `transfer_employee`, and nothing under `src/` updates `employees.department_id` directly.
6. `tests/transfer-rls.test.ts` (live) -- the actors are a manager of P (with child C), a manager of C only, a plain Staff member, an admin, and an employee with an open assignment. Assert:
   - P's manager moves P→C, and exactly one audit row is written with the from/to values;
   - C's manager moving C→P gives `not_authorized`;
   - Staff (self or other) gives `not_authorized`;
   - an open assignment gives `open_assignment`;
   - the same department gives `same_department`;
   - an unknown destination gives `department_not_found`;
   - the admin moves a no-department employee;
   - the past assignment keeps its `department_id`;
   - anon cannot execute the function.
7. `tests/e2e/transfer.spec.ts` -- the e2e manager gets throwaway departments P and child C; the managed Staff member starts in P. The manager transfers them to C through the panel, and the profile then shows C.
8. `docs/DEPLOYMENT.md` -- add the migration to the apply list (DESTRUCTIVE, constraint-widening only; no seed change).

**Acceptance Criteria:**
- Given an admin or manager on a profile's Overview, when they pick a destination and press "Transfer employee", then the panel shows the success text and the employee's department reads as the destination after refresh.
- Given a manager whose subtree holds no other department than the employee's, when the Overview renders, then the panel says there is nowhere to move them and offers no form.

## Spec Change Log

## Review Triage Log

### 2026-10-16 — Review pass
- verdicts: 30 findings — high 0, medium 2, low 24, false 4, maybe-false 0 (five descriptive intent-alignment observations were triaged as findings)
- findings:
  - blind-hunter
    - `[low]` `[patch]` e2e cleanup sets the shared managed Staff member's department to null instead of restoring it — the spec now reads the original department_id and restores it in `finally`.
    - `[low]` `[reject]` No guard against a manager moving themselves or a peer manager — the AC defines authority as "authority over both departments" and restricts only Staff; 4.9's rank rule is specific to archiving (Design Notes). Adding a rank rule would invent a requirement.
    - `[low]` `[reject]` Archived employees can be transferred — nothing in the story forbids it; recorded as a Design Notes assumption.
    - `[low]` `[reject]` An Administrator can see the manager-worded forbidden message — only reachable for an archived or token-less admin; a role branch is not worth it for that path.
    - `[low]` `[patch]` The informational pre-read of department_id makes the whole transfer fail when it errors — the read is now best-effort (null on failure); the test was updated.
    - `[low]` `[reject]` For managers, an unknown employee or a stale destination reads as forbidden, not "not found" — deliberate: out-of-scope and nonexistent stay indistinguishable for a manager (no existence oracle), as in 4.9; the matrix's "Unknown employee" row is covered for the Administrator.
    - `[low]` `[reject]` No confirmation step — consistent with 4.5's close and 4.9's archive, which have none; confirmation dialogs would be new UX across the app.
    - `[low]` `[patch]` The form resets the chosen department after a refusal — the form is now re-keyed only after a success.
    - `[low]` `[reject]` The panel keeps an optimistic department over later props — needs another user to transfer the same employee while the panel is mounted; keying on the prop would also drop the success message on revalidation.
    - `[low]` `[patch]` Live RLS gaps (archived caller, source-only out of scope, no-write on refusals) — tests added (grouped with the verification-gap finding below).
    - `[medium]` `[patch]` After a transfer, a manager whose subtree does not hold the old department sees past assignments labelled "No department", so "past assignments still show the department they were done under" fails at the viewing surface — the manager portal now also receives every department's id and name (through `department_options()`, as in 4.7) and uses it to label history rows; portal test added.
    - `[low]` `[reject]` 42501 maps to forbidden, so a missing grant looks like a refusal — the spec's error table sets this mapping; changing it is a spec edit.
    - `[low]` `[reject]` Validation duplicated in the action and the store — harmless defence in depth; the store is also called directly by tests.
    - `[false]` `[reject]` No test that Staff never see the panel — Staff never render `Portal` (page.tsx renders `StaffAttendance`), so the panel cannot appear for them.
  - edge-case-hunter
    - `[low]` `[defer]` An assignment insert racing a transfer can be recorded under the old department, because `assignments_guard` reads the department without a lock (the FK key-share lock waits, but only after the guard copied the old value) — the fix changes the 4.5 guard function, an existing object; deferred.
    - `[low]` `[reject]` A lost response after commit shows "Nothing was changed" — same behaviour as every other rpc action (4.9); very unlikely.
    - `[low]` `[reject]` Archived target can be transferred — duplicate of the blind-hunter row.
    - `[low]` `[reject]` Manager self-transfer — duplicate of the blind-hunter row.
    - `[false]` `[reject]` A rejected server action is unhandled in `submit` — the same pattern as `account-access-panel.tsx`; Next.js server actions report failure through the returned state, and a transport failure goes to the error boundary app-wide by design.
    - `[low]` `[reject]` Stale optimistic department — duplicate.
    - `[low]` `[patch]` Pre-read failure blocks the transfer — duplicate; same fix.
    - `[low]` `[patch]` e2e cleanup nulls the department — duplicate; same fix.
    - `[low]` `[reject]` A manager's mistyped id reads as forbidden — duplicate of the no-oracle row.
  - verification-gap
    - `[low]` `[patch]` The archived-caller refusal is never exercised — live test added: archive mP's own row, call as mP, expect not_authorized and nothing written, then restore.
    - `[low]` `[patch]` The portal's use of the refreshed `departmentId` is unverified — portal test added: rerender with a new department, tab round-trip, panel follows.
  - intent-alignment
    - `[low]` `[patch]` "Authority over only one" is tested live in one direction only — the source-only-out-of-scope live case was added.
    - `[medium]` `[patch]` History after a transfer is not exercised at the viewing surface — grouped with the "No department" label finding; same fix and test.
    - `[false]` `[reject]` Training history is not asserted after a transfer — training rows are keyed by employee_id and the function touches only employees.department_id and audit_events; nothing can change them.
    - `[false]` `[reject]` The audit "when" is not asserted — `audit_events.occurred_at` is `not null default now()` (20261008000000) and cannot be supplied by the function.
    - `[low]` `[reject]` No live successful transfer through `employees-store.transfer()` — the store's rpc call is unit-tested and the e2e test goes through the store end to end.

## Design Notes

A single SECURITY DEFINER function gives "one step" for real: the authority checks, the open-assignment check, the update and the audit row all run in one transaction under a row lock on the employee. The same function serves admins and managers through their own JWT, so the audit actor is always `auth.uid()`. This matches the departments writes, which also run through the admin's JWT.

The authority set is the AD-4 rule: the admin unconditionally, or a manager on both chains. It is not a rank rule; 4.9's rank rule is specific to archiving. Self-transfer by a manager is allowed when they have authority over both departments, because the ACs restrict only Staff. Archived employees can be transferred, because nothing forbids it.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors.
- `npm test` -- expected: all pass, except live DB tests that need unapplied migrations. Those may fail only with 42P01, 42703, 42883, PGRST202, PGRST204 or PGRST205.
- `npm run build` -- expected: success.
- e2e with Chromium (a local uncommitted config with `launchOptions.executablePath` set to `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) -- expected: pass, or fail only with schema-missing errors.
- The migration is applied to a scratch local Postgres 16 with stub `auth` schema and functions -- expected: the function's error paths behave as in the matrix.

## Auto Run Result

Status: done

**Summary:** Administrators and department managers can now move an employee to another department in one step.
- **Database:** `public.transfer_employee(employee, destination)` is a SECURITY DEFINER function called through the actor's own JWT, with the actor taken from `auth.uid()`. In one transaction it:
  - checks that the caller is the Administrator, or manages both the source and the destination (AD-4);
  - refuses Staff, archived callers, unknown employees or departments, a move to the current department, and an employee with an open assignment;
  - updates `employees.department_id`;
  - writes one `audit_events` row (actor, target, `transfer`, from, to, `occurred_at`).
- **Code:** `employees-store.transfer()` (FR-11) wraps it, with scope pre-checks for managers, and `transferEmployeeAction` maps the outcomes to messages.
- **UI:** a "Department" panel on the profile Overview shows the current department and offers the other departments the session can see.
- **History:** past assignments keep their department. Manager portals now label history rows from every department's name (`department_options()`), so a past assignment from a department outside the manager's subtree still shows its real name.

**Migration:** `supabase/migrations/20261016020000_department_transfer.sql` is **DESTRUCTIVE**. It drops and replaces `audit_events_action_check`, widening it only by adding `'transfer'`. Everything else in it is additive: two nullable columns, a new check, and the function. No seed change.

**Files:**
- `supabase/migrations/20261016020000_department_transfer.sql`: the audit columns and checks, plus `transfer_employee`.
- `src/server/employees-store.ts`: `transfer()` and six error classes.
- `src/server/employee-actions.ts`: `transferEmployeeAction` (new).
- `src/components/transfer-panel.tsx`: the Department panel (new).
- `src/components/portal.tsx`: renders the panel; `departmentNames` fallback for history labels.
- `src/app/page.tsx`: the manager branch passes `departmentNames`.
- Tests:
  - new: `tests/employee-actions.test.ts`, `tests/components/transfer-panel.test.tsx`, `tests/transfer-single-writer.test.ts`, `tests/transfer-rls.test.ts` (live), `tests/e2e/transfer.spec.ts`;
  - extended: `tests/employees-store.test.ts`, `tests/components/portal.test.tsx`, `tests/page.test.tsx`.
- `docs/DEPLOYMENT.md`: the migration is added to the apply list.

**Review:** one pass, 30 findings. 4 were false.
- **Patched:** 2 medium findings (one root cause) and 8 low. The fixes:
  - manager history labels for departments outside the subtree;
  - the best-effort pre-read;
  - the panel keeps the chosen department after a refusal;
  - e2e cleanup restores the original department;
  - live tests for the archived caller, destination-only authority, and no writes on refusals;
  - a portal test for refreshed department props.
- **Deferred:** 1 (the assignment-insert race in the 4.5 guard), recorded in frontmatter.
- **Rejected:** the rest, with reasons in the triage log. The main ones: no rank rule for transfers (the AC defines authority only), archived targets are allowed, no confirmation dialog (consistent with archive and close), and managers get "forbidden" rather than "not found" (so the message never reveals whether an employee exists).

**Follow-up review recommended:** false. This pass patched one medium entry and no high ones.

**Verification:**
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 1449 passed, 10 failed. All 10 are in `tests/transfer-rls.test.ts`, and every failure is schema-missing: PGRST202 (`transfer_employee` not found) or 42703 (`audit_events.from_department_id` does not exist).
- e2e on Chromium: the full run had 31 passed and 1 failed, and the re-run of `transfer` and `portal` after the patches had 2 passed and 1 failed. The failure is `transfer.spec.ts`: the server logged "Employee transfer failed. EmployeesUnavailableError" (PGRST202 underneath), so the UI showed the "temporarily unavailable" message.
- The implementer applied every migration to a scratch local Postgres 16 with stubbed `auth` functions. Every matrix row behaved as specified.

**Residual risks:**
- The live and e2e transfer tests have not yet passed against the real schema. Re-run them after the migration is applied.
- The live RLS test leaves fixed throwaway rows in the shared project: employees BS-80xx (BS-8000..BS-8031; moved from BS-86xx at integration, which Story 7.4's live test uses) and departments "RLS Transfer slot N P/C".

