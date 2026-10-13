---
title: 'Story 3.1 — Staff views their completed-training history'
type: 'feature'
created: '2026-10-12'
baseline_revision: '44517e1a95279f518a2649e812d68c75aa99e821'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md']
warnings: ['oversized']
deferred:
  - summary: >-
      The db:seed write of completed training (and interviews) is never executed by any test.
    evidence: |-
      Only the pure trainingSeedRows/interviewSeedRows helpers are tested; a wrong table name or dropped ignoreDuplicates would pass. Needs a testable seed function or a CI seed run.
    location: >-
      scripts/seed-employees.ts
    severity: medium
  - summary: >-
      A failed training (or interviews) read makes the whole employee record unavailable, hiding the entire staff page.
    evidence: |-
      employees-store maps TrainingUnavailableError to EmployeesUnavailableError, following the 2.1 interviews choice. Story 3.2's per-section loading/stale/unavailable states are the natural place to decouple.
    location: >-
      src/server/employees-store.ts
    severity: medium
  - summary: >-
      Staff portal privacy copy ("Only you and the L&D Administrator can see them") will be wrong once Story 4.3 adds manager-scoped training RLS.
    evidence: |-
      Epic 3 context: manager-scoped RLS on training is delivered in 4.3.
    location: >-
      src/components/staff-attendance.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Training lives only in the fixture (`src/data/employees.ts`), read by `employees-store`; staff cannot see their own completed training, and nothing enforces that a staff member sees only their own.

**Approach:** An ADDITIVE migration adds a `training_history` table (completed entries only, no department column) with employee-or-admin RLS. A new `training-store` is the single training source: completed entries from the table, in-progress entries still from the fixture until Story 3.2. `employees-store` reads training through it, the staff portal gets a "Completed training" section, and `db:seed` inserts the fixture's completed entries.

## Boundaries & Constraints

**Always:**
- Completed = fixture entries with `progress === 100`; only these are seeded into `training_history`. In-progress entries are never copied into the table; `training-store` serves them from the fixture (scoped exactly like table reads).
- `training_history` columns: `id uuid pk default gen_random_uuid()`, `employee_id` fk → employees on delete restrict, `programme`, `provider`, `result` (text not null, 1–200), `completed_on date not null`, `created_at`. No department column. Index on `employee_id`.
- RLS: select for admins (`app_metadata.role = 'admin'`), select own (`employees.auth_user_id = auth.uid()`). No insert, update or delete policy (creating/editing training outside the LMS is deferred; only the seed writes, with the service role).
- `training-store.listFor(session, employeeId?)`: admin → all (or one employee); staff → only the session's own (another employee → `[]` without a query). Every query uses `getUserClient()`. Failures raise `TrainingUnavailableError`; `employees-store` maps it to `EmployeesUnavailableError` (never a profile with missing training).
- Each employee's `training` keeps today's shape and order: completed entries (newest completion first) then in-progress entries in fixture order. Training items gain an `id` (fixture items get deterministic seed ids, like interviews).
- Administrator Training tab and org-wide "Learning & development" view render exactly as before (React keys switch to the id).
- Staff portal: a "Completed training" section listing programme, provider, completion date (`D MMM YYYY`) and result; an empty-state message when there are none.

**Never:**
- No `lms-client`, stub-data table, Current section or loading/stale states (Story 3.2).
- No write path (action, insert/update/delete policy) for training.
- No department or manager predicate in RLS or the store.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Staff views | Staff session, own completed rows | "Completed training" lists programme, provider, date, result | None |
| No history | Staff with no completed rows | Empty-state message | None |
| Staff scope | Staff asks store for another employee | `[]`, no query | None |
| Admin views | Admin opens Training tab / L&D view | Completed (table) + in-progress (fixture), same rendering as before | None |
| Other staff (RLS) | Another staff JWT queries the table | Zero rows of that employee | None |
| Writes | Any signed-in role inserts/updates/deletes | Refused / zero rows | RLS |
| DB down | Training read fails | Employee-records-unavailable alert | `TrainingUnavailableError` → `EmployeesUnavailableError` |

</intent-contract>

## Code Map

- `src/data/employees.ts:11` -- `Employee.training` type `{ name, provider, progress, date, result }`; fixture at `:56` (one completed, one in-progress per employee). Add `id`; add `trainingSeedId(employeeId, index)` and `trainingSeedRows(list)` (completed only), mirroring `interviewSeedId`/`interviewSeedRows` (use the hex prefix `7a1a0000-0000-4000-8000-…`, distinct from the interview ids `5eed0000-…`).
- `src/server/interviews-store.ts` -- the pattern to mirror for `training-store` (`run()` error mapping, `createXStore({ userClient })`, staff scoping without a query, typed unavailable error).
- `src/server/employees-store.ts:44-77,82-134` -- `nestedFor()` copies fixture `training`; remove training from it and inject `training: Pick<TrainingStore, "listFor">` alongside `interviews`; `listFor` does one training read for the list, `getFor` one for the employee; map `TrainingUnavailableError` like `interviewsFor`.
- `src/components/staff-attendance.tsx` -- staff portal; add the "Completed training" section (filter `progress === 100`) near "External interviews".
- `src/components/portal.tsx:39,65,73,75` -- trainings list, Training tab (`key={t.name}` → id), L&D stat and table: rendering must not change.
- `scripts/seed-employees.ts:39` -- add an insert-only (`ignoreDuplicates: true`) upsert of `trainingSeedRows` after the employees, like interviews.
- `supabase/migrations/20261012010000_external_interviews.sql` -- RLS style to mirror; new file sorts after `20261012020000_external_interview_updates.sql`.
- `tests/interviews-store.test.ts`, `tests/interviews-rls.test.ts`, `tests/employees-store.test.ts`, `tests/fixture-interviews.test.ts`, `tests/components/*.test.tsx` -- patterns; RLS test uses its own throwaway BS-9xxx range not used by other suites (e.g. BS-95xx; check with grep).
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration apply order and deploy-before-code note; training source.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261012030000_training_history.sql` -- table, index, RLS enabled, two select policies. ADDITIVE.
- `src/data/employees.ts` -- training `id`; `trainingSeedId`, `trainingSeedRows`.
- `src/server/training-store.ts` -- `createTrainingStore({ userClient })`, `listFor`, `TrainingUnavailableError`, `TrainingEntry = Employee["training"][number] & { employeeId }`; merge table rows (mapped to `progress: 100`, `date: completed_on`) with fixture in-progress entries.
- `src/server/employees-store.ts` -- training from the injected store; fixture training never read here.
- `src/components/staff-attendance.tsx` -- "Completed training" section with a labelled table.
- `src/components/portal.tsx` -- keys by id only.
- `scripts/seed-employees.ts` -- insert completed training.
- `docs/DEPLOYMENT.md` -- add the migration to the apply order; code needs it before deploy.
- Tests: `tests/training-store.test.ts` (fake client: admin/staff scoping, merge order, mapping, unavailable), `tests/fixture-training.test.ts` (seed rows = completed only, deterministic ids), `tests/employees-store.test.ts` (training from store, unavailable mapping), `tests/components/staff-attendance.test.tsx` (section + empty state + axe), `tests/components/portal.test.tsx` (Training tab/L&D unchanged), `tests/training-rls.test.ts` (live, skipIf unconfigured: own read, other staff zero, manager-role zero, admin all, anon none, no insert/update/delete), `tests/e2e/training.spec.ts` (seeded demo staff or e2e admin sees Nadia's completed training; staff portal section visible for an e2e staff with the empty state).

**Acceptance Criteria:**
- Given a signed-in Staff member, when they open their portal, then they see all their completed training entries (programme, provider, completion date, result).
- Given the fixture training, when `npm run db:seed` runs after the migration, then completed entries are in `training_history`, in-progress ones are not, and the Administrator's Training tab and L&D view look the same as before.
- Given a Staff session, when training is queried, then RLS returns only that employee's entries.
- Given the `training_history` schema, then it has no department column, and every training read goes through `training-store`.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 19 findings — high 0, medium 4, low 13, false 2, maybe-false 0
- findings:
  - `medium` `defer` (verification-gap) db:seed's training write is never executed by a test — the seed script has never been tested (interviews seed likewise); closing it needs a testable seed refactor or a CI seed run, outside this story.
  - `low` `reject` (edge) Admin unscoped training read has no paging past PostgREST max-rows (1000) — about 8 seeded rows today; paging adds a loop. Same call as the 2.1 interviews deferral.
  - `low` `reject` (intent) No e2e signs in a staff member with seeded completed training — the demo staff password is not available to e2e; the component test plus the live store/RLS suite cover the populated path.
  - `low` `patch` (intent) In-progress entries are scoped by app code, not RLS — grouped with the blind finding below; comments corrected.
  - `medium` `defer` (intent) A failed training read makes the whole employee record unavailable — grouped with the blind finding below.
  - `low` `patch` (blind) Comments claim fixture in-progress entries are "scoped exactly like table reads" — the session that scopes them is server-derived from the same JWT, so there is no real leak path, but the claim was inaccurate; comments now say the store scopes them from the session and RLS covers table reads.
  - `low` `reject` (blind) History/current split on `progress === 100` — matches the fixture's only completion signal; Story 3.2 introduces LMS status and owns that model.
  - `false` `reject` (blind) Schema lacks source/LMS id for 3.2 dedup — 3.2 can add nullable columns additively; nothing breaks now.
  - `false` `reject` (blind) "Never twice" not enforced by a natural-key constraint — the DoD asks for unique identifiers (uuid PK); the only writer is the deterministic, insert-only seed.
  - `low` `reject` (blind) No automated guard that all training reads go through training-store — a grep confirms the only runtime path; an architecture test is new machinery.
  - `low` `reject` (blind) AC1 not checked end to end with real rows — same as the intent finding.
  - `low` `reject` (blind) Verification section tolerates schema-missing failures — the fix is a spec edit; the migration hand-off rule governs it.
  - `medium` `defer` (blind) Training-table failure blocks the whole staff page — the deliberate "never a profile with missing data" choice made in 2.1 (already deferred there for interviews); section-level unavailability belongs with 3.2's per-section states.
  - `low` `reject` (blind) Migration without seeding drops completed entries from admin views — the deploy checklist says to seed straight after migrating; a cutover check adds machinery.
  - `low` `reject` (blind) `toEmployee` defaults training to `[]` — its only callers pass training; mirrors the interviews parameter.
  - `low` `defer` (blind) Staff copy "Only you and the L&D Administrator can see them" becomes wrong once Story 4.3 adds manager-scoped training RLS — owned by 4.3.
  - `medium` `patch` (blind) DEPLOYMENT.md deploy steps are run-on and ambiguous (the 2.1 "apply before deploying this code" line) — replaced with one numbered migrate → seed → deploy checklist.
  - `low` `reject` (blind) `completed_on` has no date bounds — would invent policy; only the fixture seed writes.
  - `low` `patch` (blind) errorSpy restored only on success in the portal key test — wrapped in try/finally.

## Design Notes

In-progress entries stay on the fixture (behind `training-store`) because the AC says so; 3.2 replaces that source with `lms-client`. Training rides on `Employee.training` so admin views keep one data path, as interviews did in 2.1.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: pass, except live suites touching new schema (schema-missing only: PGRST205 / 42703 / 42P01)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except flows reading employees (schema-missing only, until the 2.2 and 3.1 migrations are applied)

## Auto Run Result

Status: done

**Summary:** Completed training now lives in a new `training_history` table: an ADDITIVE migration with no department column, select-only RLS for the employee and the Administrator, and no write policies. A new `training-store` is the only source of training data. It serves completed entries from the table and in-progress entries from the fixture until Story 3.2. `employees-store` reads training through it, and the staff portal shows a "Completed training" section. The Administrator's Training tab and the L&D view render unchanged. `db:seed` inserts the fixture's completed entries (insert-only).

**Files changed:**
- migration `20261012030000_training_history.sql` (ADDITIVE)
- `src/server/training-store.ts` (new)
- `src/server/employees-store.ts`: training now comes from the store
- `src/data/employees.ts`: training ids, `trainingSeedId`, `trainingSeedRows`
- `src/components/staff-attendance.tsx`: Completed training section
- `src/components/portal.tsx`: id keys
- `scripts/seed-employees.ts`
- `docs/DEPLOYMENT.md`: numbered migrate → seed → deploy checklist
- `docs/ARCHITECTURE.md`
- tests:
  - new: `training-store`, `fixture-training`, live `training-rls`, e2e `training.spec`
  - updated: `employees-store` and the component tests

**Review:** 19 findings, 0 high. 3 entries patched (1 medium, the deploy checklist; 2 low, the scoping comments and the test spy leak). 3 deferred (2 medium, 1 low; also in deferred-work.md). 13 rejected; the reasons are in the triage log.

**Follow-up review recommended:** false. Only one medium entry was patched, and it was docs-only.

**Verification:**
- `npm run typecheck`: clean.
- `npm run build`: succeeds.
- `npm test`: 447 passed, 10 skipped. The failures are schema-missing only:
  - `tests/training-rls.test.ts` setup fails with PGRST205 because `training_history` is not in the schema cache;
  - the 8 failures in `tests/interviews-rls.test.ts` come from the unapplied 2.2 migration (42703 / PGRST204).
- `npm run test:e2e` with the installed Chromium: 8 passed, 10 failed. Every failure is because employee reads fail on the missing `withdrawn_at` (42703) from the parent PR's migration, which happens before the training read.
- Both training migrations were applied to a throwaway local Postgres 16. Staff saw only their own row. Updates and deletes affected 0 rows. A staff insert was refused by RLS.

**Residual risk:** RLS and the e2e flows have not run against the shared project. Apply the 2.2 and 3.1 migrations, run `npm run db:seed`, then re-run `npm test` and `npm run test:e2e`.
