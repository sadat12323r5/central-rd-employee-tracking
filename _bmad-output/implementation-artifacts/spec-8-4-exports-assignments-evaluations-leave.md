---
title: 'Story 8.4: Exports include assignments, evaluations and leave'
type: 'feature'
created: '2026-10-17'
status: 'in-progress'
baseline_revision: '1ca750d65cd0ffe52d3170a2639f63d3784b3a83'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-3-manager-activity-export.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The activity export (8.1 single, 8.2 bulk, 8.3 manager-scoped) only carries attendance, interview, training and enrolment rows; assignments (and backfilled past projects), closed-assignment evaluations and leave are missing now that those records exist (Epics 4 and 5).

**Approach:** Extend the existing pipeline (no parallel path): `ActivitySources` gains assignments, backfilled projects, evaluations and leave; `buildTimeline` maps them to `assignment`, `evaluation` and `leave` rows with range-aware period inclusion; the export server reads them through their own session-scoped stores (single: `listFor(session, id)`; bulk: one `listFor(session)` per store, grouped by employee) and keeps exports all-or-nothing.

## Boundaries & Constraints

**Always:**
- CSV header unchanged (`employee_id, employee_name, date, type, title, details, status`); new `type` values `assignment`, `evaluation`, `leave`. Sorting unchanged.
- `assignment` (tracked, `provenance: "assignment"`): date = `startDate`; title `"{projectName} — {client}"`; details `"Role: {role}; start: {startDate}; end: {completionDate or 'open'}; provenance: assignment"`; status `Open` / `Closed`. Included when `[startDate, completionDate ?? today]` overlaps the period (inclusive).
- `assignment` (backfilled, `provenance: "backfilled"`): date = `completionDate`; title `"{projectName} — {client}"`; details `"Self-reported past project; completed: {completionDate}; outcome: {outcome}; provenance: backfilled"` (no role/start exist); status `Self-reported`, or `Withdrawn` when withdrawn (kept, like withdrawn interviews). Included when its completion date is in the period.
- `evaluation`: date = Asia/Dhaka date of `createdAt`; title `"Evaluation — {projectName} ({client})"` (from the assignment it belongs to; `"Evaluation"` if not found); details `"Evaluator: {authorLabel}; outcome: {evaluation}"` plus `"; client feedback: {clientFeedback}"` only when the exporter is an Administrator or a manager (every current exporter) and feedback is non-empty; status `Amended` if amended (updatedAt ≠ createdAt / authoredBy ≠ createdBy as the domain already decides) else `Written`. Included when its date is in the period.
- `leave`: date = `startDate`; title = category label from `categoryForWorkingDays(workingDays)` (the leave "type"); details `"From {startDate} to {endDate}; {n} working day(s)"`; status `Cancelled` when `cancelledAt` set, else `Recorded`. Included when `[startDate, endDate]` touches any day of the period. Cancelled leave included.
- "All time" span (`recordDates`/`recordSpan`, bulk `combinedSpan`) includes every new record's dates (assignment start and end-or-today, backfilled completion, evaluation date, leave start and end).
- Reads go through `assignmentsStore`, `backfilledProjectStore`, `assignmentEvaluationsStore`, `leaveStore` with the user's session (RLS + store scoping); every source re-filtered by employeeId; each store's Unavailable error makes the export fail as unavailable (nothing partial). Manager exports stay subtree-scoped; interviews stay excluded for managers.
- Audit, filenames, period validation unchanged.

**Never:** No new tables or migrations; no service role at runtime; no change to the CSV header; no client feedback for any exporter other than Administrator/manager.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open assignment overlapping | start 2026-09-01, open, period Oct 2026 | row dated 2026-09-01, status Open, details end: open | — |
| Closed before period | 2026-01-01..2026-02-01, period Oct | no row | — |
| Backfilled | completion 2025-06-30, period year 2025 | row, Self-reported, provenance backfilled | — |
| Withdrawn backfilled | same, withdrawn | row, status Withdrawn | — |
| Evaluation | createdAt 2026-10-05T20:00Z (Dhaka 10-06) | dated 2026-10-06, evaluator + outcome (+ feedback for admin/manager) | — |
| Leave touching | 2026-09-29..2026-10-02, period Oct | row dated 2026-09-29, "4 working days" | — |
| Cancelled leave | cancelled, in period | row status Cancelled | — |
| All time | only a leave record in 2026-03 | span covers it | — |
| Store down | any new store throws its Unavailable error | export unavailable, no CSV, no audit | existing message |
| Manager | bulk | only subtree rows of new types; no interviews | — |

</intent-contract>

## Code Map

- `src/domain/activity.ts` -- `ACTIVITY_TYPES` :21, `ActivityRow` :24-29, `ActivitySources` :37-44, `recordDates`/`recordSpan` :130-143, `buildTimeline` :152-179 (single-date filter at :176; add an optional range for filtering only), interview row format :158-162 to mirror.
- `src/domain/evaluations.ts:16-30` -- `authorLabel` / `authorshipText` for the evaluator and amended state.
- `src/domain/leave.ts` -- `categoryForWorkingDays` :107, `rangesOverlap` :127.
- `src/domain/dates.ts` / `src/domain/timesheet.ts:61` `dhakaDate` -- ISO instant → Dhaka date.
- `src/data/employees.ts` -- `Assignment` :8-14, `BackfilledProject` :31-38, `AssignmentEvaluation` :47-51, `LeaveRecord` :21-24.
- `src/server/activity-export.ts` -- deps :32-48, `UNAVAILABLE_ERRORS` :158-161, single `exportActivity` :175-221 (reads :191-197, manager interview skip :194/:203, per-employee filter :202-209), bulk `exportAllActivity` :249-320 (attendance grouping :278-283, embedded sources :291-292), `combinedSpan` :226-233.
- `src/server/activity-actions.ts` :35-38, :65-68 -- wire the four real stores.
- Stores (each `listFor(session, employeeId?)`, admin all / manager subtree / staff own, paged): `src/server/assignments-store.ts:40`, `src/server/backfilled-project-store.ts:43`, `src/server/assignment-evaluations-store.ts:40` (manager sees by assignment department OR employee: re-filter by employee), `src/server/leave-store.ts:45`. Unavailable errors: `AssignmentsUnavailableError`, `BackfillUnavailableError`, `EvaluationsUnavailableError`, `LeaveUnavailableError`.
- Tests: `tests/activity.test.ts` (`empty()` :27; add row tests per matrix row), `tests/activity-export.test.ts` (`fakeDeps` :53-77, `reads` :79, `fakeBulkDeps` :313-351, `bulkReads` :353; action `beforeEach` must `vi.spyOn` the four real stores' `listFor` or they hit the mocked user client), `tests/e2e/activity-export.spec.ts` (manager test :108-174 seeds via `serviceClient()` — add an assignment, an evaluation and a leave row for the throwaway employee and assert the new rows; leave needs an active calendar version id; leave can never be deleted, so cancel it in `finally` and never assume an empty leave list).
- Live-test rules: sign each test user in once per file and reuse the session; bulk inserts pass `{ defaultToNull: false }`; never print secret env values. The 5.3 update policy is not applied to the shared DB, so a user-session leave update fails; e2e cleanup must use the service role.

## Tasks & Acceptance

**Execution:**
- `src/domain/activity.ts` -- new types, sources, row builders, range-aware inclusion, span.
- `src/server/activity-export.ts`, `src/server/activity-actions.ts` -- read and pass the four sources (single + bulk + manager), unavailable mapping.
- Tests: domain (every matrix row), export server (reads, scoping, unavailable per store, feedback rule, manager), actions spies, e2e manager/admin export with seeded records.

**Acceptance Criteria:**
- Given assignments incl. backfilled past projects, when an export covers their dates, then `assignment` rows show project, client, role and start/end (backfilled marked by provenance), and an assignment overlapping the period is included.
- Given closed-assignment evaluations, when an export covers the evaluation date, then `evaluation` rows show the evaluator and outcome summary, with client feedback in `details` only for authorized managers.
- Given recorded leave, when an export covers any day of a leave period, then `leave` rows show the type, dates, working-day count and status, including cancelled.

## Spec Change Log

- 2026-10-17: replaces the 2026-10-16 blocked stub (blocker: Epic 5 leave behind the holiday calendar). Unblocked: the System Owner adopted the provisional calendar and Stories 5.1–5.3 are built (PRs #46–#48).

## Design Notes

Spanning records are dated by their start (not clamped) so a row always shows the record's own date; inclusion uses the full range. "Leave type" maps to the length category, the only classification leave has (no reasons/types by PRD §5). The client-feedback gate is coded on the exporter's role so it holds if export access ever widens.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except the 7 Story 5.3 live cases needing the unapplied leave update policy
- `npm run build` -- expected: success
- `npm run test:e2e` (`PLAYWRIGHT_CHANNEL=chromium`) -- expected: pass except `leave.spec` at its edit step (needs the 5.3 policy)
