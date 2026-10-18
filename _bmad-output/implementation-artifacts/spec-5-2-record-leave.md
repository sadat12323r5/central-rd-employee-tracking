---
title: 'Story 5.2: Record a leave period'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_revision: '22d0ec89e6a52e27065552eee32fcd3f0f7ce8b4'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-1-holiday-calendar.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Leave can be recorded for an archived employee.
    evidence: |-
      Neither the store, RLS nor the trigger checks employees.archived_at; employment history has the same gap (deferred in 7.3).
    location: >-
      src/server/leave-store.ts
    severity: medium
  - summary: >-
      The profile Attendance tab still shows fixture stats next to the real leave list.
    evidence: |-
      Story 5.4 replaces the stats with real data.
    location: >-
      src/components/portal.tsx
    severity: low
  - summary: >-
      The guard trigger's UPDATE branch has no live test.
    evidence: |-
      Only test cleanup updates rows in 5.2; Story 5.3 adds edit/cancel and should add service-role update cases.
    location: >-
      supabase/migrations/20261018000000_leave_records.sql
    severity: low
---

<intent-contract>

## Intent

**Problem:** Leave cannot be recorded: `src/domain/leave.ts` counts working days and assigns categories, and Story 5.1 stores the holiday calendar, but there is no leave table, store, action or UI.

**Approach:** Add a `leave_records` table (additive migration, RLS like `employment_history`), a `leaveStore` that authorises the subject, counts working days against the active calendar from `holidayCalendarStore.active()`, assigns the category, rejects overlaps and stores the calendar version used; one `recordLeaveAction`; a `LeavePanel` (list + form) on the Staff portal / "My record" and on the admin/manager profile Attendance tab.

## Boundaries & Constraints

**Always:**
- Who: the employee for themselves (Staff portal; managers and employee-linked Administrators through "My record", identical rules); a manager for any employee in their department subtree (manager-scope, fresh per request) and for themselves; the Administrator for anyone. Out-of-scope attempts are refused in the action, the store and RLS.
- Subject: Staff → always `session.employeeId` (a form naming anyone else is refused); admin/manager → the form's `employeeId` (zod, `BS-\d{4}`).
- Count: `countWorkingDays(start, end, active.policy)`; category from `categoryForWorkingDays`; both stored with the row together with `calendar_version_id` = the active version's id. No calendar loaded → refused with a clear message.
- Overlap: rejected when the range intersects (inclusive) any non-cancelled leave of the same employee. Store checks first; a DB trigger (advisory lock per employee) is the backstop, raising 23514 `leave_overlap`, mapped to the same error.
- Table carries `cancelled_at timestamptz null` (always null in 5.2; Story 5.3 uses it). Overlap ignores cancelled rows.
- No update or delete policy for users (5.3 adds editing). `created_by` / `created_at` owned by a guard trigger. Migration ADDITIVE only.
- Category always shown with its text label as well as its colour; dates `D MMM YYYY`; `{ error, message }` results; zod in the action.

**Never:** No edit or cancel (5.3). No change to the attendance stats/summary, which stay fixture-based (5.4). No approvals, reasons, balances. No reimplementing working-day logic. No service role at runtime.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Own leave | Staff, 2026-03-02..2026-03-05 (Mon–Thu, no holiday) | Stored: 4 working days, "4–14 working days", calendar version id | "Leave recorded: 4 working days (4–14 working days)." |
| Holiday excluded | Staff, 2026-03-25..2026-03-27 (26 Mar = Independence Day) | 2 working days, "1–3 working days" | — |
| Manager in scope | manager, employee in subtree | Stored | — |
| Manager out of scope | manager, employee outside subtree | Nothing stored | "You can only record leave for employees in your department." |
| Staff for someone else | Staff form names another employee | Nothing stored | "You can only record your own leave." |
| Admin anyone | admin, any employee | Stored | — |
| Overlap | existing active 2026-03-02..05, new 2026-03-05..10 | Nothing stored | "This overlaps leave already recorded from 2 Mar 2026 to 5 Mar 2026." |
| Adjacent | existing ..2026-03-05, new 2026-03-06.. | Stored | — |
| Invalid date | 2026-02-30 | Nothing stored | "Enter real dates for the start and end of the leave." |
| Reversed | start after end | Nothing stored | "The end date must be on or after the start date." |
| Outside calendar | a 2027 date with a 2026 calendar | Nothing stored | "The holiday calendar covers 2026 only, so leave in 2027 can't be counted yet." |
| Zero working days | 2026-03-07..2026-03-08 (Sat–Sun) | Nothing stored | "This period has no working days (only weekends and holidays)." |
| No calendar | no version loaded | Nothing stored | "No holiday calendar is loaded yet. Ask the Administrator to load it." |
| DB down | query error | Nothing stored | "Leave is temporarily unavailable. Nothing was saved." |

</intent-contract>

## Code Map

- `src/domain/leave.ts` -- READ-ONLY: `countWorkingDays`, `categoryForWorkingDays`, `rangesOverlap`, `LeaveValidationError` codes.
- `src/server/holiday-calendar-store.ts` -- `holidayCalendarStore.active(session)` → `{ version, policy } | null` (any signed-in role). Inject it into the leave store for tests.
- `supabase/migrations/20261015020000_employment_history.sql` -- golden RLS/guard precedent: one predicate (admin inline JWT check OR own via `employees.auth_user_id = (select auth.uid())` OR `public.manages_employee(employee_id)`), guard trigger owning `created_by`/timestamps, delete/truncate refusal, how its live test cleans up.
- `supabase/migrations/20261017000000_holiday_calendars.sql` -- `holiday_calendar_versions(id)` for the FK (on delete restrict).
- `src/server/employment-history-store.ts` -- golden store: `createXStore({ userClient, scope })` (:128), `authorize()` (:160-170, manager-own rule :168), `managedEmployeeIds()` (:150-157), `writeRefusal()` (:114-119), `listFor` with `readAllPages` (:199-229), error classes (:42-84).
- `src/server/employment-history-actions.ts` -- golden action: `addEmploymentHistoryAction` (:87-111), `namesSomeoneElse` (:64-66), `refusal()` (:73-84).
- `src/server/employees-store.ts` -- sub-stores injected (:352-376, wiring :680-684) and grouped by `employee_id` in `listFor` (:576-604), `getFor` (:605-622), `listForManager` (:470-498), `getForManager` (:498-511); empty profile (:236-245). Add `leave` the same way as `history`.
- `src/data/employees.ts:44-101` -- `Employee` type; add `leave: LeaveRecord[]` (fixture employees get `[]`).
- `src/components/staff-attendance.tsx` -- `StaffSelfService` (:324); add a Leave section after "Recent days" (:438). Used by "My record" (`portal.tsx:223`).
- `src/components/portal.tsx:212` -- profile Attendance tab; add the `LeavePanel` (canEdit admin/manager) below the existing fixture stats, which stay unchanged.
- `src/components/employment-history-panel.tsx` -- panel/form markup to mirror.
- `tests/employment-history-rls.test.ts`, `tests/employment-history-store.test.ts`, `tests/employment-history-actions.test.ts`, `tests/e2e/employment-history.spec.ts` -- test patterns. Free live-test id block: BS-8300..8399; e2e uses the run's staff accounts.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261018000000_leave_records.sql` -- ADDITIVE: `leave_records` (uuid id, employee_id FK employees restrict, start_date, end_date check ≥ start, working_days int > 0, category check in the five codes, calendar_version_id FK restrict, cancelled_at null, created_by, created_at); guard trigger (created_by/created_at; same-year-range check against the calendar version; per-employee advisory lock + overlap with non-cancelled rows → 23514 `leave_overlap`); RLS select + insert with the employment_history predicate; no update/delete policy; delete/truncate refused as the precedent does; index on (employee_id, start_date).
- `src/server/leave-store.ts` -- `record(session, employeeId, { startDate, endDate })`, `listFor(session, employeeId?)` (non-cancelled and cancelled rows, newest start first); typed errors: Forbidden, Overlap(existing range), CalendarMissing, Validation(code from `LeaveValidationError`, years), Unavailable.
- `src/server/leave-actions.ts` -- `recordLeaveAction(prev, form)`; messages exactly as in the matrix.
- `src/data/employees.ts`, `src/server/employees-store.ts` -- `leave` field populated from `leaveStore.listFor`.
- `src/components/leave-panel.tsx` -- list (dates, working days, category label + colour swatch, "Cancelled" badge when cancelled) and, when `canEdit`, a form (start, end date inputs, hidden employeeId) with feedback.
- `src/components/staff-attendance.tsx`, `src/components/portal.tsx` -- render `LeavePanel` (Staff/My record always editable for self; profile tab editable for admin/manager).
- Tests: `tests/leave-store.test.ts`, `tests/leave-actions.test.ts` (every matrix row), `tests/components/leave-panel.test.tsx`, wiring cases in existing portal/staff-attendance/employees-store tests, `tests/leave-rls.test.ts` (live: own insert, other Staff refused, manager in/out of scope, admin, overlap backstop, no update/delete; ensure a 2026 calendar exists — load the provisional CSV through the service-role RPC only when none is active, and clean up only what the test created), `tests/e2e/leave.spec.ts` (Staff records own leave and sees it; same ensure-calendar step).

**Acceptance Criteria:**
- Given a Staff member, a manager in scope or the Administrator, when leave is recorded, then it is stored with working days excluding weekends and calendar holidays, the automatic category label and colour, and the calendar version, and it shows in the employee's leave list.
- Given a manager or employee-linked Administrator in "My record", when they record their own leave, then it behaves exactly as Staff own-record leave.
- Given a manager and an employee outside their subtree, when they record leave for that employee (action, store or direct API insert), then it is rejected at the server.

## Spec Change Log

- 2026-10-17 -- **Calendar purpose (bug fix).** `leave_records_guard` is redefined by `20261018010000_holiday_calendar_purpose.sql`: a period must be counted with the highest **live** calendar version (23514 `leave_calendar_changed` otherwise), so a test calendar loaded by another test can no longer make a leave save fail, and a period can never be counted with a test calendar. All other guard rules are unchanged. `tests/leave-rls.test.ts` and `tests/e2e/leave.spec.ts` now count against whatever live calendar is active (Bangladesh) and never load a live one; the stale-calendar case uses a throwaway `test` version.

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 29 findings — high 0, medium 2, low 19, false 4, maybe-false 0 (plus descriptive intent rows noted at the end)
- findings:
  - `[medium]` `[patch]` (blind+edge+intent) Direct API insert could store any working_days/category or an old calendar version — guard trigger now requires the highest version, recounts working days in SQL and checks the category band; live cases added; RLS helper computes real counts.
  - `[low]` `[patch]` (blind) Calendar version can go stale between read and insert — covered by the highest-version check; mapped to "The holiday calendar changed while saving. Try again."
  - `[low]` `[patch]` (blind+edge) Staff shown the manager-only forbidden message — Staff now get "You can only record your own leave."
  - `[false]` `[reject]` (blind) Manager cannot list own leave — a manager sees their own leave in "My record", which reads under the own-record identity; the profile list only shows their subtree.
  - `[low]` `[reject]` (blind+intent+edge claim) "My record" form for a manager/admin follows their role rules, not Staff's — a tampered form can only do what that role may already do; no escalation.
  - `[low]` `[defer]` (blind) Fixture attendance stats sit next to real leave with different numbers — Story 5.4 replaces them.
  - `[low]` `[patch]` (blind) Category bands restated in the panel — label/colour now from `categoryForWorkingDays`.
  - `[low]` `[patch]` (blind+edge) e2e ensureCalendar did not confirm 2026 coverage — now throws a clear setup error.
  - `[low]` `[reject]` (blind) Concurrent e2e runs collide on the fixed BS-8390 — e2e runs serially (workers: 1, one CI job).
  - `[low]` `[reject]` (blind) Advisory lock untested under concurrency — a reliable race test costs more than it buys; sequential overlap backstop is tested.
  - `[medium]` `[defer]` (blind+edge) Leave can be recorded for an archived employee — same as employment history (deferred in 7.3); needs a cross-table archived rule decided once.
  - `[false]` `[reject]` (blind) Spec unfinished / stale line refs — the spec is finalized at the end of the run; line refs were investigation anchors.
  - `[low]` `[reject]` (blind) No client-side date bounds — server messages cover it; dynamic min needs extra state.
  - `[low]` `[patch]` (edge) Overlap error without detail named the user's own dates — generic message now.
  - `[low]` `[reject]` (edge) Panel has no catch around the action — same as every other panel; unexpected errors go to the error boundary by design.
  - `[low]` `[reject]` (edge) Identical success messages not re-announced — same as other panels.
  - `[low]` `[patch]` (edge) Quadratic grouping in listFor — pushes into the existing group.
  - `[false]` `[reject]` (edge claim) Action tests miss the Adjacent row — covered in leave-store.test.ts, where the overlap rule lives.
  - `[false]` `[reject]` (edge claim) RLS cleanup touches rows from earlier runs — intended: the fixed ids are reserved for this test file.
  - `[low]` `[defer]` (gap) Guard trigger UPDATE branch (column locks, cancelled-row freeze, cancel stamping) untested — Story 5.3 adds the update path; add the cases there.
  - intent rows (attendance views not yet reflecting leave = 5.4; subtree scope; app-path counting now backed by the DB recount; e2e covers Staff only, manager/admin covered at store and RLS) — descriptive, no further action.

## Design Notes

Continuity from 5.1: the active calendar is the highest version and every signed-in role can read it; storing `calendar_version_id` with each row is what keeps past counts explainable when a corrected calendar is loaded later. Overlap uses the same inclusive rule as `rangesOverlap`.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests that need the 5.1/5.2 migrations, which may fail only with schema-missing errors (42P01, PGRST205, PGRST202, 42703, PGRST204)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass except specs needing the new schema, failing only on schema-missing errors

## Auto Run Result

Status: done (needs migrations 20261017000000_holiday_calendars.sql from Story 5.1 / PR #46, then 20261018000000_leave_records.sql; both ADDITIVE; then `npm run db:seed` for the provisional calendar)

**Summary:** `leave_records` table with RLS (own / subtree manager / admin, insert + select only), a guard trigger (author/timestamps, latest calendar version, DB recount of working days and category band, year range, per-employee advisory-locked overlap backstop, no delete/truncate); `leaveStore.record/listFor`; `recordLeaveAction`; `Employee.leave` filled by employees-store; `LeavePanel` in the Staff portal / "My record" and on the profile Attendance tab.

**Files:** `supabase/migrations/20261018000000_leave_records.sql`, `src/server/leave-store.ts`, `src/server/leave-actions.ts`, `src/components/leave-panel.tsx`, `src/components/staff-attendance.tsx`, `src/components/portal.tsx`, `src/data/employees.ts`, `src/server/employees-store.ts`, `src/app/styles.css`; tests `tests/leave-{store,actions,rls}.test.ts`, `tests/components/leave-panel.test.tsx`, `tests/e2e/leave.spec.ts` and wiring cases in employees-store / portal / staff-attendance tests.

**Review:** 8 patches (1 medium, 7 low), 3 deferred (1 medium, 2 low), the rest rejected with reasons in the triage log.

**Follow-up review recommended:** true -- the DB recount/category/latest-version checks were added in review and no SQL has run against Postgres; `tests/leave-rls.test.ts` is the check once both migrations are applied.

**Verification:** typecheck clean; build succeeds; `npx vitest run` 2063 passed, 9 failed, all schema-missing: holiday-calendar-rls (PGRST205/PGRST202), leave-rls (setup PGRST205), assessments-rls and manager-scope-rls ("Employee records are temporarily unavailable" wrapping PGRST205 on `leave_records`, because profile reads now include leave). e2e: 8 passed, 32 failed -- every admin/staff page read now includes leave, so pages show "Employee records are unavailable"; the server log shows 62 × PGRST205 `public.leave_records` and 1 × `public.holiday_calendar_versions`, nothing else.

**Residual risks:** none of the SQL has run against Postgres; the app's employee pages fail until the leave migration is applied (apply both migrations before merging).
