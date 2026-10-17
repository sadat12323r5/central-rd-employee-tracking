---
title: 'Story 5.3: Edit or cancel a leave period'
type: 'feature'
created: '2026-10-17'
status: 'in-review'
baseline_revision: '1f9687857c5e26321d36a852663c7b45dc396916'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-record-leave.md'
warnings: ['oversized']
deferred: []
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

## Design Notes

Editing always recounts with the active calendar (the trigger requires it), so an edit after a corrected calendar is loaded moves the row to the new version; untouched rows keep theirs. "Excluded from totals" is realised by Story 5.4.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests that need the 5.1/5.2/5.3 migrations, failing only with schema-missing errors
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass except specs needing the new schema, failing only on schema-missing errors
