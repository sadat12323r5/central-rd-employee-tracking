---
title: 'Story 7.3: Maintain employment history'
type: 'feature'
created: '2026-10-14'
baseline_revision: '5b60d16b07c61cf2dff68d679f987a91f4e5f6c0'
status: 'in-progress'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-2-edit-basic-details.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Employment history (role, employer, period, detail) is read from the `src/data/employees.ts` fixture, so nobody can add, correct or remove an entry, and the employee cannot keep their own background current.

**Approach:** Move employment history into a new `employment_history` table with one store, `employment-history-store.ts`. The employee (own record, from the staff portal), the Administrator (anyone) and a department manager (employees in their subtree) add, edit and remove entries; removal sets `removed_at` and the row is kept. `db:seed` copies the fixture history into the table, and the profile's Employment tab reads it from the store and looks the same.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261015020000_employment_history.sql`, **ADDITIVE** (new table, index, guard functions + triggers, RLS policies; nothing existing altered). Header comment in the style of the 2.2 and 4.3 migrations.
  - Columns: `id uuid pk default gen_random_uuid()`, `employee_id text not null references public.employees (employee_id) on delete restrict`, `role text` and `employer text` (trimmed length 1–200), `period text` (trimmed length 1–60), `detail text not null default ''` (≤ 2000), `created_by uuid null`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `removed_at timestamptz null`. Index on `employee_id`.
  - `employment_history_guard()` (plpgsql, `set search_path = ''`) BEFORE INSERT OR UPDATE. Insert: `created_by := auth.uid()`, `created_at := now()`, `updated_at := now()`, `removed_at := null`. Update: a row with `removed_at` set raises 23514 on any change; a change to `id`, `employee_id`, `created_by` or `created_at` raises 23514; `removed_at` going from null to set is stamped `now()`; `updated_at := now()`.
  - A BEFORE DELETE trigger always raises (binds the service role too). No delete policy.
  - Policies `to authenticated`, one predicate `P` = admin JWT (`(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`) OR own (`exists (select 1 from public.employees e where e.employee_id = employment_history.employee_id and e.auth_user_id = (select auth.uid()))`) OR `public.manages_employee(employee_id)`: `employment_history_select` (using P), `employment_history_insert` (with check P), `employment_history_update` (using P and with check P).
- **Domain** `src/domain/employment-history.ts` (pure) + `tests/employment-history.test.ts`:
  - `EmploymentHistoryInput = { role, employer, period, detail }`; `normalizeEmploymentHistory` (trim; collapse inner whitespace in role/employer/period) and `invalidEmploymentHistoryFields` (role/employer 1–200, period 1–60 and must contain a four-digit year 1900–2099, detail ≤ 2000).
  - `periodStartKey(period)`: a sortable key from the first year in the period, refined by an ISO `YYYY-MM(-DD)` right at that year or a month name/abbreviation (`Mar 2023`, `March 2023`) right before it; missing month/day count as 00.
  - `sortNewestFirst(entries)`: by `periodStartKey` desc, then `createdAt` desc, then `id` desc. Fixture order is preserved (`"2022-02-06 – Present"` before `"2021 – 2022"`).
- **Store** `src/server/employment-history-store.ts` (`createEmploymentHistoryStore({ userClient, scope = managerScope })`, the interviews-store shape, per-request user client only, never the service role):
  - `listFor(session, employeeId?)`: active entries only (`removed_at is null`), each with `employeeId`, sorted newest first per employee; paged with `readAllPages`. Staff: only their own (another id → `[]`, no query). Manager: filtered to `scope.forManager(session).employeeIds` (defence in depth).
  - `add(session, employeeId, input)`, `update(session, id, input)`, `remove(session, id)`. Staff: the subject must equal `session.employeeId`. Manager: the subject must be in scope. Admin: anyone. For `update` and `remove` the subject is read from the target row, never from the form; the write is filtered by `id`, `employee_id` and `removed_at is null`.
  - Typed errors: `EmploymentHistoryForbiddenError`, `EmploymentHistoryNotFoundError` (unknown, removed-and-not-visible, or another employee's for Staff), `EmploymentHistoryRemovedError`, `EmploymentHistoryInvalidError(fields)`, `EmploymentHistoryUnavailableError` (DB or scope failure; 23514 → invalid; 42501 → forbidden).
- **Actions** `src/server/employment-history-actions.ts`: `addEmploymentHistoryAction`, `updateEmploymentHistoryAction`, `removeEmploymentHistoryAction`, each `(prev, form) => ActionState`. `getSession()` first (signed out → sign-in message); zod (messages name the field); then the store; `revalidatePath("/")`.
  - Staff: the employee is always `session.employeeId`; a form `employeeId` naming anyone else → "You can only change your own employment history." with no store call. Admin/manager: `employeeId` is required for add (`^BS-\d{4}$`).
  - Messages: "Employment entry added.", "Employment entry saved.", "Employment entry removed. It is kept in the record's history."; forbidden → "You can only change employment history for yourself or for employees in your department."; not found → "That employment entry was not found."; removed → "That entry was removed and can no longer be changed."; unavailable → "Employment history could not be reached, so nothing was saved. Please try again in a moment."
- **Read path:** `employees-store.ts` takes a new injected `history: Pick<EmploymentHistoryStore, "listFor">` and fills `Employee["history"]` from it for admin, manager and staff reads (a history `Unavailable` error → `EmployeesUnavailableError`, never a profile with missing history). `nestedFor` no longer copies `history`. `Employee["history"]` entries gain `id: string`.
- **Fixture + seed:** `employmentHistorySeedId(employeeId, index)` (`e4b10000-0000-4000-8000-0000<digits><index hex4>`, same shape as `interviewSeedId`) and `employmentHistorySeedRows(list)` in `src/data/employees.ts`; fixture history entries carry those ids. `scripts/seed-employees.ts` inserts them after the employees, insert-only (`onConflict: "id", ignoreDuplicates: true, defaultToNull: false`), so edits and removals survive a re-seed. Update the header comment.
- **UI:** new client component `src/components/employment-history-panel.tsx`, used in the portal's Employment tab (Administrator and manager) and in a new "Employment history" section of the staff portal (`src/components/staff-attendance.tsx`, own record). It renders the existing timeline markup unchanged (`timeline`, `timeline-item`, `timeline-dot`, `small` period, `h3` role, `strong` employer, `p` detail), keyed by `id`, plus, when `canEdit`: an "Add employment entry" form, and per entry "Edit" (inline form with role, employer, period, detail) and "Remove" (a confirm step, like the interview withdraw). Labelled inputs, `aria-label`s on forms, alert/status regions, keyboard operable; entered values kept after a refusal (add-employee-panel's `onSubmit` + `startTransition` pattern). An empty list shows "No employment history has been recorded." The portal heading and "Current role and previous employment." line stay.
- Live DB tests sign each test user in once per file and reuse the session; bulk inserts pass `{ defaultToNull: false }`; test Employee IDs in BS-88xx only (unused elsewhere); throwaway rows cleaned up through the service role.

**Never:**
- No hard delete path; no un-remove; removed entries are not shown in any tab.
- No service-role use on the runtime path; no caller-chosen `employee_id` for Staff; Staff never write another employee's history.
- No audit rows (audit scope is undecided); no change to skills, review, work or attendance (still fixture-read); no "My record" for managers (4.10).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Staff adds own | Staff session, valid entry | Saved for `session.employeeId`; shown newest first | "Employment entry added." |
| Staff edits own | Own active entry | Saved | "Employment entry saved." |
| Staff other employee | Form `employeeId` of someone else, or an entry id of someone else | Rejected, nothing saved (action/store; RLS hides and refuses) | own-history message, or not found |
| Admin edits anyone | Any employee's entry | Saved | — |
| Manager in subtree | Employee in scope: add/edit/remove | Saved | — |
| Manager outside subtree | Employee not in scope | Store refuses without a write; RLS refuses a direct write | forbidden message |
| Remove | Active entry | `removed_at` set; gone from the Employment tab; row kept | removed message |
| Removed entry | Edit or remove again (incl. direct DB update) | Rejected; trigger 23514 | "That entry was removed…" |
| Locked fields | Direct update of `employee_id`/`created_at`/`created_by` | Trigger 23514 | — |
| Delete | Any role incl. service role | Raises; row kept | — |
| Invalid | Blank role/employer/period, period without a year, too long | Rejected at action, store and table checks | field message |
| Ordering | `"2021 – 2022"`, `"Mar 2023 – Present"`, `"2022-02-06 – Present"` | Mar 2023, 2022-02-06, 2021 | — |
| DB down | Read or write fails | Nothing saved; profile shows unavailable, never empty history | unavailable message |
| Seed re-run | Rows exist, edited or removed | No duplicates; edits/removals kept | — |

</intent-contract>

## Code Map

- `supabase/migrations/20261012020000_external_interview_updates.sql` -- guard-trigger + own-predicate pattern to mirror (withdrawn_at ≈ removed_at).
- `supabase/migrations/20261014020000_manager_scope.sql` -- `public.manages_employee(text)`; reuse in policies.
- `supabase/migrations/20261015010000_employee_details_update.sql` -- latest migration; admin JWT expression; header style.
- `src/server/interviews-store.ts` -- store shape (`runMaybe`/`run`, `change()` filtered update, typed errors, `readAllPages`).
- `src/server/interviews-actions.ts` -- action shape, `field()`, `refusal()` mapping, zod `text()` helper.
- `src/server/employees-store.ts` -- `NestedProfile`/`nestedFor` (drop `history`), `toEmployee` (add a `history` argument), `interviewsFor`/`trainingFor` (pattern for `historyFor`), `listForManager`/`getForManager`/admin/staff reads, `EmployeesStoreClients` and the default export wiring at the bottom.
- `src/server/manager-scope.ts` -- `ManagerScope.forManager(session).employeeIds`; `ManagerScopeUnavailableError`.
- `src/data/employees.ts` -- `Employee["history"]` type (line ~12), fixture history (line ~110), `interviewSeedId`/`interviewSeedRows` pattern.
- `scripts/seed-employees.ts` -- insert-only upsert pattern after the employees.
- `src/components/portal.tsx:172` -- current Employment tab markup (keep identical; render the panel).
- `src/components/staff-attendance.tsx` -- staff portal sections (`<section className="panel …" aria-labelledby=…>`), `Feedback`, `InterviewEditor` withdraw confirm pattern; add the Employment history section.
- `src/components/add-employee-panel.tsx` -- form pattern (onSubmit + startTransition).
- `tests/interviews-store.test.ts`, `tests/interviews-actions.test.ts`, `tests/interviews-rls.test.ts`, `tests/employees-store.test.ts`, `tests/components/portal.test.tsx`, `tests/components/staff-attendance.test.tsx`, `tests/e2e/interviews.spec.ts`, `tests/e2e/edit-employee.spec.ts`, `tests/e2e/staff.ts`, `tests/e2e/supabase-admin.ts` -- patterns to extend or mirror. Existing tests that build `employeesStore` with fakes need the new `history` client.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list and write paths.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261015020000_employment_history.sql` -- table, triggers, policies (ADDITIVE).
- `src/domain/employment-history.ts` + `tests/employment-history.test.ts` -- normalise, validate, `periodStartKey`, `sortNewestFirst`.
- `src/data/employees.ts` + `scripts/seed-employees.ts` (+ a fixture test) -- seed ids and rows; insert-only seeding.
- `src/server/employment-history-store.ts` + `tests/employment-history-store.test.ts` -- store with fakes covering the store-owned matrix rows.
- `src/server/employment-history-actions.ts` + `tests/employment-history-actions.test.ts` -- actions, staff own-record rule, messages.
- `src/server/employees-store.ts` + `tests/employees-store.test.ts` -- history from the store; unavailable propagation; fix other fakes.
- `src/components/employment-history-panel.tsx`, `src/components/portal.tsx`, `src/components/staff-attendance.tsx`, `src/app/styles.css` (only if needed, palette variables) + component tests -- timeline unchanged; controls when `canEdit`.
- `tests/employment-history-rls.test.ts` (new, live, skipped without env) -- throwaway departments P > C and unrelated U; employees in C and U (BS-88xx); a Staff account made manager of P; a plain Staff account linked to the C employee; another plain Staff in U; the admin. Through each JWT: own staff adds/edits/removes own; other staff sees none and cannot insert/update the C employee's rows; P manager writes C, not U; admin writes both; removed row update → 23514; delete → error, row kept; anon denied. Cleanup via the service role.
- `tests/e2e/employment-history.spec.ts` (new) -- Administrator adds, edits and removes an entry on a throwaway employee's Employment tab; the removed entry disappears. Cleanup in `finally`.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- the migration and the write path.

**Acceptance Criteria:**
- Given the employee for their own record, or an authorized manager for anyone in their scope, when they add or edit an entry (role, employer, period, detail), then it is saved and shown newest first.
- Given an entry added by mistake, when it is removed, then it disappears from the Employment tab but the row is kept with `removed_at` set.
- Given the demo employment history, when `npm run db:seed` runs, then it is in the table and the Employment tab renders the same entries, in the same order and markup.
- Given a Staff member, when they try to edit another employee's history, then it is rejected at the server and by RLS.

## Spec Change Log

## Review Triage Log

## Design Notes

Ordering: the period stays free text so the migrated demo entries ("2022-02-06 – Present", "2021 – 2022") render exactly as today, which a pair of date columns could not do. "Newest first" is therefore derived from the period's start year (and month/day when written), and validation requires a year so every entry sorts. Removed entries are hidden everywhere in the UI (the story says only that they leave the tab and are kept); restoring or listing them is not asked for.

A manager's own record counts only when it is inside their subtree (the Epic 4 authority rule); "My record" is Story 4.10.

## Verification

**Commands:**
- `npm run typecheck` -- no errors.
- `npm run lint` (if part of `npm run check`) -- clean.
- `npm test` -- all pass, except live DB tests needing the 4.1–4.3, 7.1, 7.2 and 7.3 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205); quote them.
- `npm run build` -- success.
- `npm run test:e2e` with Chromium via a temporary config (`channel: undefined`, `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`; delete it afterwards) -- pass, or fail only with schema-missing errors.
- Optional: apply all migrations to a throwaway local Postgres (as Stories 7.1 and 7.2 did) to exercise the triggers and policies.
