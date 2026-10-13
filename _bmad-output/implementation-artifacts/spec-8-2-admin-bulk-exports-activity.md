---
title: 'Story 8.2: Administrator bulk-exports every employee''s activity'
type: 'feature'
created: '2026-10-13'
status: 'in-progress'
baseline_revision: '132b1ce6472a700a20ea72c6bcae1375e828db32'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-1-admin-downloads-activity-timeline.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 8.1 exports one employee at a time. The L&D manager also needs one CSV covering every employee for a period. Today's store list reads are single PostgREST requests capped at `max_rows = 1000`, so a large export would be silently truncated (deferred from 8.1).

**Approach:** Add a "Download activity (all employees)" panel to the directory, with the same period picker as 8.1 plus an "Include archived" checkbox. An Administrator-only server action reuses the 8.1 pipeline (period resolution, row building, CSV, all-or-nothing) for every employee in scope. It writes one audit row with target `all-employees` (or `all-employees+archived`). Every store list read that the export uses pages through PostgREST with `.range()` until a short page.

## Boundaries & Constraints

**Always:**
- Same columns, BOM, quoting and injection guard as 8.1 (reuse `timelineCsv`). Rows are sorted by employee id, then within an employee exactly as 8.1 (date, time, type, title).
- Archived employees (`archived: true` from `employeesStore.listFor`) and all of their rows are excluded unless `includeArchived` is `on`.
- Periods and validation are identical to 8.1. For `all`, the span runs from the first to the last record date across the included employees. With no records it is today to today, header only.
- Filename: `activity-all-employees-<from>_to_<to>.csv`.
- Sources are read only through stores, each once for the whole export:
  - `employeesStore.listFor(session)` gives employees with their stored interviews and training.
  - `attendanceStore.listAll()` gives attendance.
  - `trainingStore.currentFor(session, includedIds)` gives LMS enrolments; freshness is per employee.
- Paging: `attendance-store` `list()`, `interviews-store` `listFor`, `training-store` `listFor` and `employees-store` `listFor` (the employees query) fetch pages of 1000 with `.range(from, from + 999)` until a page shorter than 1000 rows. Each query has a total order (add `id` as the final tiebreak where missing). Any page error throws the store's existing unavailable error.
- Audit: one row via a new `record_bulk_activity_export(p_actor uuid, p_include_archived boolean, p_from date, p_to date)`. It inserts action `export_activity`, target `all-employees` or `all-employees+archived`, and the period. It is executable by service_role only. The migration is ADDITIVE (new function only).
- The admin session is checked first and the form is validated with zod. Any unavailable source, the LMS or the audit write fails the whole export, with the same message as 8.1.

**Never:**
- No Department Manager scope (8.3) and no assignment/evaluation/leave rows (8.4).
- No change to the 8.1 single-employee behaviour, its migration file, or its messages.
- No Staff path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Admin, `month` 2026-09, 2 active + 1 archived employee | Rows of the 2 active employees only, ordered by employee id then date. File `activity-all-employees-2026-09-01_to_2026-09-30.csv`. One audit row with target `all-employees` | None |
| Include archived | Same, `includeArchived=on` | The archived employee's rows are included. Audit target is `all-employees+archived` | None |
| All time | Records 2025-01-03..2026-10-10 across included employees | from/to are those dates. An archived-only earlier date is ignored unless included | No records: today_to_today, header only |
| Paging | A store returns 1000 rows, then 1000, then 3 | All 2003 rows are used; three requests with ranges 0-999, 1000-1999 and 2000-2999 | A page error throws the unavailable error |
| Bad custom range | to < from, or to > today | No CSV, no audit | Inline validation message |
| Source down | Any store or the LMS is unavailable, or the audit fails | No CSV | 8.1 unavailable message |
| Staff / no session | Calls the action directly | No reads, no CSV | "Only an Administrator can export activity." |

</intent-contract>

## Code Map

- `src/domain/activity.ts` -- reuse `resolvePeriod`, `recordSpan`, `buildTimeline`, `timelineCsv`, `ActivitySources`. Add `activityBulkFilename(period)`.
- `src/server/activity-export.ts` -- the 8.1 pipeline: `parseInput` (employeeId required), `isUnavailable`, error classes and messages. Add `exportAllActivity(deps, session, actorId, input, now)` and share the period parsing (employeeId not required).
- `src/server/activity-actions.ts` -- add `exportAllActivityAction`. It uses the same admin check, and `createAuditStore(getServiceClient)`.
- `src/server/audit-store.ts` -- add `recordBulkActivityExport({actorId, includeArchived, from, to})`.
- `src/server/attendance-store.ts:79` (`list`), `src/server/interviews-store.ts` (`listFor`), `src/server/training-store.ts` (`listFor`), `src/server/employees-store.ts` (`listFor` rows query) -- single requests today; add paging.
- `src/server/employees-store.ts` -- `Employee.archived` (admin reads), `Employee.interviews` (no employeeId, same shape as store minus employeeId), `Employee.training` (stored history entries).
- `src/components/activity-export-panel.tsx` -- the 8.1 panel. Make it serve both modes: with `employeeId` it is the single export; without it, the bulk export with heading "Download activity (all employees)" and an "Include archived" checkbox.
- `src/components/portal.tsx` -- the directory section (`section === "Employees"`) where the bulk panel goes, below the directory panel.
- `supabase/migrations/20261013000000_activity_export_audit.sql` -- the 8.1 audit columns and check (read-only here).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261013010000_bulk_activity_export_audit.sql` -- the new function above, with `invalid_period` for a null or reversed period. ADDITIVE.
- `src/server/attendance-store.ts`, `src/server/interviews-store.ts`, `src/server/training-store.ts`, `src/server/employees-store.ts` -- page the list reads, as described under Boundaries.
- `src/server/audit-store.ts` -- `recordBulkActivityExport`, validated with zod.
- `src/domain/activity.ts` -- `activityBulkFilename`.
- `src/server/activity-export.ts` -- `exportAllActivity`:
  - validate, then read the four stores in parallel, all or nothing;
  - filter archived employees;
  - build each employee's `ActivitySources`;
  - resolve the period (`all` spans all included sources);
  - concatenate the per-employee timelines in employee-id order;
  - write the audit row, then return the CSV and filename.
- `src/server/activity-actions.ts` -- `exportAllActivityAction`.
- `src/components/activity-export-panel.tsx`, `src/components/portal.tsx` -- the bulk mode, rendered in the Employees section.
- Tests:
  - `tests/activity-export.test.ts` and `tests/audit-store.test.ts`: bulk cases (every matrix row).
  - `tests/attendance-store.test.ts`, `tests/interviews-store.test.ts`, `tests/training-store.test.ts`, `tests/employees-store.test.ts`: paging cases (1000+1000+3, and an error on page 2).
  - `tests/components/activity-export-panel.test.tsx`: the bulk mode.
  - A live `record_bulk_activity_export` block in `tests/audit-store.test.ts`, skip-if-unconfigured.
- `tests/e2e/activity-export.spec.ts` -- add a bulk "Last week" download. It asserts the filename, BOM and header, or the same migration fail-fast message as 8.1.

**Acceptance Criteria:**
- Given a signed-in Administrator on the directory, when they choose "Download activity (all employees)" and a period, then they receive one timeline CSV with 8.1's columns covering every active employee, sorted by employee then date.
- Given a successful bulk export, when it completes, then exactly one `audit_events` row exists with the actor, target `all-employees` or `all-employees+archived`, and the period.
- Given more than 1000 rows in any source, when the export runs, then every row is included (no single capped query).

## Design Notes

- Interviews and stored training come from the employees returned by `employeesStore.listFor` (it already reads both stores once for everyone), so no source is read twice.
- Paging helper: one small `readAllPages` function per store module is acceptable, or a shared `src/server/paging.ts` used by all four. Keep each store's error mapping unchanged.

## Verification

**Commands:**
- `npm run check` -- typecheck, unit tests and build pass. The live audit tests may fail only with schema-missing codes (PGRST202/42703) until the 8.1 and 8.2 migrations are applied.
- `npm run test:e2e` -- passes, or the export specs fail only with the unavailable message caused by the missing migrations.
