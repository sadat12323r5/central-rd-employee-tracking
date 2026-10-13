# Epic 3 Context: Training Visibility

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let employees see their own training record in the staff portal without asking whoever tracks it: what they are currently enrolled in on BrainStation's LMS, and every programme they have completed. The Administrator sees the same data on an employee's profile Training tab and in the org-wide Learning & Development view. The epic moves training off the fixture file and onto durable, role-scoped storage. It also introduces the product's first external data source, an LMS adapter that ships as a stub because the real integration mechanics are still unknown. Its stale, unavailable and loading handling sets the reliability pattern for every later network-dependent read.

## Stories

- Story 3.1: Staff views their completed-training history
- Story 3.2: Staff and Administrator see current LMS enrolments

## Requirements & Constraints

- **Strict history/current split:** history holds only completed courses: stored entries plus courses the LMS reports as completed. "Current" holds only in-progress LMS enrolments. An entry never appears in both sections, and never twice. Deduplicate when a course the LMS reports as completed is also stored in the training table.
- **Fields:** history shows programme, provider, completion date and result. Current shows programme, provider, progress and target date.
- **Pre-LMS history:** legacy entries that predate the LMS must display correctly alongside entries synced from the LMS.
- **No department on training:** training always comes from L&D. The training table has no department field, so history is never filtered by the employee's current department and stays with them after a later transfer.
- **Visibility:** a Staff session sees only its own training, enforced by both a store check and the database (RLS). The Administrator can read any employee's training.
- **No regressions in admin views:** after the move, the Administrator's Training tab and the org-wide L&D view look the same as before. In-progress figures in the org-wide view must not disappear once the fixture is no longer read at runtime.
- **Network-dependent reads:** a loading state shows in Current while history renders immediately. Stale LMS data is clearly marked with an "as of" time. An unreachable LMS shows a clear "unavailable" message in place of current enrolments, and history still shows. Never show blank or stale-looking-fresh data.
- **Fixture retirement:** after Epic 3, nothing reads `src/data/employees.ts` for training at runtime. That file is used only for seeding.
- **Not in scope:** creating or editing training entries outside the LMS, by Staff or the Administrator, is deferred.
- **Display:** dates use `D MMM YYYY` in the `Asia/Dhaka` org timezone. Status has a text label as well as colour. Controls are keyboard-operable.
- **Definition of Done:** zod validation in any new server action before it calls a store. Both a store-level check and an RLS policy on every new table. Training identifiers are unique through a database constraint. Every new `src/domain/*` or `src/server/*` module has a matching `tests/*.test.ts`. Every acceptance criterion is covered by an automated test. `npm run check` and `npm run test:e2e` pass. No hard-delete paths.

## Technical Decisions

- **`src/server/training-store.ts`** is the single repository of record for all training reads, both current and historical. All views (staff portal, the Administrator's Training tab, the org-wide L&D view) go through it. The history/current merge and the deduplication logic live here.
- **`src/server/lms-client.ts`** is the LMS adapter. Its fixed contract is `listCurrentEnrolments(employeeId): Promise<{ data: Enrolment[]; asOf: string; stale: boolean }>`. It throws `LmsUnavailableError` only when the LMS is unreachable. A reachable but stale response sets `stale: true` and does not throw. Only `training-store` may call it. The stub satisfies this exact contract, so only the implementation changes when real LMS access arrives.
- **Stub data source:** the fixture's in-progress entries are seeded into a stub-data table that the stub reads. They are not copied into the history table. In 3.1 they keep being served from the fixture through `training-store` until 3.2 replaces that source.
- **The org-wide view needs in-progress data for every employee.** The adapter contract is per employee, so the view needs either one call per employee or a bulk read. Plan for this explicitly.
- **Store conventions:** follow the `AttendanceStore` interface shape. A "not found" read returns `null`. Validation and authorization failures throw a typed error. Scoping depends on role: `admin` reads anyone, and `staff` reads only its session `employeeId`. Ownership always comes from the session, never from form data.
- **Persistence:** Supabase Postgres with RLS. Schema changes go in forward-only SQL migrations under `supabase/migrations/`, applied to the shared project when the PR is approved. RLS tests are Vitest integration tests that sign in as each role, using dedicated test accounts and rows the test creates and removes.
- **Naming:** the entity is `TrainingEnrolment`. Files are kebab-case. Dates are stored as ISO 8601 strings.

## Cross-Story Dependencies

- **Needs Epic 1:** durable persistence, real Staff and Administrator accounts, and the Supabase and RLS setup.
- **3.2 builds on 3.1:** 3.1 creates the training table and `training-store`, and temporarily leaves in-progress entries on the fixture. 3.2 adds `lms-client`, moves in-progress entries to the stub-data table, and adds the Current section and its loading, stale and unavailable states.
- **Later epics:**
  - Epic 4 adds a `manager` role. Manager-scoped RLS on the training table (4.3) and the "training history survives a transfer" check (4.8) are delivered there, not in Epic 3.
  - Epic 4's "My record" area (4.10) reuses this training self-service view.
