---
title: 'Story 8.4: Exports include assignments, evaluations and leave'
type: 'feature'
created: '2026-10-17'
status: 'done'
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

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 24 findings — high 0, medium 0, low 20, false 4, maybe-false 0 (plus descriptive intent rows)
- findings:
  - `[low]` `[patch]` (gap) BOM test named "never doubling" only feeds a BOM-less CSV — assertion of exactly one BOM added.
  - `[low]` `[reject]` (blind) "All time" can end in the future (planned leave, future-start assignment) — the spec includes leave end and assignment dates in the span; planned leave is a real record to export. The custom period's no-future rule applies to user-entered periods only.
  - `[low]` `[patch]` (blind) Future-start open assignment: inverted range, inconsistent inclusion while still stretching the span — the open range now ends at max(start, today); tested.
  - `[low]` `[reject]` (blind) Evaluation dated by creation but credited to the latest author — status "Amended" marks it; the outcome text shown is the latest author's, so naming them is accurate.
  - `[low]` `[reject]` (blind) Leave category recomputed instead of read — the 5.2 trigger guarantees the stored category matches the count, so both give the same label.
  - `[low]` `[reject]` (blind) Client-feedback guard is always true for current exporters — intended (spec Design Notes): it keeps the rule if export access widens; the off path is tested at the domain.
  - `[low]` `[reject]` (blind) Bulk reads everything visible (archived included) before the empty-scope refusal — every read is RLS and store scoped, paged; cost only, at current sizes negligible.
  - `[low]` `[reject]` (blind) Closed assignment with no completion date reads as open — closing requires a completion date (Story 4.5 store and RLS); unreachable data.
  - `[low]` `[reject]` (blind) BOM restored client-side hides a transport issue; other consumers get no BOM — the panel is the only consumer of these actions; e2e checks the header after stripping exactly 3 BOM bytes.
  - `[low]` `[reject]` (blind) e2e fixed fixture collides between parallel runs — CI is serialised on the shared database (PR #49) and Playwright runs with one worker.
  - `[low]` `[reject]` (blind) e2e cleanup ignores errors; dates fixed to 2026 — matches the leave/backfill spec patterns; the only calendar covers 2026 and the spec fails loudly if that changes.
  - `[low]` `[reject]` (blind) Missing edge tests (includeArchived bulk, foreign evaluation, boundary, inverted stored ranges) — boundary inclusion is tested; the rest are unreachable or covered by existing archived handling.
  - `[low]` `[reject]` (blind) Free text joined into details with "; " — same format as interview rows since 8.1; cells are guarded.
  - `[low]` `[reject]` (blind) Linear find per evaluation, import order, long doc paragraph — cosmetic.
  - `[low]` `[patch]` (edge) Future-start open assignment included wrongly — duplicate of the range row, same patch.
  - `[low]` `[reject]` (edge) All-time future end — duplicate of the span row.
  - `[false]` `[reject]` (edge) Leave details print NaN/0 working days — working_days > 0 is a DB check constraint and the trigger recounts it.
  - `[low]` `[reject]` (edge) Several evaluations without a visible assignment share the title "Evaluation" — their dates and details differ; rare (assignment visibility matches evaluation visibility).
  - `[false]` `[reject]` (edge) e2e leave over holidays could have 0 working days — the seeded period is fixed and contains working days; the insert would be refused loudly, not silently.
  - `[false]` `[reject]` (edge) Duplicate "E2E Activity Export" departments break maybeSingle — department names are unique case-insensitively in the database.
  - `[false]` `[reject]` (edge) Highest calendar version may not be the active one — by design the active version is the highest (Story 5.1).
  - `[low]` `[reject]` (edge) e2e cleanup errors unchecked — duplicate of the cleanup row.
  - `[low]` `[reject]` (edge claim) Span change violates "period validation unchanged" — duplicate of the span row; validation of user input is unchanged.
  - `[low]` `[patch]` (edge claim) Future open assignment overlap — duplicate of the range row.
  - intent rows (A1 backfilled as assignment rows without role/start; A3(a) open runs to today; B1 createdAt, B2 latest author, B3 reading (i); C1 length category; e2e as manager only; BOM fix beyond story text) — descriptive, no action.

## Design Notes

Spanning records are dated by their start (not clamped) so a row always shows the record's own date; inclusion uses the full range. "Leave type" maps to the length category, the only classification leave has (no reasons/types by PRD §5). The client-feedback gate is coded on the exporter's role so it holds if export access ever widens.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except the 7 Story 5.3 live cases needing the unapplied leave update policy
- `npm run build` -- expected: success
- `npm run test:e2e` (`PLAYWRIGHT_CHANNEL=chromium`) -- expected: pass except `leave.spec` at its edit step (needs the 5.3 policy)

## Auto Run Result

Status: done

**Summary:** Activity exports (single, bulk, manager-scoped) now include `assignment` rows (tracked assignments overlapping the period, plus backfilled past projects marked by provenance), `evaluation` rows (evaluator, outcome, and client feedback for Administrator/manager exporters), and `leave` rows (length category as the type, dates, working-day count, Recorded/Cancelled). Every new source is read through its own session-scoped store, and the export stays all-or-nothing.

**Files changed:**
- `src/domain/activity.ts` -- new types and sources, row builders, range-aware inclusion, span with `today`.
- `src/server/activity-export.ts`, `src/server/activity-actions.ts` -- the four stores read in single and bulk exports; Unavailable errors mapped; client-feedback rule.
- `src/components/activity-export-panel.tsx` -- restores a missing UTF-8 BOM on save (larger exports lost it in transit; found by e2e).
- `docs/ARCHITECTURE.md` -- export section.
- Tests: `tests/activity.test.ts`, `tests/activity-export.test.ts`, `tests/components/activity-export-panel.test.tsx`, `tests/e2e/activity-export.spec.ts` (manager export with seeded assignment, evaluation and leave on fixed subject BS-9193).

**Review:** 24 findings (0 high, 0 medium, 20 low, 4 false).
- Patched: the future-start open-assignment range, and the BOM test.
- Deferred: none beyond the notes in deferred-work.md.
- Rejected: everything else, with reasons in the triage log.

**Follow-up review recommended:** false (patched: high 0, medium 0, low 2 entries).

**Verification:**
- `npm run typecheck` and `npm run build`: pass.
- `npm test`: 2166 passed, 7 failed. All 7 are Story 5.3 live cases needing the unapplied `20261019000000_leave_records_update.sql`.
- e2e:
  - The full suite (before the review patch, which touched only domain code covered by unit tests) had 39 passed and 1 failed.
  - After the patch, `activity-export.spec.ts` (3 tests) passes.
  - `leave.spec.ts` fails only at its edit step ("Leave updated…" not shown), because it needs the same policy.

**Residual risks:**
- Bulk exports read all visible records of the four sources before filtering.
- The e2e fixed subject accumulates rows across runs.
- Client feedback is shown to every current exporter, by design.
