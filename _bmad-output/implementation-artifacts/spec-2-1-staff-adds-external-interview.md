---
title: 'Story 2.1 — Staff adds an external interview'
type: 'feature'
created: '2026-10-12'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** External interviews exist only as fixture data in `src/data/employees.ts`, read-only for the Administrator; employees cannot report an interview, so the L&D manager learns about it only through side conversations.

**Approach:** Add an additive `external_interviews` table with privacy RLS ("is this the employee, or an Administrator" — never a department lookup), an `interviews-store`, a zod-validated staff server action, and an "External interviews" section in the staff portal. Employee profiles read interviews from the table (not the fixture), and the seed script moves the fixture interviews into it.

## Boundaries & Constraints

**Always:**
- The employee is taken from the session; any employee ID in the form is ignored.
- Fields at creation: company, role, date (required), stage (required free text), outcome (optional free text, default empty). Feedback stays empty (Story 2.2 edits it).
- Reads: staff see only their own interviews; Administrators see all. RLS uses exactly `employees.auth_user_id = auth.uid()` for own rows and `app_metadata.role = 'admin'` for admins. No department or manager predicate.
- Every query goes through `getUserClient()`; the service role is used only by the seed script and tests.
- Store-level checks (only a staff session can add; row employee = session employee) and RLS both exist.
- zod validation in the action before any store call; `{ error, message }` ActionState.
- A failed read or write raises a typed unavailable error: never an empty list, never a success message.
- Migration is ADDITIVE (new table, index, policies) and sorts after `20261012000000_attendance.sql`.
- Dates display `D MMM YYYY`; outcome/stage always shown as text.

**Never:**
- No update, withdraw or delete path (Story 2.2). No update or delete RLS policy.
- No Administrator write path for interviews.
- Do not change other nested profile data (skills, history, training, work, attendance, review) — still fixture.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add | Staff submits company, role, date, stage | Saved to session employee; shown in staff portal; "Interview added." | None |
| Forged ID | Form includes `employeeId=BS-1008` | Saved to the session employee | None |
| Invalid | Missing company/role/stage, bad date, field over 200 chars | Nothing saved; field error message | zod → `{ error }` |
| No staff session | Admin or signed-out submits | Nothing saved; "sign in" error | `{ error }` |
| Admin views | Admin opens profile Interviews tab / "Interviews & placements" | New entry listed | None |
| Other staff | Another staff JWT queries | Zero rows of that employee (RLS) | None |
| DB down | Read or insert fails | Page: employee-records-unavailable alert; action: "…nothing was saved…" | typed unavailable error |

</intent-contract>

## Code Map

- `src/data/employees.ts:11` -- `Employee.interviews` shape (`company, role, date, stage, outcome, feedback`); fixture data at `:38` becomes seed-only.
- `src/server/employees-store.ts` -- `nestedFor()` merges fixture interviews; switch interviews to come from `interviews-store` (inject a dependency into `createEmployeesStore`), keep `EmployeesUnavailableError` when the interviews read fails. `listFor` admin: one interviews query for all; staff: own only.
- `src/server/attendance-store.ts` -- pattern for a Supabase store over `getUserClient()` with `run()` error mapping and an unavailable error.
- `src/server/attendance-actions.ts` -- staff-from-session `run()` pattern; new `src/server/interviews-actions.ts` follows it plus zod.
- `src/components/staff-attendance.tsx` -- the staff portal; add an "External interviews" section (list + add form using `useActionState`, like the existing forms).
- `src/components/portal.tsx:37,62,70` -- admin Interviews tab and org-wide view read `employee.interviews`; keys use `i.company` — switch to the interview id.
- `src/app/page.tsx` -- staff branch already loads the employee via `employeesStore.getFor`; interviews arrive on it.
- `scripts/seed-employees.ts` -- extend to upsert fixture interviews into `external_interviews` with deterministic ids (stable per employee + index), idempotent.
- `supabase/migrations/20261012000000_attendance.sql` -- RLS style to mirror.
- `tests/employees-store.test.ts`, `tests/attendance-rls.test.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts` -- test patterns; teardown must delete throwaway interviews before employees (FK restrict), tolerating schema-missing like `deleteAttendanceFor`.
- `tests/e2e/portal.spec.ts:34` -- expects seeded "Northstar Labs (fictional)" for Nadia (needs `db:seed` after the migration).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261012010000_external_interviews.sql` -- `public.external_interviews` (`id uuid pk default gen_random_uuid()`, `employee_id` fk → employees on delete restrict, `company`, `role`, `stage` text not null with length 1–200, `interview_date date not null`, `outcome`/`feedback` text not null default '' length ≤ 200/2000, `created_at`), index on `employee_id`, RLS: select admin; select own; insert own (with check own). ADDITIVE.
- `src/data/employees.ts` -- add `id: string` to the interview item type; fixture ids are the deterministic seed ids.
- `src/server/interviews-store.ts` -- `createInterviewsStore({ userClient })`: `listFor(session)`, `add(session, input)` (staff only; employee from session), `InterviewsUnavailableError`.
- `src/server/interviews-actions.ts` -- `addInterviewAction` with zod (trimmed strings, lengths as in migration, `YYYY-MM-DD` real calendar date); revalidates `/`.
- `src/server/employees-store.ts` -- interviews from the injected store; fixture interviews never read at runtime.
- `src/components/staff-attendance.tsx` -- "External interviews" section: own list (company, role, date, stage, outcome) and add form with labelled fields; shows action error/message.
- `src/components/portal.tsx` -- keys by interview id; empty outcome shown as "No outcome yet".
- `scripts/seed-employees.ts` -- upsert fixture interviews.
- `tests/interviews-store.test.ts`, `tests/interviews-actions.test.ts`, `tests/employees-store.test.ts`, `tests/components/staff-attendance.test.tsx`, `tests/components/portal.test.tsx` -- offline tests for the matrix rows (fake client / mocked store).
- `tests/interviews-rls.test.ts` -- live (skipIf unconfigured): staff own read/insert; other staff zero rows; insert for another employee refused; admin reads all; anon none; update and delete affect nothing.
- `tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts` -- delete throwaway interviews before throwaway employees.
- `tests/e2e/interviews.spec.ts` -- staff adds an interview; the e2e Administrator sees it in the profile Interviews tab and "Interviews & placements".

**Acceptance Criteria:**
- Given a signed-in Staff member, when they add an interview (company, role, date, stage), then it is saved to their own record and appears in their staff portal; stage and outcome are free text.
- Given a submitted form containing a different employee's ID, when it is saved, then it is saved to the signed-in employee.
- Given the entry is saved, when the Administrator opens that employee's Interviews tab or "Interviews & placements", then it shows there with no extra step.
- Given the existing fixture interviews, when `npm run db:seed` runs after the migration, then they are in the table and every view reads from it.
- Given any session that is neither the reporting employee nor an Administrator, when interviews are queried, then RLS returns none of that employee's entries, using an employee-or-admin predicate only.

## Spec Change Log

## Review Triage Log

## Design Notes

Interviews ride on `Employee.interviews` so the admin portal and staff page keep one data path (employees-store), now backed by the table. Seed ids are derived deterministically (e.g. UUID from a SHA-256 of `employee_id:index`) so re-seeding is idempotent.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: pass, except live suites touching new tables (schema-missing only: 42P01 / PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except flows needing `attendance_entries` / `external_interviews` (schema-missing only)
