---
title: 'Story 1.5 — Staff attendance survives restarts'
type: 'feature'
created: '2026-10-12'
baseline_revision: 'd0951386cb680b93396446223f1a3015b65558f0'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Attendance lists have no limit or paging, so PostgREST max-rows (default 1000) could silently truncate them.
    evidence: |-
      listForEmployee/listAll select whole histories with no .range()/.limit(). A staff member needs ~4 years of entries to hit 1000, and listAll has no app caller yet; Story 5.4 (attendance views use real data) should add a date window or paging.
    location: >-
      src/server/attendance-store.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Clock-ins and daily logs live in server memory (`src/server/attendance-store.ts`), so they vanish on restart and are not shared between Vercel instances. Attendance is not a reliable record.

**Approach:** Add an additive migration with an `attendance_entries` table plus RLS (staff read/write only rows of the employee linked to their auth user; admins read all; nobody deletes). Re-implement the unchanged `AttendanceStore` interface on Supabase through the per-request JWT client, and surface a clear "unavailable" state in the page and actions when the database cannot be reached.

## Boundaries & Constraints

**Always:**
- `AttendanceStore` keeps its exact signatures (`listForEmployee`, `listAll`, `save`, `clear`); `TimesheetEntry` shape is unchanged.
- Every store query runs through `getUserClient()` (RLS enforced); the store never uses the service role.
- Staff identity in actions keeps coming from the session, never form data.
- RLS is the enforced rule; the store keeps its role-agnostic queries (it never widens a staff query).
- A failed read or write raises `AttendanceUnavailableError`; the page shows an alert instead of an empty list, and actions return an error saying nothing was saved — never a success message.
- Migration is ADDITIVE only (new table, indexes, policies). Forward-only, timestamped after Story 1.4's `20261008000000`.

**Never:**
- No delete policy or delete code path. The Supabase store's `clear()` throws (no hard deletes); only the in-memory test double clears.
- Do not change admin portal attendance summaries (still fixture data until Story 5.4).
- Do not edit `src/domain/timesheet.ts` rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Persist | Staff clocks in, saves log, server restarts | Entry and log read back from Supabase | None |
| Staff scope | Staff JWT, rows for self and another employee | Only own rows returned; insert/update for another employee rejected by RLS | RLS error → `AttendanceUnavailableError` |
| Admin scope | Admin JWT | `listAll` returns every employee's rows | None |
| Same-day race | Second insert for same employee and day | Unique violation `23505` | Mapped to `TimesheetValidationError("ALREADY_RECORDED")` |
| DB down | Client throws or returns an error | Page alert "Attendance is unavailable"; action error "…nothing was saved…" | `AttendanceUnavailableError` |
| Clear | `clear()` on Supabase store | Throws | No rows deleted |

</intent-contract>

## Code Map

- `src/server/attendance-store.ts` -- interface + in-memory impl today; becomes the Supabase impl (`createAttendanceStore({ userClient })`, exported `attendanceStore`), `AttendanceUnavailableError`, row↔entry mapping.
- `src/server/employees-store.ts` -- pattern to copy: `run()` wrapper converting thrown/returned errors to a typed unavailable error; `createXStore({ userClient })` factory.
- `src/server/supabase.ts` -- `getUserClient()` per-request JWT client.
- `src/server/attendance-actions.ts:18` -- `run()` catches `TimesheetValidationError`; must also catch `AttendanceUnavailableError`.
- `src/app/page.tsx:18` -- staff branch lists entries; add the unavailable alert, mirroring `EmployeesUnavailable`.
- `src/domain/timesheet.ts:28` -- `TimesheetEntry`; `:97` ALREADY_RECORDED message reused.
- `supabase/migrations/20261006000000_employees.sql` -- RLS style (`app_metadata.role` for admin, `auth_user_id = auth.uid()` for own).
- `tests/attendance-actions.test.ts` -- uses `attendanceStore.clear/listAll/listForEmployee`; switch to a memory double via `vi.mock`.
- `tests/employees-rls.test.ts` -- live-test template (throwaway users, BS-99xx rows, cleanup).
- `tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts` -- throwaway employees are deleted; attendance rows for them must go first (FK restrict).
- `tests/e2e/staff-attendance.spec.ts` -- comment says records live in memory; add a reload/persistence check.
- `tests/page.test.tsx:8` -- mocks attendance-store.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261012000000_attendance.sql` -- create `public.attendance_entries` (`id uuid pk`, `employee_id text not null references employees on delete restrict`, `work_date date`, `clock_in timestamptz`, `clock_out timestamptz null`, `break_minutes int >= 0`, `work_mode text in (Office, Remote, Client site)`, `log jsonb null`, `created_at`, `updated_at`), `unique (employee_id, work_date)`, enable RLS, policies: select admin; select/insert/update own via `exists (employees e where e.employee_id = attendance_entries.employee_id and e.auth_user_id = auth.uid())`; no delete policy -- ADDITIVE.
- `src/server/attendance-store.ts` -- Supabase-backed impl per Code Map; newest-first ordering (`work_date desc, clock_in desc`); `save` upserts on `id`; `23505` → ALREADY_RECORDED; other errors → `AttendanceUnavailableError`; `clear()` throws.
- `tests/support/memory-attendance-store.ts` -- in-memory `AttendanceStore` (the old implementation) for unit tests.
- `src/server/attendance-actions.ts` -- return `{ error: "Attendance could not be reached, so nothing was saved. Please try again in a moment." }` on `AttendanceUnavailableError`.
- `src/app/page.tsx` -- render an `AttendanceUnavailable` alert (role="alert") on `AttendanceUnavailableError`.
- `tests/attendance-store.test.ts` -- fake-client unit tests: mapping both ways, query ordering/filters, upsert, 23505 mapping, error and thrown-client mapping, `clear()` throws.
- `tests/attendance-actions.test.ts` -- mock the store module with the memory double; add an unavailable-store case.
- `tests/page.test.tsx` -- unavailable attendance renders the alert, no entries table.
- `tests/attendance-rls.test.ts` -- live (skipIf unconfigured): staff own read/insert/update; cannot read or write another employee's rows; admin reads all; anon none; delete affects nothing; duplicate day → 23505; a fresh store instance (new client) reads back a saved entry and log.
- `tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts` -- delete throwaway attendance rows before throwaway employees (sweep and teardown).
- `tests/e2e/staff-attendance.spec.ts` -- after saving the log, reload in a new page/context and confirm the entry and log are still shown; update the in-memory comment.

**Acceptance Criteria:**
- Given a Staff member clocks in and writes a daily log, when the server restarts (fresh store/client), then the entries are still there.
- Given a Staff session, when attendance is queried, then only that employee's entries are returned (RLS).
- Given an Administrator session, when attendance is queried, then every employee's entries are returned.
- Given the existing attendance tests, when the store moves to Supabase, then the `AttendanceStore` interface is unchanged and the tests pass.
- Given the database is unreachable, when a Staff member opens attendance or clocks in, then a clear error appears and nothing is shown as saved.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 23 findings — high 0, medium 2, low 19, false 2, maybe-false 0 (5 intent-alignment observations triaged as findings)
- findings:
  - `medium` `patch` Staff can rewrite any past own entry via direct PostgREST (update policy checks ownership only) — patched: insert/update policies now also require `work_date` = today in Asia/Dhaka.
  - `medium` `patch` Staff can backdate/forge entries on insert — same root cause and fix as above (grouped).
  - `low` `patch` No DB check that clock_out >= clock_in — added `attendance_entries_clock_order` check; live test asserts 23514.
  - `low` `reject` `updated_at`/`created_at` trusted from caller — audit columns are informational only; a trigger adds complexity for a negligible everyday harm.
  - `low` `defer` Lists have no limit/paging (PostgREST max-rows truncation) — deferred to Story 5.4; ~4 years of entries needed to reach it.
  - `low` `reject` RLS refusal (42501) reported as "unavailable" — reachable only with a forged foreign id; fix adds a new error branch.
  - `low` `reject` `toEntry` outside try/catch; malformed timestamps/log JSON crash the page — typed timestamptz columns cannot hold malformed timestamps; bad log JSON needs a direct REST forge of one's own row and only breaks one's own page; validation adds surface.
  - `false` `reject` `clear()` remains on the interface but throws — the intent requires the interface unchanged and the Definition of Done forbids hard deletes; throwing is the spec's decision.
  - `low` `reject` work_mode list duplicated in SQL and TS — same pattern as employees.status; adding a mode is a deliberate migration anyway.
  - `low` `reject` RLS test id slot collisions (1 in 50) — same convention as employees-rls.test.ts; fixing adds machinery.
  - `low` `patch` RLS test cleanup ignored delete errors — cleanup now throws on either delete error; users deleted in `finally`.
  - `low` `reject` No action-level test for the 23505 race — store-level fake and live tests cover the mapping; the action branch for TimesheetValidationError is already tested.
  - `false` `reject` Missing index on employees.auth_user_id — the column is `unique`, which creates an index.
  - `low` `reject` Docs omit rollback steps — PR "Needs migration" section covers apply order; one doc clause added with the policy patch.
  - `low` `reject` Concurrent clock-out and save-log full-row upsert, last write wins — needs two simultaneous submissions from the same user; in-memory store had the same behaviour; fix requires per-column writes.
  - `low` `reject` Double clock-in race says "already recorded" not "already clocked in" — message wording only; fix adds a re-read branch.
  - `low` `reject` Upsert can overwrite clock-out when racing (grouped with concurrent writes above).
  - `low` `reject` Log jsonb shape not validated (edge-case duplicate of the toEntry finding).
  - `low` `patch` RLS cleanup error ignored (edge-case duplicate, same fix).
  - `low` `reject` Intent: no real server-process restart in tests — the in-memory store is gone; fresh client/browser context against the shared DB proves persistence.
  - `low` `reject` Intent: no app surface for an Administrator attendance query — admin attendance views are Story 5.4; the AC is met at store + RLS level (`listAll` under admin JWT).
  - `low` `reject` Intent: existing action tests run against an in-memory double, not Supabase — the AC is that the interface is unchanged; the Supabase impl is covered by fake-client and live tests.
  - `low` `reject` Intent: no test that unsaved log input survives a failed save — reading (a) "nothing shown as saved" is implemented; the component renders `state.error` in role=alert.

## Design Notes

Own-row RLS goes through `employees.auth_user_id` (the identity link Story 1.3 made), not `app_metadata.employee_id`, so there is one source of truth for "which employee is this user". FK is `on delete restrict`: there is no employee hard-delete path in the app, and restrict prevents silent loss of attendance history; test cleanup deletes attendance first.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: all pass except live attendance tests, which until the migration is applied may fail only with schema-missing errors (42P01 / PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except attendance flows that need the new table (schema-missing only)

## Auto Run Result

Status: done

**Summary:** Staff attendance moves from server memory to a new Supabase `attendance_entries` table behind the unchanged `AttendanceStore` interface, using the per-request JWT client. RLS: Administrators read all; staff read their own entries and create/change only today's (Asia/Dhaka) entry; no delete policy. Database failures show an "Attendance is unavailable" alert on the page and a "nothing was saved" error from actions.

**Files changed:**
- `supabase/migrations/20261012000000_attendance.sql` -- ADDITIVE: new table, unique (employee, day), clock-order check, index, RLS policies.
- `src/server/attendance-store.ts` -- Supabase implementation, `AttendanceUnavailableError`, 23505 → ALREADY_RECORDED, `clear()` refuses.
- `src/server/attendance-actions.ts` -- unavailable → error, never success.
- `src/app/page.tsx` -- attendance-unavailable alert.
- `src/components/staff-attendance.tsx`, `README.md`, `docs/ARCHITECTURE.md` -- removed "server memory" notes; documented the policies.
- `tests/attendance-store.test.ts`, `tests/support/memory-attendance-store.ts`, `tests/attendance-actions.test.ts`, `tests/page.test.tsx` -- offline tests.
- `tests/attendance-rls.test.ts` -- live RLS/persistence suite.
- `tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts`, `tests/e2e/staff-attendance.spec.ts` -- attendance cleanup before throwaway employees; persistence check in a fresh browser context.

**Review:** 4 patched (1 medium entry: today-only staff write policies; 3 low: clock-order check, cleanup error handling ×2), 1 deferred (list paging, to Story 5.4), 18 rejected with reasons in the triage log. Follow-up review recommended: false (patched: 0 high, 1 medium, 3 low).

**Verification:** `npm run typecheck` clean; `npm run build` succeeds; `npm test` 266 passed, only `tests/attendance-rls.test.ts` fails, in setup, with PGRST205 (table not found; migration not applied). `npm run test:e2e` 11 passed, 3 failed (staff clock-in flow, staff cannot see manager portal, provisioning sign-in), each showing the attendance-unavailable alert because of PGRST205.

**Residual risk:** RLS policies, the clock-order check, the same-day race and the e2e persistence path have not run against a real table; apply the migration and re-run `npm test` and `npm run test:e2e`. A live test run straddling Dhaka midnight could fail spuriously.
