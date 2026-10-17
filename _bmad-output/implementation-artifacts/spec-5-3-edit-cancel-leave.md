---
title: 'Story 5.3: Edit or cancel a leave period'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_revision: '1f9687857c5e26321d36a852663c7b45dc396916'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-record-leave.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Leave edits and cancels keep no audit trail (who changed it, previous dates).
    evidence: |-
      An edit overwrites the period in place; leave_records has no updated_by/cancelled_by and no history table. No table in the app records updaters yet, so this needs one cross-table decision.
    location: >-
      supabase/migrations/20261019000000_leave_records_update.sql
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 5.2 records leave but a period cannot be changed or cancelled when plans change; `leave_records` has no update policy and the store/actions/panel have no edit or cancel path.

**Approach:** One ADDITIVE migration adding an update RLS policy (same predicate as select/insert; the 5.2 guard trigger already owns the update rules). `leaveStore.update` / `leaveStore.cancel` with the subject read from the target row, `updateLeaveAction` / `cancelLeaveAction`, and per-row Edit / Cancel leave controls in `LeavePanel` for active (non-cancelled) periods.

## Boundaries & Constraints

**Always:**
- Who: exactly who may record that employee's leave (5.2 `authorize`): the employee themselves (Staff; managers/employee-linked admins in "My record"), a manager for their subtree, the Administrator for anyone. The subject employee comes from the stored row, never the form. Staff targeting another employee's row → not found (RLS hides it anyway); manager outside subtree → forbidden. Enforced in action, store and RLS.
- Edit: recount with `countWorkingDays` against the active calendar, new category from `categoryForWorkingDays`, `calendar_version_id` = active version id. Same validation messages as 5.2. Overlap check ignores the record being edited (`neq id`) and cancelled rows; the trigger backstop already excludes `id`.
- Write is filtered by `id`, `employee_id` and `cancelled_at is null`, so a row cancelled in between changes nothing (reported as "already cancelled").
- Cancel: sets `cancelled_at` only (the trigger stamps `now()` and refuses any other change in the same update). The row stays in the list with its "Cancelled" badge, is excluded from overlap checks (5.2 already filters), and is never deleted. A cancelled row cannot be edited or cancelled again (store check + trigger).
- `{ error, message }` results, zod in both actions (`id` uuid, dates as 5.2). Migration ADDITIVE only.

**Never:** No hard delete, no un-cancel, no attendance totals change (5.4), no reasons/approvals, no service role at runtime, no change to the 5.2 trigger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Edit own | Staff, own active 2026-03-02..05 → 2026-03-02..10 | 7 working days, "4–14 working days", active version | "Leave updated: 7 working days (4–14 working days)." |
| Edit overlapping itself | own 03-02..05 → 03-03..06 | Saved (own record ignored) | — |
| Edit overlapping another | other active 03-09..10; edit → 03-05..09 | Nothing saved | "This overlaps leave already recorded from 9 Mar 2026 to 10 Mar 2026." |
| Edit invalid / reversed / outside / zero | as 5.2 | Nothing saved | the 5.2 messages |
| Cancel | own active row | `cancelled_at` set, row kept | "Leave cancelled. It stays in the leave history and no longer counts." |
| Already cancelled | edit or cancel a cancelled row | Nothing saved | "This leave was cancelled and can no longer be changed." |
| Staff, another's row | Staff, row of another employee | Nothing saved | "This leave period no longer exists." |
| Manager out of scope | row outside subtree | Nothing saved | "You can only change leave for employees in your department." |
| Bad id | id not a uuid | No store call | "Choose a valid leave period." |
| DB down | query error | Nothing saved | "Leave is temporarily unavailable. Nothing was saved." |

</intent-contract>

## Code Map

- `supabase/migrations/20261018000000_leave_records.sql` -- READ-ONLY (5.2): guard trigger UPDATE branch already locks id/employee_id/created_by/created_at, freezes cancelled rows, stamps `cancelled_at`, requires the active calendar version, recounts and checks overlap excluding `new.id`. Select/insert policy predicate to copy.
- `supabase/migrations/20261015020000_employment_history.sql:132-149` -- update-policy precedent (`using` + `with check`).
- `src/server/leave-store.ts` -- add `update`/`cancel` to `LeaveStore`; reuse `authorize`, `activeCalendar`, `insertRefusal` (generalise to a write refusal; map trigger message "was cancelled" → `LeaveCancelledError`), `run`. New `LeaveNotFoundError`, `LeaveCancelledError`. Add `runMaybe` like `employment-history-store.ts:132`, and the `change()` shape at `employment-history-store.ts:185-197`.
- `src/server/leave-actions.ts` -- add `updateLeaveAction`, `cancelLeaveAction`; reuse `refusal`, `namesSomeoneElse`, `period`. Forbidden wording for edits: "You can only change leave for employees in your department." / Staff "You can only change your own leave."
- `src/components/leave-panel.tsx` -- per active row (when `canEdit`) a controls cell: Edit (inline form, prefilled dates) and Cancel leave (confirm step), modelled on `EntryControls` in `src/components/employment-history-panel.tsx`; cancel state owned by the panel.
- Live-test rules: sign each test user in once per file and reuse the session (Supabase rate-limits sign-ins); bulk inserts pass `{ defaultToNull: false }`; never print or write secret env values. The 5.3 migration is not applied to the shared DB yet (this sandbox cannot reach Postgres), so live update cases will fail with RLS/schema errors until a human applies it; write them anyway.
- Tests: `tests/leave-store.test.ts` (fake client supports `update`, `neq`), `tests/leave-actions.test.ts`, `tests/components/leave-panel.test.tsx`, `tests/leave-rls.test.ts` (live; id block BS-8300..8399), `tests/e2e/leave.spec.ts`.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261019000000_leave_records_update.sql` -- ADDITIVE: `create policy "leave_records_update" ... for update to authenticated using (pred) with check (pred)`.
- `src/server/leave-store.ts` -- `update(session, id, input)`, `cancel(session, id)`; typed errors as the matrix.
- `src/server/leave-actions.ts` -- two actions, messages exactly as the matrix.
- `src/components/leave-panel.tsx` (+ `src/app/styles.css` if needed) -- Edit / Cancel leave controls on active rows only.
- Tests: store and action unit tests for every matrix row; panel tests (controls shown only for active rows with canEdit; edit submits id + dates; cancel confirms first); live RLS: own edit, own cancel, cancelled row frozen, other Staff refused, manager in/out of scope, admin, edit-overlap backstop ignoring self, employee_id change refused, cancel+change refused; e2e: Staff edits then cancels own leave.

**Acceptance Criteria:**
- Given an existing active leave record, when its dates change, then working days and category are recalculated against the active calendar and shown in the list.
- Given an edit, when overlap is checked, then the record being edited is ignored.
- Given an active leave record, when it is cancelled, then it shows "Cancelled", stays in the list, is excluded from later overlap checks and is never deleted.
- Given someone who couldn't record leave for that employee, when they edit or cancel it (action, store or direct API update), then it is rejected at the server.

## Spec Change Log

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 22 findings — high 0, medium 2, low 16, false 4, maybe-false 0 (plus 4 descriptive intent rows)
- findings:
  - `[low]` `[reject]` (blind) Manager outside the subtree sees "This leave period no longer exists." live, not the department message — RLS hides the row, so the refusal still happens at the server (AC met); only the wording differs and making the forbidden message reachable means reading past RLS, which the spec forbids. The live test asserts not-found.
  - `[low]` `[defer]` (blind) No audit trail (who edited/cancelled, previous dates) — not required by the story; no table in the app records updated_by yet (employment history neither). Needs a cross-table audit decision.
  - `[false]` `[reject]` (blind) No cut-off for editing past leave — no rule exists in the PRD/epics (no approvals by design); not a defect.
  - `[low]` `[patch]` (blind+gap) Cancel confirm unmounted on submit: pending label never shown, focus dropped — confirm form now stays open while pending and after a refusal.
  - `[low]` `[reject]` (blind) Cancel refusal shown at panel level and persists — same pattern as employment history (precedent); row controls unmount on success.
  - `[low]` `[reject]` (blind) One empty status region per editable row — same as the employment-history precedent; cosmetic.
  - `[low]` `[patch]` (blind) Shared cancel pending disables every row's confirm — grouped with the confirm fix; only open confirm forms are affected, which is acceptable while one cancel is in flight.
  - `[false]` `[reject]` (blind) Saving unchanged dates recounts silently — deliberate (Design Notes): the 5.2 trigger requires the active version on every edit.
  - `[medium]` `[patch]` (blind+edge) Empty update result always reported as "cancelled" (e.g. RLS-hidden, or update policy not yet applied) — write() now re-reads cancelled_at: cancelled → cancelled, otherwise not found; tested.
  - `[false]` `[reject]` (blind) writeRefusal without input yields a malformed UNSUPPORTED_YEAR message — refusal() falls back to "The holiday calendar does not cover these dates yet." when years are null.
  - `[low]` `[patch]` (blind) Missing tests: cancelLeaveAction rethrow, anon update — added. Locked created_by/created_at on update rely on the 5.2 trigger's existing column lock (same branch as employee_id, which is tested).
  - `[low]` `[patch]` (blind) Redundant missing-id assertion inside the id it.each — split into its own test.
  - `[false]` `[reject]` (blind) Comments about the 5.2 trigger contradict — the 5.2 migration does own the UPDATE branch; the store header was updated for 5.3.
  - `[low]` `[reject]` (blind) useEffect missing closeEdit dependency — no ESLint in the repo; the component was restructured in the patch anyway.
  - `[low]` `[patch]` (edge) Stale edit error after refuse + "Don't save" + Edit — edit form is now its own component mounted per opening; tested.
  - `[low]` `[patch]` (edge) Stale "Leave updated" status after reopen/close — cleared on reopening; tested.
  - `[medium]` `[patch]` (edge) Update matching zero rows reported as cancelled — same root cause as the write() row above.
  - `[low]` `[reject]` (edge) Manager forbidden branch unreachable live — duplicate of the first row.
  - `[low]` `[reject]` (edge) Trigger refusals "cannot also change"/locked columns/count mismatch map to "unavailable" — the app never sends those combinations; reachable only by a crafted API call, where a generic refusal is fine.
  - `[low]` `[patch]` (gap) Stale edit error reappears — duplicate of the edge row, same patch.
  - `[low]` `[patch]` (gap) Confirm-button disable never shows — duplicate of the confirm row, same patch.
  - `[low]` `[reject]` (intent) Forbidden vs not-found differ between fake and live store tests — duplicate of the first row; the live behaviour is the asserted one.
  - intent rows (reading B = same authority as recording; D2 active-calendar recount by design; E1 cancelled frozen; F1+F2 enforced in action, store and RLS; UI roles beyond Staff covered at store/RLS, not e2e) — descriptive, no action.

## Design Notes

Editing always recounts with the active calendar (the trigger requires it), so an edit after a corrected calendar is loaded moves the row to the new version; untouched rows keep theirs. "Excluded from totals" is realised by Story 5.4.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests that need the 5.1/5.2/5.3 migrations, failing only with schema-missing errors
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass except specs needing the new schema, failing only on schema-missing errors

## Auto Run Result

Status: done

**Summary:** Leave periods can be edited (recounted against the active calendar, category reassigned, overlap ignoring the period itself) or cancelled (cancelled_at set, row kept, excluded from later overlap checks, never deleted) by exactly who may record them. The subject employee comes from the stored row. An ADDITIVE migration adds the leave_records update RLS policy; the 5.2 guard trigger already owns the update rules.

**Files changed:**
- `supabase/migrations/20261019000000_leave_records_update.sql` -- ADDITIVE: update RLS policy (same predicate as select/insert).
- `src/server/leave-store.ts` -- `update`, `cancel`, `LeaveNotFoundError`, `LeaveCancelledError`; shared count/overlap helpers; write refusal mapping for updates.
- `src/server/leave-actions.ts` -- `updateLeaveAction`, `cancelLeaveAction` (zod, matrix messages).
- `src/components/leave-panel.tsx`, `src/app/styles.css` -- per-row Edit (inline form, per-open state) and Cancel leave (confirm, stays open while pending) on active rows.
- Tests: `tests/leave-store.test.ts`, `tests/leave-actions.test.ts`, `tests/components/leave-panel.test.tsx`, `tests/components/portal.test.tsx`, `tests/components/staff-attendance.test.tsx`, `tests/leave-rls.test.ts` (live update/cancel cases incl. the 5.2 trigger's UPDATE branch), `tests/e2e/leave.spec.ts` (Staff edits then cancels).

**Review:** 22 findings. Patched: 1 medium (empty update reported as cancelled), 9 low rows (stale edit state, cancel confirm pending/focus, missing tests, test tidy). Deferred: audit trail for edits/cancels (low). Rejected: manager-out-of-scope wording (RLS hides the row; still refused), no past-leave cut-off (no rule), panel-level/per-row status regions (precedent), unchanged-dates recount (by design), malformed UNSUPPORTED_YEAR (fallback exists), contradictory comments (false), exhaustive-deps (no ESLint), trigger refusal mapping (unreachable from the app).

**Follow-up review recommended:** false (patched: high 0, medium 1, low 9).

**Verification:**
- `npm run typecheck` -- pass.
- `npm run build` -- pass.
- `npm test` -- 2114 passed, 9 failed, 19 skipped. All 9 failures are live-DB tests failing with PGRST205 (`holiday_calendar_versions` / `leave_records` missing: the 5.1 and 5.2 migrations are not applied to the shared project).
- `npm run test:e2e` (PLAYWRIGHT_CHANNEL=chromium) -- every spec that loads the portal fails because employees-store reads leave_records (5.2) → PGRST205; `leave.spec.ts` fails at setup with "Could not read the active calendar (PGRST205)". No other failure cause seen.

**Residual risks:** the update policy and all live/e2e edit and cancel cases are unverified until the 5.1, 5.2 and 5.3 migrations are applied; e2e reuses BS-8390 and kept (cancelled) rows accumulate across runs (pre-existing 5.2 pattern).
