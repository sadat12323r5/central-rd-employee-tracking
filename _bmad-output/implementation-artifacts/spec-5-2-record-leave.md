---
title: 'Story 5.2: Record a leave period'
type: 'feature'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '22d0ec89e6a52e27065552eee32fcd3f0f7ce8b4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-1-holiday-calendar.md'
warnings: ['oversized']
deferred: []
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

## Review Triage Log

## Design Notes

Continuity from 5.1: the active calendar is the highest version and every signed-in role can read it; storing `calendar_version_id` with each row is what keeps past counts explainable when a corrected calendar is loaded later. Overlap uses the same inclusive rule as `rangesOverlap`.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests that need the 5.1/5.2 migrations, which may fail only with schema-missing errors (42P01, PGRST205, PGRST202, 42703, PGRST204)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass except specs needing the new schema, failing only on schema-missing errors
