---
title: 'Story 5.4: Attendance views use real data'
type: 'feature'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '8bc6e3b9106c1ab5964e07d2e45d00c84433e274'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-3-edit-cancel-leave.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The profile Attendance tab and the org-wide "Attendance & leave" view show fixture numbers (`Employee.attendance` from `src/data/employees.ts`, "1–20 September 2026"), not the real attendance entries (Story 1.5), leave records (5.2/5.3) and holiday calendar (5.1).

**Approach:** A pure domain function computes one employee's summary for a period from attendance dates, non-cancelled leave and the `CalendarPolicy`. A server module loads the active calendar and the in-scope attendance entries for the period (new session-scoped, date-windowed read on `attendanceStore`) and builds per-employee summaries; the page passes them to `Portal`, which renders them in place of the fixture. `Employee.attendance` and its fixture are removed.

## Boundaries & Constraints

**Always:**
- Reporting period: the current calendar month to date in Asia/Dhaka (`from` = 1st of this month, `to` = today), labelled e.g. "1–17 October 2026" (the existing UI already reports one month; future days cannot have records, so the month is capped at today).
- Per scheduled day (Mon–Fri, not a calendar holiday, within the period): an attendance entry that day → worked; else a non-cancelled leave period covering it → leave; else → missing record. `scheduled` = scheduled days; `leave` = scheduled days classified leave; `missing` = `scheduled − (scheduled days with an entry) − leave` (the difference). `worked` = attendance entries dated within the period (all of them, weekend/holiday entries included: "worked days from attendance records").
- Cancelled leave is never counted. Leave rows in the exceptions table show the category text label next to its colour (reuse the leave-panel's category display / `categoryForWorkingDays`).
- Scope: Administrator all non-archived employees; manager their subtree (the employees the portal already lists); attendance read via the session (RLS + store scope), never service role.
- No calendar loaded → the summary areas say "No holiday calendar is loaded yet, so scheduled days can't be counted." (no numbers). Period year outside the calendar → "The holiday calendar doesn't cover {year} yet." Attendance read failure → the existing "Attendance is unavailable" page alert behaviour.
- Nothing in either summary reads `src/data/employees.ts`.

**Never:** No new tables or migrations. No period picker. No change to Staff self-service or activity exports. No reimplementing working-day rules outside a domain helper that reuses `CalendarPolicy` (`countWorkingDays` throws on zero days, so a non-throwing per-day helper in the same domain is allowed).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Plain month | today Thu 2026-03-05, no holidays, entries 03-02, 03-03 | scheduled 4, worked 2, leave 0, missing 2 (03-04, 03-05) | — |
| Holiday excluded | today 2026-03-27, 03-26 holiday | 03-26 not scheduled; weekends not scheduled | — |
| Leave | active leave 03-04..03-05, no entries those days | leave 2, missing 0 for those days | — |
| Cancelled leave | same leave cancelled | leave 0, those days missing | — |
| Entry on leave day | entry 03-04 + leave covering 03-04 | worked (not leave) | — |
| Weekend entry | entry Sat 03-07 | worked +1, scheduled unchanged | — |
| First days all weekend | today Sun 2026-11-01 | scheduled 0, all zeros | no throw |
| No calendar | none loaded | message, no numbers | — |
| Year not covered | today 2027-01-05, calendar 2026 | "doesn't cover 2027 yet" | — |
| Manager | subtree only | other employees' entries never read | — |

</intent-contract>

## Code Map

- `src/data/employees.ts:112,309` -- remove `attendance` from `Employee` and the fixture.
- `src/server/employees-store.ts:34-37,239-251,288` -- `NestedProfile`/`emptyProfile`/`nestedFor` exist only for `attendance`; remove them and the header note.
- `src/server/attendance-store.ts` -- `mayRead` (:112-121) scoping, `list()` (:93-109) with `readAllPages`. Add `listInPeriod(session, { from, to }, employeeIds?)`: admin all / manager subtree ids (from `scope.forManager`) / staff own; `.gte/.lte("work_date")`; paged; filtered to scope (defence in depth). Leave `listAll` (used by `src/server/activity-export.ts:271`) unchanged.
- `src/domain/leave.ts` -- `CalendarPolicy` (:17-21), `categoryForWorkingDays` (:107); `countWorkingDays` throws on zero days (:96-101) — don't use it for scheduled days.
- `src/domain/dates.ts:55` `todayInDhaka`; `formatDisplayDate`.
- New `src/domain/attendance-summary.ts` -- `monthToDate(today)`, `summariseAttendance({ period, policy, entryDates, leave })` → `{ scheduled, worked, leave, missing, exceptions: { date, kind: "leave" | "missing", leave?: LeaveRecord }[] }`; throws a typed error for a year outside the policy.
- New `src/server/attendance-summary.ts` -- `attendanceSummariesFor(session, employees, today)` → `{ period, byEmployee } | { unavailable: "no-calendar" } | { unavailable: "year", year }`; uses `holidayCalendarStore.active(session)` and `attendanceStore.listInPeriod`; injectable deps for tests.
- `src/app/page.tsx:50-54` (admin) and the manager branch -- load summaries alongside employees; pass `attendance` prop to `Portal`. `AttendanceUnavailableError` → existing alert path.
- `src/components/portal.tsx:171,213,217,225,227` -- replace every `e.attendance` read; period label from the summary; exceptions table rows from `exceptions` (leave rows with label + colour swatch); radar shows real missing total.
- `src/components/leave-panel.tsx:28-31` -- category display to reuse (export it).
- Tests: `tests/attendance-summary.test.ts` (domain, every matrix row), `tests/attendance-summary-server.test.ts`, `tests/attendance-store.test.ts` (listInPeriod scoping/filters/paging), `tests/components/portal.test.tsx` (:230, :1312-1314, :1690-1700 use the fixture; update), `tests/page.test.tsx` (mocks), `tests/attendance-rls.test.ts` (live listInPeriod: admin/manager/staff scope; sign in once per file). e2e: extend `tests/e2e/portal.spec.ts` lightly (Attendance & leave shows the current-month label).
- Live-test rules: sign each test user in once per file and reuse the session; bulk inserts pass `{ defaultToNull: false }`; never print secret env values. The 5.1/5.2 tables are not applied to the shared DB yet, so tests touching them fail with PGRST205 until a human applies those migrations.

## Tasks & Acceptance

**Execution:**
- `src/domain/attendance-summary.ts` + test -- pure computation per the Always rules.
- `src/server/attendance-store.ts` + test -- `listInPeriod`.
- `src/server/attendance-summary.ts` + test -- assemble per-employee summaries.
- `src/data/employees.ts`, `src/server/employees-store.ts` -- remove fixture attendance.
- `src/app/page.tsx`, `src/components/portal.tsx`, `src/components/leave-panel.tsx` -- wire and render; update affected tests.

**Acceptance Criteria:**
- Given attendance entries, leave records and the calendar, when the profile Attendance tab or the Attendance & leave view is opened, then scheduled, worked, leave and missing-record days for the current month to date are computed from them, and nothing comes from `src/data/employees.ts`.
- Given a cancelled leave record, when totals are calculated, then it is not counted.
- Given a leave category is shown, when displayed, then it has a text label as well as its colour.

## Spec Change Log

## Design Notes

Join-date capping is not applied (`Employee.joined` is free text); an employee who joined mid-month shows earlier days as missing. Days are classified worked > leave > missing so a day with an entry is never double-counted.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests needing the 5.1–5.3 migrations (PGRST205 / schema-missing only)
- `npm run build` -- expected: success
- `npm run test:e2e` (`PLAYWRIGHT_CHANNEL=chromium` in this sandbox) -- expected: failures only from schema-missing errors
