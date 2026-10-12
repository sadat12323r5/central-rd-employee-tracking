---
title: 'Story 3.2 — Staff and Administrator see current LMS enrolments'
type: 'feature'
created: '2026-10-12'
baseline_revision: 'f963d832d497812f4fead4c04fc49460d213bb45'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** After Story 3.1, in-progress training is still read from the fixture at runtime. There is no LMS adapter, no "Current" section for staff, and no loading, stale or unavailable handling for LMS data.

**Approach:**
- An ADDITIVE migration adds the `lms_stub_enrolments` stub-data table, which `db:seed` fills from the fixture's in-progress entries.
- `src/server/lms-client.ts` implements the fixed AD-3 contract as a stub over that table.
- `training-store` is the only caller. It splits LMS data into Current (in progress) and history (completed, deduplicated against `training_history`).
- Pages stream the LMS result into Suspense boundaries, so history renders immediately and Current shows loading, stale or unavailable states.

## Boundaries & Constraints

**Always:**
- **`lms-client` contract (fixed):** `listCurrentEnrolments(employeeId): Promise<{ data: Enrolment[]; asOf: string; stale: boolean }>`. It throws `LmsUnavailableError` only when the LMS is unreachable (query error, network failure). A reachable but stale response sets `stale: true` and does not throw.
  - `Enrolment = { id, employeeId, programme, provider, status: "in_progress" | "completed", progress, targetDate, completedOn, result }`.
  - Only `training-store` imports `lms-client`.
- **Stub:**
  - It reads `lms_stub_enrolments` for one employee through `getUserClient()`, so RLS applies.
  - `asOf` = the oldest `synced_at` among the rows, or the read time when there are no rows (`stale: false`).
  - `stale = now − asOf > 24h`. The threshold is exported as `LMS_STALE_AFTER_MS`, the stub's own constant, replaced when the real LMS lands.
  - `now` is injectable for tests.
- **`lms_stub_enrolments` table:**
  - Columns: `id uuid pk default gen_random_uuid()`, `employee_id` fk → employees on delete restrict, `programme`, `provider` (text, 1–200), `status` (check in `in_progress`/`completed`), `progress` (int 0–100), `target_date date null`, `completed_on date null`, `result text not null default ''` (≤200), `synced_at timestamptz not null default now()`.
  - A check constraint: `in_progress` ⇒ `progress < 100` and `target_date` not null; `completed` ⇒ `completed_on` not null.
  - Index on `employee_id`.
  - RLS: select for admin, select own (the same predicates as `training_history`). No write policies, and no department column.
- **`training-store`:**
  - `listFor` (completed history from `training_history`) keeps working but **no longer reads the fixture**.
  - New `currentFor(session, employeeIds)` returns `CurrentTraining`:
    - `{ status: "ok", asOf, stale, inProgress: TrainingEntry[], lmsCompleted: TrainingEntry[] }`, or
    - `{ status: "unavailable" }`.
  - **Scoping:** staff → only their own id; any other id is dropped without a call. Admin → every id given.
  - **Calls:** one `lms-client` call per employee, in parallel. `asOf` is the oldest, `stale` is true if any is stale. Any `LmsUnavailableError` → `unavailable`.
  - `lmsCompleted` excludes courses already stored in `training_history` for that employee. The key is the trimmed, case-insensitive programme + provider. If that read fails, the result is `unavailable`.
- **Mapping:**
  - in-progress → `TrainingEntry { progress, date: targetDate, result: "In progress" }`;
  - completed → `{ progress: 100, date: completedOn, result }`.
- **The page never awaits the LMS:**
  - `src/app/page.tsx` passes the `currentFor` promise, which always resolves (any unexpected error → `unavailable` and `console.error`), into the client components.
  - They read it with React `use()` inside `<Suspense>`.
  - History (`employee.training`) renders immediately.
- **Staff portal:**
  - A "Current enrolments" section shows programme, provider, progress and target date (`D MMM YYYY`).
  - Loading shows a `role="status"` "Loading current enrolments…".
  - Stale shows a visible "Stale" label plus "as of D MMM YYYY, HH:mm" (Asia/Dhaka).
  - Unavailable shows a `role="alert"` "Current enrolments are unavailable right now…" while history still shows.
  - Empty shows "No current enrolments."
  - "Completed training" appends the deduplicated `lmsCompleted` rows when they arrive.
- **Administrator:**
  - The profile Training tab keeps stored completed entries immediately and adds the same Current block, filtered to that employee, with the same states.
  - The org-wide "Learning & development" table shows stored completed rows immediately and the in-progress and LMS-completed rows when they arrive, with the same states.
  - The Overview "Learning in progress" stat shows "…" while loading and "Unavailable" when unavailable.
- **Fixture:** `src/data/employees.ts` is seed-only for training. Add `lmsStubSeedRows(list)` (the in-progress entries only, with deterministic ids). `db:seed` inserts them insert-only.

**Never:**
- No real LMS HTTP calls, no write path for training or enrolments, and no `lms-client` import outside `training-store`.
- No runtime import of `@/data/employees` by `training-store` or `lms-client`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh | Stub rows synced < 24h ago | Current lists in-progress rows; no stale label | None |
| Stale | Oldest `synced_at` > 24h ago | Rows shown with "Stale" and "as of …" | None |
| Unreachable | Stub query errors or the network fails | "unavailable" alert in Current; history still shows | `LmsUnavailableError` → `{ status: "unavailable" }` |
| Loading | Promise pending | Loading status in Current; history already rendered | None |
| LMS completed, not stored | `completed` stub row | In history, not Current | None |
| LMS completed, also stored | Same programme + provider in `training_history` | Shown once (the stored entry) | None |
| Staff scope | Staff asks for another id | That id is ignored; no LMS call | None |
| Admin org-wide | Admin, all ids | In-progress for every employee | Any unavailable → unavailable |
| No enrolments | No rows | "No current enrolments."; `stale: false` | None |

</intent-contract>

## Code Map

- `src/server/training-store.ts`
  - Remove the `employees as fixture` import and `fixtureInProgress`; `listFor` returns stored completed only.
  - Add `currentFor`, `CurrentTraining`, and the dedupe helper (exported for tests).
  - Inject `lms: Pick<LmsClient, "listCurrentEnrolments">` into `createTrainingStore`.
  - Keep `TrainingUnavailableError` for history reads.
- `src/server/lms-client.ts` (new): `Enrolment`, `LmsClient`, `LmsUnavailableError`, `LMS_STALE_AFTER_MS`, `createStubLmsClient({ userClient, now? })`, `lmsClient`. Mirror `interviews-store`'s `run()` error handling, but throw `LmsUnavailableError`.
- `src/app/page.tsx`: the staff branch and the admin branch create the promise (`trainingStore.currentFor(...)` wrapped in `.catch → unavailable`) and pass a `current` prop.
- `src/components/staff-attendance.tsx`:
  - The Completed training section is at about lines 221–230.
  - It currently filters `employee.training` by `progress === 100`; all of `employee.training` is now completed.
  - Add the Current section and the appended LMS-completed rows. Both are `use(promise)` children under `<Suspense>`.
- `src/components/portal.tsx`:
  - At :39, `trainings` drives the Overview stats ("Learning in progress", "completed training records").
  - At :65, the Training tab.
  - At :75, the L&D table.
  - Add a `current: Promise<CurrentTraining>` prop and Suspense children for these.
- `src/data/employees.ts`: the `trainingSeedRows` / `trainingSeedId` pattern. Add `lmsStubSeedId` (hex prefix `1a5b0000-0000-4000-8000-…`) and `lmsStubSeedRows` (`progress < 100` entries → `status: 'in_progress'`, `target_date` = entry date).
- `scripts/seed-employees.ts`: an insert-only upsert of `lmsStubSeedRows` after training.
- `supabase/migrations/20261012030000_training_history.sql`: the RLS style to mirror. The new file is `20261012040000_lms_stub_enrolments.sql`.
- `src/server/employees-store.ts`: unchanged (`training` = `listFor` = stored completed).
- `tests/training-store.test.ts`: its fake client pattern; the expectations that in-progress entries come from the fixture must change.
- `tests/components/staff-attendance.test.tsx`, `tests/components/portal.test.tsx`, `tests/page.test.tsx`: callers must pass the new `current` prop. Use resolved promises, or never-resolving ones for the loading state.
- `tests/training-rls.test.ts`: the live pattern. The new `tests/lms-rls.test.ts` uses its own unused BS-9xxx range (check with grep).
- `docs/DEPLOYMENT.md`: add the 6th migration to the numbered checklist.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261012040000_lms_stub_enrolments.sql`: the table, checks, index and two select policies. ADDITIVE.
- `src/server/lms-client.ts`: the stub as above.
- `src/server/training-store.ts`: no fixture; `currentFor`; dedupe.
- `src/app/page.tsx`: pass the promises.
- `src/components/staff-attendance.tsx`, `src/components/portal.tsx`: the Current, loading, stale and unavailable UI, the LMS-completed rows, and the stats.
- `src/data/employees.ts`, `scripts/seed-employees.ts`: the stub seed rows.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`: the checklist and the training source.
- Tests:
  - `tests/lms-client.test.ts` (fake client: fresh, stale and empty asOf; an error or a throw → `LmsUnavailableError`; mapping);
  - `tests/training-store.test.ts` (`currentFor`: scoping, parallel calls, asOf/stale aggregation, unavailable, dedupe, split; `listFor` without the fixture);
  - `tests/fixture-training.test.ts` (`lmsStubSeedRows`: in-progress only, ids);
  - a test asserting that `training-store.ts` and `lms-client.ts` do not import `@/data/employees`, and that only `training-store.ts` imports `lms-client` (a source scan of `src/`);
  - component tests for each matrix state, staff and admin, plus axe;
  - `tests/page.test.tsx` updated;
  - live `tests/lms-rls.test.ts` (own read, other staff none, a manager-role account none, admin all, anon none, no writes; the stub through a staff JWT returns only own rows);
  - e2e `tests/e2e/training.spec.ts`: the Administrator sees Nadia's in-progress enrolment in the Training tab's Current block and in L&D; a staff member sees the "Current enrolments" section (an empty state for a throwaway account).

**Acceptance Criteria:**
- Given the stub is seeded, when the app runs, then nothing reads `src/data/employees.ts` for training (enforced by a source-scan test).
- Given a Staff member opens their portal, then a "Current enrolments" section shows their in-progress LMS enrolments (programme, provider, progress, target date), separate from completed history, with no entry in both.
- Given the Administrator opens an employee's Training tab or the org-wide L&D view, then the same current enrolments appear, with the same loading, stale and unavailable handling, and the in-progress figures are present.
- Given the LMS call is pending, stale or unreachable, then Current shows loading, a "Stale … as of" label, or an "unavailable" alert respectively, while history renders normally.
- Given the LMS reports a course as completed, then it appears in history (once, even if also stored) and not in Current.
- Given any LMS call, then it goes through `lms-client`'s contract and only `training-store` calls it.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 29 findings — high 0, medium 8, low 16, false 5, maybe-false 0
- findings:
  - `medium` `patch` (verification-gap) Profile Overview "Learning journey" card still reads `selected.training` (now completed-only) and silently drops in-progress learning — now reads in-progress entries from `current`; portal test added.
  - `low` `patch` (verification-gap) currentFor's unparseable-asOf branch untested — test added with the aggregation fix below.
  - `false` `reject` (edge) Same course in Current and history (in-progress vs stored completed) — LMS entries carry one status and stored rows are pre-LMS legacy completions; a matching name is a different enrolment (e.g. a retake), not the same entry, so "no entry in both" holds.
  - `low` `reject` (edge) Unbounded parallel LMS calls — about 8 employees; the per-employee contract is fixed (Design Notes); a pool adds machinery.
  - `low` `patch` (edge) Aggregate asOf falls back to results[0] when one asOf is unparseable — the minimum is now taken over parseable values; test added.
  - `medium` `patch` (edge) Profile shows org-wide stale/asOf for one employee — `currentFor` now returns per-employee freshness and the profile uses the selected employee's entry; store and portal tests added.
  - `low` `reject` (edge) Invalid fixture target date would fail the seed batch — every fixture in-progress entry has a valid date (fixture test asserts the seed rows' shape); the DB check reports it loudly.
  - `medium` `patch` (edge) Learning journey loses in-progress rows — same root cause as the verification-gap finding; fixed there.
  - `false` `reject` (edge) In-progress never checked against stored history — same as the first edge finding.
  - `medium` `patch` (edge) Profile Training tab stale/asOf aggregated across employees — same root cause as the per-employee freshness patch.
  - `medium` `patch` (blind) Admin profile shows another employee's staleness — same root cause; fixed by per-employee freshness.
  - `medium` `patch` (blind) Learning journey card lost in-progress training — same root cause; fixed. (The hard-coded "Meera's learning check-in" radar item is pre-existing demo content.)
  - `false` `reject` (blind) A course can appear in both Current and history — same refutation as the edge finding; the seed never moves fixture rows between tables.
  - `medium` `patch` (blind) No timeout on the LMS call; a hang leaves Current loading forever — the stub now rejects with LmsUnavailableError after `LMS_TIMEOUT_MS` (10s); test added.
  - `low` `patch` (blind) Current enrolments ordered by uuid — now ordered by target date, then completion date, then id.
  - `low` `reject` (blind) Check constraint allows completed rows below 100% / in-progress rows with completed_on — the seed writes only valid in_progress rows and the mapping normalises completed rows; extra constraints add surface for a stub table.
  - `low` `reject` (blind) Seeded demo data shows "Stale" permanently after a day — the deliberate, truthful consequence of the stub threshold; surfaced in the PR as a reviewer decision (threshold constant), no sync simulator added.
  - `low` `reject` (blind) Fan-out has no cap or bulk path — same as the edge finding.
  - `low` `reject` (blind) Badges/counts don't say LMS-completed rows are missing when unavailable — the Current alert already says the LMS is unavailable; extra labelling is cosmetic.
  - `low` `reject` (blind) Staff branch starts the LMS read before attendance and may discard it — one wasted read on an error path.
  - `low` `reject` (blind) Coverage gaps (mixed staleness, stale+failure mix, CompletedCount unavailable, e2e stale label, scan scope) — mixed staleness is now tested; the rest are low-value or need seeded stale data the e2e cannot control.
  - `false` `reject` (blind) Spec unfinished (empty logs, in-review) — the workflow fills those sections at this step.
  - `low` `reject` (intent) Staleness derived by the app from a timestamp, not reported by the LMS — the stub stands in for the LMS; the fixed contract's `stale` is the adapter's answer (Design Notes).
  - `medium` `patch` (intent) Profile tab uses org-wide state — same root cause as the per-employee freshness patch.
  - `low` `reject` (intent) Dedup by programme + provider names, not course id — the stub has no LMS course id; recorded in Design Notes.
  - `low` `reject` (intent) Current is a section on the single staff page, not a separate training area — the staff portal is one page; consistent with 3.1.
  - `low` `patch` (intent) Learning journey not rewired — same root cause as the verification-gap finding.
  - `false` `reject` (intent) Running-app states covered only by component tests — loading/stale/unavailable cannot be produced deterministically against the shared project; store, stub and component layers are covered.
  - `low` `reject` (intent) Section order (Completed before Current on the profile, Current first on staff) and the "Current enrolments" label — cosmetic; both views label the sections clearly.

## Design Notes

- **Org-wide gap (flagged by epic context):** the contract is per employee, so `currentFor` makes one call per employee in parallel. That is about 8 calls today. A bulk method would change the fixed contract.
- **Staleness:** the PRD gives no threshold. 24h is the stub's constant, documented in the PR for the reviewer to adjust. Seeded demo data therefore shows as stale once it is a day old, which is truthful.
- **Streaming:** promises cross the server/client boundary resolved-only (unavailable is a value, not a rejection), so `use()` never throws to an error boundary.

## Verification

**Commands:**
- `npm run typecheck`: expected clean.
- `npm test`: expected to pass, except live suites touching unapplied schema (schema-missing only: PGRST205 / 42703 / PGRST204).
- `npm run build`: expected success.
- `npm run test:e2e`: expected to pass, except flows reading employees (schema-missing only, until the 2.2, 3.1 and 3.2 migrations are applied).

## Auto Run Result

Status: done

**Summary:** Current LMS enrolments now come through a stub `lms-client` with the fixed AD-3 contract. The stub reads a new `lms_stub_enrolments` table (ADDITIVE migration, employee-or-admin select-only RLS) that `db:seed` fills from the fixture's in-progress entries. `training-store` is the only caller and no longer reads the fixture. Its `currentFor` splits in-progress entries (Current) from LMS-completed ones (history, de-duplicated against `training_history`) and reports aggregate and per-employee freshness. Pages stream the result into Suspense boundaries:
- history renders immediately;
- Current shows loading, "Stale · as of …", unavailable or empty states, on the staff portal, the Administrator's profile Training tab, the Learning journey card, the L&D table and the Overview stat.

**Files changed:**
- migration `20261012040000_lms_stub_enrolments.sql` (ADDITIVE)
- `src/server/lms-client.ts` (new: stub, 24h staleness, 10s timeout)
- `src/server/training-store.ts`: `currentFor`, dedupe, freshness, no fixture
- `src/app/page.tsx`: streamed promises
- `src/components/current-training.tsx` (new)
- `src/components/staff-attendance.tsx`, `src/components/portal.tsx`
- `src/domain/dates.ts`: `formatDisplayDateTime`
- `src/data/employees.ts`, `scripts/seed-employees.ts`: stub seed rows
- `src/app/styles.css`, docs
- tests:
  - new: `lms-client`, `training-sources` scan, live `lms-rls`
  - updated: `training-store`, fixture, dates, page, components, e2e `training.spec`

**Review:** 29 findings, 0 high.
- Patched: 5 root causes (3 medium, 2 low), covering 13 finding rows:
  - the Learning journey card lost in-progress learning;
  - per-employee freshness on the profile;
  - the LMS read timeout;
  - `asOf` aggregation with an unparseable value;
  - enrolment ordering.
- Deferred: none.
- Rejected: 16; the reasons are in the triage log.

**Follow-up review recommended:** true. Three medium entries were patched on a first pass. Named risk: the streamed Current states and per-employee freshness have not run against the real stub table, because the migration is not applied.

**Verification:**
- `npx tsc --noEmit`: clean.
- `npm run build`: succeeds.
- `npm test`: 557 passed, 21 skipped. The only failures are live suites on unapplied schema:
  - `interviews-rls`: 42703 / PGRST204 (Story 2.2 migration);
  - `training-rls` and `lms-rls`: PGRST205.
- `npm run test:e2e` with the installed Chromium: 8 passed, 10 failed. Every failure comes from employee reads failing with 42703 / PGRST205 on unapplied migrations.
- Migrations 2.1 through 3.2 were applied to a throwaway local Postgres 16. Results:
  - staff see only their own stub rows;
  - updates affect 0 rows;
  - the status check refuses an in-progress row without a target date.

**Residual risk:**
- Apply the 2.2, 3.1 and 3.2 migrations, run `npm run db:seed`, then re-run `npm test` and `npm run test:e2e`.
- Seeded stub data shows "Stale" once it is more than 24h old (the `LMS_STALE_AFTER_MS` decision is surfaced in the PR).
