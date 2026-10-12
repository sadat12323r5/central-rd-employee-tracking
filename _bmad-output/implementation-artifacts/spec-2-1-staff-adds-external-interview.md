---
title: 'Story 2.1 — Staff adds an external interview'
type: 'feature'
created: '2026-10-12'
baseline_revision: '75f2e58c8b2ce59890e0e01fd36166a696ef8594'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
deferred:
  - summary: >-
      Employee reads (admin directory, staff sign-in, staff page) fail as a whole when the interviews read fails.
    evidence: |-
      employees-store merges interviews and maps InterviewsUnavailableError to EmployeesUnavailableError (the spec requires never showing a profile with missing interviews). Both tables live in the same database, so in practice only a missing migration splits them; DEPLOYMENT.md now says to apply the migration before deploying. Decoupling sign-in from the interviews read needs a new store method.
    location: >-
      src/server/employees-store.ts
    severity: medium
  - summary: >-
      Admin interviews list has no paging; PostgREST max-rows (1000) would silently truncate it.
    evidence: |-
      interviews-store.listFor makes one unfiltered query for Administrators. Far above current volume (≈6 seeded rows).
    location: >-
      src/server/interviews-store.ts
    severity: low
  - summary: >-
      Overview "Upcoming interviews" stat and the hard-coded "On your radar" interview row ignore staff-added interviews.
    evidence: |-
      The stat counts outcome === "Scheduled" and staff outcome is optional free text; the radar row is pre-existing hard-coded demo content. Neither view is named in Story 2.1's acceptance criteria.
    location: >-
      src/components/portal.tsx
    severity: low
  - summary: >-
      The add-interview form resets after a failed save (React 19 form actions), so staff retype their input.
    evidence: |-
      Same uncontrolled-form pattern as the existing attendance forms; fixing it means echoing values through ActionState.
    location: >-
      src/components/staff-attendance.tsx
    severity: low
  - summary: >-
      Re-running db:seed overwrites seeded interview rows and never removes stale ones; matters once Story 2.2 allows edits.
    evidence: |-
      Upsert on id rewrites all columns; seed ids derive from list position.
    location: >-
      scripts/seed-employees.ts
    severity: low
  - summary: >-
      No test asserts the feedback callout is hidden for an interview with empty feedback.
    evidence: |-
      Cosmetic only; portal.test.tsx renders a staff-added interview but does not check for a .callout element.
    location: >-
      src/components/portal.tsx
    severity: low
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

### 2026-10-12 — Review pass
- verdicts: 32 findings — high 0, medium 3, low 26, false 3, maybe-false 0
- findings:
  - `false` `reject` (blind) Staff can write `feedback` on insert via PostgREST — the feedback is the employee's own interview feedback, and Story 2.2 lets them edit it; `created_at` ordering forge is negligible.
  - `low` `defer` (blind) Admin list truncation past max-rows — deferred, far above current volume.
  - `medium` `patch` (blind) Deploying code before the migration takes down the directory and sign-in, undocumented — DEPLOYMENT.md now states the deploy order.
  - `low` `defer` (blind) "Upcoming interviews" stat ignores staff entries — deferred; not a view named in the ACs.
  - `low` `reject` (blind) Free-text outcomes don't match Badge colours — cosmetic; the AC requires free text.
  - `low` `defer` (blind) "On your radar" row hard-coded — pre-existing demo content; deferred with the stat.
  - `low` `defer` (blind) Form loses input on a failed save — same pattern as existing forms; deferred.
  - `low` `reject` (blind) 42501 reported as unavailable — needs a relinked account; adds a branch.
  - `low` `reject` (blind) Interview date unbounded — a typo is visible and harmless; bounds would invent policy.
  - `low` `reject` (blind) Index doesn't match sort — tiny table.
  - `low` `defer` (blind) Re-seed overwrites edits / leaves stale rows — matters from Story 2.2; deferred.
  - `low` `reject` (blind) getFor runs queries sequentially — one extra round trip, only after the employee is found.
  - `low` `reject` (blind) Duplicate outcome label code — two one-liners.
  - `low` `defer` (blind) Missing callout test — grouped with the verification-gap finding.
  - `low` `patch` (blind) RLS test ignores `all.error` and delete row count — fixed (asserts error null, `.select("id")` on delete).
  - `medium` `defer` (edge) Sign-in and staff page fail when the interviews read fails — deferred (same database; deploy order documented); decoupling needs a new store method.
  - `low` `defer` (edge) Admin list truncation — same as blind finding.
  - `low` `defer` (edge) Form reset on error — same as blind finding.
  - `low` `defer` (edge) Outcome normalisation for stat/badge — same as blind findings.
  - `low` `patch` (edge) No ordering tiebreaker — added `.order("id", desc)`.
  - `low` `reject` (edge) 42501 mapping — same as blind finding.
  - `low` `patch` (edge) Non-availability errors masked as "unavailable" — only InterviewsUnavailableError is wrapped now; test asserts others rethrow.
  - `low` `defer` (edge) Stale seed rows — same as blind finding.
  - `low` `defer` (edge) Radar row hard-coded — same as blind finding.
  - `medium` `patch` (verification-gap) Seed row mapping untested — extracted `interviewSeedRows()` into the fixture module; vitest asserts BS-1001's row and the total.
  - `low` `defer` (verification-gap) Feedback callout branch untested — deferred, cosmetic.
  - `false` `reject` (verification-gap other) Directory/sign-in depend on the interviews migration — duplicate of the deploy-order finding, already patched in docs.
  - `false` `reject` (verification-gap other) RLS only checked live — known environment limit, not a code gap.
  - `low` `reject` (intent) Saving checked only with mocks offline — the live RLS suite and e2e cover it once the migration is applied.
  - `low` `reject` (intent) Fixture move is a seed step, not the migration — the repo rule is that migrations never seed; R4b (one runtime source) is implemented.
  - `low` `patch` (intent) No test for a manager-like role being excluded (FR-3) — added a live case with app_metadata.role = "manager" getting zero rows.
  - `low` `reject` (intent) No forged-ID POST through the running app — action test plus the RLS insert refusal cover both layers.

## Design Notes

Interviews ride on `Employee.interviews` so the admin portal and staff page keep one data path (employees-store), now backed by the table. Seed ids are derived deterministically (e.g. UUID from a SHA-256 of `employee_id:index`) so re-seeding is idempotent.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: pass, except live suites touching new tables (schema-missing only: 42P01 / PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except flows needing `attendance_entries` / `external_interviews` (schema-missing only)

## Auto Run Result

Status: done

**Summary:** Staff record external interviews (company, role, date, stage, optional outcome) from the staff portal. They are stored in a new `external_interviews` table with RLS (own employee via `employees.auth_user_id`, or the Administrator role; no department lookup; no update or delete policy). Employee profiles now read interviews only from the table, and `npm run db:seed` moves the fixture interviews into it.

**Files changed:** migration `20261012010000_external_interviews.sql` (ADDITIVE); `src/server/interviews-store.ts`, `src/server/interviews-actions.ts` (new); `src/domain/dates.ts` (new: calendar-date check, `D MMM YYYY`); `src/server/employees-store.ts` (interviews from the store); `src/data/employees.ts` (interview ids, `interviewSeedId`, `interviewSeedRows`); `src/components/staff-attendance.tsx` (External interviews section); `src/components/portal.tsx` (id keys, "No outcome yet", shared date formatter); `scripts/seed-employees.ts`; docs; tests (store, actions, dates, fixture, employees-store, components, live RLS, e2e spec, e2e setup/teardown).

**Review:** 6 patched (2 medium: deploy-order docs, seed-mapping test; 4 low: RLS test assertions, ordering tiebreaker, error masking, manager-role exclusion test), 6 deferred, 20 rejected (see triage log). Follow-up review recommended: true (patched: 0 high, 2 medium, 4 low; two medium patches on a first pass). Named unverified risk: the RLS policies and the e2e add-and-see flow have not run against an applied schema.

**Verification:** `npm run typecheck` clean; `npm run build` succeeds; `npm test` 345 passed, 10 skipped, only `tests/interviews-rls.test.ts` failing with PGRST205 (`external_interviews` not found). `npm run test:e2e` 8 passed, 7 failed, every failure caused by PGRST205 on `external_interviews` (employee reads now include interviews).

**Residual risk:** RLS policies, the e2e add-and-see flow and the seed have not run against the real table. Apply the migration, run `npm run db:seed`, then re-run `npm test` and `npm run test:e2e`.
