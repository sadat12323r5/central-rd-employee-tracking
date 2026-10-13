---
title: 'Story 8.1: Administrator downloads one employee''s activity timeline'
type: 'feature'
created: '2026-10-13'
status: 'done'
baseline_revision: '2cbe98983ac7382276527cf80f74045aed43361c'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
warnings: [oversized]
deferred:
  - summary: >-
      Activity export reads each source in one PostgREST request, so more than 1000 rows (max_rows) for one employee would be silently truncated.
    evidence: |-
      attendance-store list(), interviews-store listFor and training-store listFor issue a single select with no .range() paging; supabase/config.toml max_rows = 1000. Pre-existing store behaviour (the profile views share it); an employee reaches 1000 attendance days after roughly 4 years. Story 8.2 (bulk) must page through the stores per the epic; fix the stores there.
    location: >-
      src/server/attendance-store.ts:79
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The L&D manager cannot take an employee's recorded activity (attendance, interviews, training, LMS enrolments) offline for a chosen period; each lives in its own tab and store.

**Approach:** A "Download activity" panel on the Administrator's employee profile calls an Administrator-only server action. The action resolves the period in Asia/Dhaka, reads every source through its existing store, builds a sorted timeline CSV in pure domain code, writes one `audit_events` row, and returns the CSV for the browser to save.

## Boundaries & Constraints

**Always:**
- Columns, in order: `employee_id, employee_name, date, type, title, details, status`. UTF-8 with BOM. Every field is quoted with `toCsv`. A cell starting with `=`, `+`, `-` or `@` gets a leading `'`.
- Rows are sorted by date, then time (attendance clock-in in Dhaka, `HH:mm`; other types have no time and sort first), then type, then title.
- Filename: `activity-<employeeId>-<from>_to_<to>.csv` (inclusive calendar dates).
- Periods: `this-week` and `last-week` (Monday to Sunday), `month` (month + year), `year`, `custom` (inclusive from/to), `all`. "Today" is the Asia/Dhaka date of the server clock. `all` spans the employee's first to last record date. With no records it spans today to today.
- Sources are read only through `attendanceStore.listForEmployee`, `interviewsStore.listFor`, `trainingStore.listFor` and `trainingStore.currentFor`, with the Administrator's session. The employee comes from `employeesStore.getFor`.
- The admin session is checked first, and the form is validated with zod.
- The audit row is written after every source has been read. If the audit write fails, nothing is downloaded.

**Never:**
- No direct table reads for any source, and no fixture reads for activity data.
- No partial CSV. If any source fails (any `*UnavailableError`, or `currentFor` returning `unavailable`), the whole export fails.
- No Department Manager or bulk export (8.2/8.3), and no assignment/evaluation/leave rows (8.4).
- No Staff path. Staff sessions are rejected at the server.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Admin, BS-1001, `month` 2026-09 | CSV with rows of all four types dated 2026-09-01..30, filename `activity-BS-1001-2026-09-01_to_2026-09-30.csv`, one audit row | None |
| This week | today 2026-10-14 (Wed) | from 2026-10-12 to 2026-10-18 | None |
| Last week | today 2026-10-12 (Mon) | from 2026-10-05 to 2026-10-11 | None |
| Empty period | no records in range | BOM + header row only, still audited | None |
| All time | records 2025-03-02..2026-10-10 | from/to are those dates | none → today_to_today, header only |
| Bad custom range | to < from, or to > today, or a non-date | No CSV, no audit | Inline validation message |
| Source down | any store throws unavailable / LMS unavailable | No CSV, no audit | "Activity could not be exported because a record source is unavailable. Nothing was downloaded. Please try again." |
| Audit fails | audit write rejects | No CSV | Same unavailable message |
| Staff / no session | calls the action directly | No CSV, no reads | "Only an Administrator can export activity." |
| Unknown employee | getFor returns null | No CSV | "Choose an existing employee." |
| Injection | interview company `=HYPERLINK(..)` | cell `'=HYPERLINK(..)` | None |

</intent-contract>

## Code Map

- `src/domain/csv.ts` -- `toCsv` quoting (reuse). Add `guardCell` (injection prefix) and `CSV_BOM`.
- `src/domain/dates.ts` -- `isCalendarDate`. `src/domain/timesheet.ts:61` `dhakaDate(instant)` for today and Dhaka clock-in time (UTC+6 fixed).
- `src/server/attendance-store.ts` -- `listForEmployee(id)` returns `TimesheetEntry[]` (date, clockIn/out ISO, breakMinutes, workMode, log{summary,tasks,blockers}). Throws `AttendanceUnavailableError`.
- `src/server/interviews-store.ts` -- `listFor({role:"admin"}, id)` returns `ExternalInterview[]` (company, role, date, stage, outcome, feedback, withdrawn). Throws `InterviewsUnavailableError`.
- `src/server/training-store.ts` -- `listFor` returns stored completed `TrainingEntry[]` (date = completed). `currentFor` returns `{status:"ok", inProgress, lmsCompleted, freshness}` or `{status:"unavailable"}`. Both in-progress and LMS-completed entries are LMS enrolments (Story 3.2). Throws `TrainingUnavailableError`.
- `src/server/employees-store.ts` -- `getFor(session, id)` returns the Employee (name) or null. Throws `EmployeesUnavailableError`.
- `src/server/account-actions.ts` -- pattern for admin-checked actions using `getActor()` (`actor.userId` = audit actor) and `ActionState`.
- `src/server/accounts-store.ts:209` -- pattern for a service-role rpc with a typed unavailable error.
- `supabase/migrations/20261008000000_archive_and_audit.sql` -- `audit_events(actor, target, action check in ('archive','restore'))`, append-only, RLS on with no policies.
- `src/components/account-access-panel.tsx` -- client panel pattern (`useActionState`, `role="status"`/`role="alert"`). `src/components/portal.tsx:142` is the Overview tab where profile panels are rendered.
- `tests/e2e/archive-account.spec.ts` and `tests/e2e/admin.ts` -- e2e patterns for an Administrator on a throwaway profile.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261013000000_activity_export_audit.sql` -- adds nullable `period_from date` and `period_to date` to `audit_events`. Replaces the `action` check with one that also allows `'export_activity'` (widening only). Adds a `record_activity_export(p_actor uuid, p_employee_id text, p_from date, p_to date)` function: security invoker, inserts one row, `employee_not_found` (P0001) for an unknown id, execute granted to service_role only. Classification: DESTRUCTIVE (an existing constraint is replaced, though only widened).
- `src/domain/csv.ts` -- add `CSV_BOM` and `guardCell`. Keep `toCsv` unchanged.
- `src/domain/activity.ts` -- new, pure. `resolvePeriod(input, today)` returns `{from,to}` or throws `ActivityPeriodError`. `buildTimeline(employee, sources, period)` returns sorted, in-range rows. `timelineCsv(rows)` returns BOM + header + guarded rows. `activityFilename(id, period)`. `recordSpan(sources)` for `all`.
- `src/server/audit-store.ts` -- new. `createAuditStore(getServiceClient).recordActivityExport({actorId, employeeId, from, to})` via the rpc. Throws `AuditUnavailableError`.
- `src/server/activity-export.ts` -- new, not a `"use server"` module. `exportActivity(deps, session, actorId, input, now)`: validates the input (zod), gets the employee, reads the 4 sources in parallel, fails as a whole, resolves `all`, builds the CSV, records the audit, then returns `{csv, filename}`. Typed errors map to messages.
- `src/server/activity-actions.ts` -- new `"use server"` `exportActivityAction(prev, form)`. Admin check via `getActor()` first, then delegates. Returns `ActionState & {csv?, filename?}`.
- `src/components/activity-export-panel.tsx` -- new client panel "Download activity": a period select, month/year/custom date inputs, and a Download button. On success it saves a Blob and shows the status "Downloaded <filename>." Errors are shown inline with `role="alert"`.
- `src/components/portal.tsx` -- render `<ActivityExportPanel>` in the Overview tab of an Administrator's profile.
- `tests/activity.test.ts`, `tests/activity-export.test.ts`, `tests/audit-store.test.ts`, `tests/components/activity-export-panel.test.tsx`, and additions to `tests/csv.test.ts` -- cover every matrix row. A live audit test runs with `describe.skipIf(!configured)`.
- `tests/e2e/activity-export.spec.ts` -- the Administrator downloads a throwaway employee's "All time" CSV. The test asserts the filename and header and that the BOM is present.

**Acceptance Criteria:**
- Given a signed-in Administrator on an employee's profile, when they choose a period and press "Download activity", then the browser saves `activity-<id>-<from>_to_<to>.csv` with one row per event in that inclusive period.
- Given a successful export, when it completes, then exactly one `audit_events` row exists with the actor, `target` = employee id, `action` = `export_activity`, and the period.
- Given any validation, authorization or availability failure, when the action returns, then no CSV is returned and no audit row is written (except an audit failure itself, which leaves no row).

## Design Notes

- Enrolment rows use the date the views show: the target date while in progress, the completion date once completed. Their status is `In progress` or the LMS result. When the LMS data is stale, details end with `LMS data as of <D MMM YYYY> (may be out of date)`. LMS-completed courses are `enrolment` rows. `training` is only stored history (3.1).
- Attendance row: title `Attendance`. Details are `Clock in HH:mm, clock out HH:mm (or "not recorded"), break N min, <mode>`, plus `; log: <summary>` when a log exists. Status comes from `entryStatus`.
- Interview row: title `<company> — <role>`, details `Stage: <stage>` plus `; feedback: <feedback>`, status `Withdrawn` or the outcome (or `Reported`).
- The action returns the CSV text (not a route handler), so validation and "unavailable" messages render inline on the profile without navigation.

## Verification

**Commands:**
- `npm run check` -- typecheck, unit tests and build pass. Live tests that need the new migration may fail only with schema-missing codes (PGRST202/42703/23514).
- `npm run test:e2e` -- passes, or the export spec fails only with a schema-missing audit error until the migration is applied.

## Auto Run Result

Status: done

**Summary:** Administrators get a "Download activity" panel on the employee profile (Overview). It exports one employee's attendance, interviews, completed training and LMS enrolments for this week, last week, a month, a year, a custom range or all time, as a BOM-prefixed, quoted, injection-guarded timeline CSV named `activity-<id>-<from>_to_<to>.csv`. Each successful export writes one `audit_events` row (`export_activity`, actor, employee, period) through a new service-role-only function. Any failing source, the LMS or the audit write fails the whole export with an inline "unavailable" message.

**Files changed:**
- `supabase/migrations/20261013000000_activity_export_audit.sql` -- DESTRUCTIVE (replaces and widens the `audit_events.action` check). Adds nullable period columns, a period check and `record_activity_export`.
- `src/domain/activity.ts` -- period resolution, record span, timeline rows, CSV and filename (pure).
- `src/domain/csv.ts` -- `CSV_BOM` and `guardCell`.
- `src/server/audit-store.ts` -- audit write via the rpc, with typed errors.
- `src/server/activity-export.ts` -- the export pipeline: validation, reads through the stores, all-or-nothing, audit last.
- `src/server/activity-actions.ts` -- admin-checked server action.
- `src/components/activity-export-panel.tsx`, `src/components/portal.tsx` -- the profile panel.
- `src/server/supabase.ts` -- comment only. `tests/no-registration.test.ts` -- allows the new service-role caller.
- Tests: `tests/activity.test.ts`, `tests/activity-export.test.ts`, `tests/audit-store.test.ts` (with a live block), `tests/components/activity-export-panel.test.tsx`, `tests/csv.test.ts`, `tests/components/portal.test.tsx`, `tests/e2e/activity-export.spec.ts`.

**Review:** 28 findings. 7 entries patched (all low): period check, download anchor/revoke, tab/CR guard, e2e race catch, stale-LMS export test. 1 entry deferred (medium): the PostgREST max_rows truncation in the store reads. 13 rejected with reasons (see the triage log).

**Follow-up review recommended:** false (patched: high 0, medium 0, low 7).

**Verification:**
- `npm run typecheck` clean.
- `npx vitest run`: 746/748 pass. The 2 failures are live tests in `tests/audit-store.test.ts` that need the new migration: "column audit_events.period_from does not exist" (42703), and the rpc is missing.
- `npm run build` passes.
- `npx playwright test`: 19/20 pass (run against the preinstalled chromium-1194 via a temporary config). `activity-export.spec.ts` fails only because the audit write is unavailable until the migration is applied; the panel shows "Activity could not be exported because a record source is unavailable…".
- The migration was applied on a throwaway local Postgres 16 by the implementer. The period-check patch was not re-run there.

**Residual risks:** the migration is unapplied in the shared project. Store reads are capped at 1000 rows (deferred). Enrolment rows are dated by target date (in progress) or completion date, so a currently-running enrolment appears only in periods that include its target date.
