---
title: 'Story 1.5 — Staff attendance survives restarts'
type: 'feature'
created: '2026-10-12'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
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

## Design Notes

Own-row RLS goes through `employees.auth_user_id` (the identity link Story 1.3 made), not `app_metadata.employee_id`, so there is one source of truth for "which employee is this user". FK is `on delete restrict`: there is no employee hard-delete path in the app, and restrict prevents silent loss of attendance history; test cleanup deletes attendance first.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: all pass except live attendance tests, which until the migration is applied may fail only with schema-missing errors (42P01 / PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except attendance flows that need the new table (schema-missing only)
