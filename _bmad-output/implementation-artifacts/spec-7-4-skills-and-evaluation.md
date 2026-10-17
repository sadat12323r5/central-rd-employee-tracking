---
title: "Story 7.4: Record skills assessments and the manager evaluation"
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: 'bac1e0c1d3cfa287242c0c5c10193980a8b0f2ea'
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

**Problem:** Skills ratings and the manager evaluation (strengths, development priorities, readiness) are hard-coded in `src/data/employees.ts`: nobody can record a current assessment, so readiness decisions rest on stale demo text.

**Approach:** Two new tables (`employee_skills`, `employee_evaluations`) with select-only RLS, written only through two SECURITY DEFINER functions that check authority (Administrator, or `manages_employee`), as Story 7.2 does. A new `assessments-store` reads (role-scoped) and writes through the user's JWT; `employees-store` merges skills and the evaluation from it instead of the fixture. Authorized managers rate skills and edit the evaluation on the profile's Skills & evaluation tab; Staff see their own read-only in the staff portal. The seed moves the demo data into the tables.

## Boundaries & Constraints

**Always:**
- **Migration** `supabase/migrations/20261015030000_skills_and_evaluation.sql`, ADDITIVE (two new tables, indexes, select policies, two functions, grants). Header comment style as in `20261015010000_employee_details_update.sql`.
  - `public.employee_skills`: `id uuid pk default gen_random_uuid()`, `employee_id text not null references public.employees(employee_id) on delete restrict`, `name text not null` (trimmed 1–80), `level smallint not null check (level between 1 and 5)`, `evidence text not null` (trimmed 1–300), `updated_by uuid` (null for seeded rows), `created_at`/`updated_at timestamptz not null default now()`. Unique index `employee_skills_employee_name_key` on `(employee_id, lower(name))` (the skill identifier, case-insensitive).
  - `public.employee_evaluations`: `employee_id text primary key references public.employees(employee_id) on delete restrict` (one evaluation per employee), `strengths` and `development_priorities text not null` (trimmed 1–1000), `readiness text not null` (trimmed 1–120), `reviewer text not null` (1–200), `reviewed_on date not null`, `updated_by uuid`, `updated_at timestamptz not null default now()`.
  - RLS enabled on both; for each, three select policies: admin (`auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'`), own (`employees.auth_user_id = (select auth.uid())`), managed (`public.manages_employee(employee_id)`). No insert/update/delete policies.
  - `public.rate_employee_skill(p_employee_id text, p_name text, p_level integer, p_evidence text) returns text` and `public.update_employee_evaluation(p_employee_id text, p_strengths text, p_development_priorities text, p_readiness text) returns text`: `plpgsql`, `security definer`, `set search_path = ''`, fully qualified; execute revoked from `public, anon`, granted to `authenticated`. Order, as in 7.2: no `auth.uid()` → `not_authorized`; caller's own employee row archived → `not_authorized`; not admin and not `manages_employee(p_employee_id)` → `not_authorized` (before any lookup); values trimmed with inner whitespace collapsed, out-of-range length or level not an integer 1–5 → `invalid_input`; employee missing → `employee_not_found`; then write and return the employee's name. Errors `errcode = 'P0001'`.
  - `rate_employee_skill` inserts, or on conflict `(employee_id, lower(name))` updates `level`, `evidence`, `updated_by = auth.uid()`, `updated_at = now()` (keeping the stored name).
  - `update_employee_evaluation` upserts on `employee_id`, setting the three texts, `reviewed_on = (now() at time zone 'Asia/Dhaka')::date`, `updated_by = auth.uid()`, `updated_at = now()`, and `reviewer` = the author from the session: the caller's linked employee name followed by ` · Administrator` (admin) or ` · Department manager` (manager); an Administrator with no linked employee is `Administrator`.
- **Domain** `src/domain/assessment-input.ts` (pure): `SKILL_NAME_MAX = 80`, `SKILL_EVIDENCE_MAX = 300`, `READINESS_MAX = 120`, `EVALUATION_TEXT_MAX = 1000`, `SKILL_LEVELS = [1,2,3,4,5]`; `normalizeSkillRating`/`invalidSkillRatingFields` and `normalizeEvaluation`/`invalidEvaluationFields` (reuse `normalizeText` from `employee-input.ts`).
- **Store** `src/server/assessments-store.ts`, per-request user client only (never service role), following training-store's shape:
  - `listFor(session, employeeId?)` → `{ skills: SkillEntry[]; evaluations: EvaluationEntry[] }`. Admin: all (or the one id); staff: only `session.employeeId` (another id → empty, no query); manager: only ids in `scope.forManager(session).employeeIds` (out of scope → empty, no query; scope failure → `AssessmentsUnavailableError`). Paged with `readAllPages`. Skills ordered `level desc, name asc` per employee (strongest first, so the directory's "Core skills" shows the top two). Any read error → `AssessmentsUnavailableError`.
  - `rateSkill(session, employeeId, input)` and `saveEvaluation(session, employeeId, input)`: Staff → `AssessmentForbiddenError` with no rpc; manager out of scope → `AssessmentForbiddenError` with no rpc; invalid input → `AssessmentValidationError(fields)`; rpc errors mapped `not_authorized` → forbidden, `invalid_input` → validation `["input"]`, `employee_not_found` → `AssessmentNotFoundError`, else unavailable. Return `{ employeeId, name }`.
- **employees-store** gets an injected `assessments: Pick<AssessmentsStore, "listFor">` (default the real store). Skills and `review` come from it (evaluation → `review: { date: reviewed_on, reviewer, readiness, strengths, next: development_priorities }`; none → all-empty review); `AssessmentsUnavailableError` → `EmployeesUnavailableError` (never a profile with missing assessments). `nestedFor` no longer returns skills or review from the fixture.
- **Actions** `src/server/assessment-actions.ts`: `rateSkillAction` and `saveEvaluationAction` (`ActionState`). `getActor()`; only admin/manager, else "Only an Administrator or a department manager can change skills or the evaluation." before any store call. Zod: `employeeId` `^BS-\d{4}$`, skill name, level (integer 1–5 from the form string), evidence; strengths, development priorities, readiness — messages name the field. Success: `revalidatePath("/")`, "<Skill> was rated <n> out of 5 for <Name>." / "<Name>'s evaluation was saved." Errors: forbidden → manager "You can only assess employees in your own department or its sub-departments.", admin → unavailable; not found → "Choose an existing employee."; else "Skills and evaluations are temporarily unavailable. Nothing was changed."
- **UI** (`src/components/portal.tsx` Skills & evaluation tab): for `admin` and `manager`, add `src/components/skill-rating-panel.tsx` (skill name with a `datalist` of existing names, level select 1–5 with the scale labels, evidence textarea; `aria-label="Rate a skill"`) and `src/components/evaluation-panel.tsx` (strengths and development priorities textareas, readiness input, prefilled; `aria-label="Edit evaluation"`), following employee-details-panel's onSubmit + startTransition pattern, alert/status regions, keyed per employee and current values. Empty states: "No skills assessed yet." and "No evaluation recorded yet." (also on the Overview "Development snapshot", which must not render a blank date). Staff portal (`src/components/staff-attendance.tsx`): a read-only "Skills & evaluation" section with the same content and no forms.
- **Seed** (`scripts/seed-employees.ts`, insert-only, idempotent): after training, insert fixture skills whose `(employee_id, lower(name))` does not already exist (read existing for fixture ids first), and fixture evaluations with `upsert(..., { onConflict: "employee_id", ignoreDuplicates: true })`. Row builders `skillSeedRows(employees)` and `evaluationSeedRows(employees)` in `src/data/employees.ts` (reviewer and date from the fixture). `updated_by` null.
- Live DB tests sign each test user in once per file; bulk inserts pass `{ defaultToNull: false }`. Test Employee IDs BS-86xx only.

**Never:**
- No runtime read of skills or review from `src/data/employees.ts`; no service-role use on the runtime path.
- No hard delete; no skill removal feature (not asked for). No audit rows (not decided for these changes).
- No insert/update/delete policy on the new tables; no change to existing tables, policies or functions.
- No change to who sees interviews, training or basic details.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin rates a new skill | Any employee, name, level 4, evidence | Row inserted; shown on the tab | — |
| Re-rate same skill, other case | "react" when "React" exists | Same row updated (level, evidence); name kept | — |
| Manager in subtree | Rates skill / saves evaluation | Saved; reviewer "<Name> · Department manager" | — |
| Manager outside subtree | Out-of-scope employee | Store refuses, no rpc; function `not_authorized` | scope message |
| Staff, incl. own record | Action, or direct rpc / table write | Action refuses before store; function `not_authorized`; table insert/update denied by RLS | "Only an Administrator…" |
| Invalid input | Level 0/6/"3.5", blank name/evidence/texts, over-length | Rejected at action, store and function | field message |
| Unknown employee | Admin, non-existent id | Rejected | "Choose an existing employee." |
| Archived caller | Manager whose own row is archived | `not_authorized` | — |
| No evaluation yet | Employee without a row | Tab and snapshot say "No evaluation recorded yet." | — |
| Reads by role | Admin / manager / staff / other staff | All / subtree / own only / nothing of others | — |
| DB down | Read or rpc fails | Profile unavailable (read) / nothing changed (write) | unavailable message |

</intent-contract>

## Code Map

- `supabase/migrations/20261015010000_employee_details_update.sql` -- function template to mirror (checks order, grants, header).
- `supabase/migrations/20261014020000_manager_scope.sql` -- `manages_employee(text)`; `*_select_managed` policy style.
- `supabase/migrations/20261012030000_training_history.sql` -- table + admin/own select policy style.
- `src/domain/employee-input.ts` -- `normalizeText`, `TEXT_FIELD_MAX`, invalid-fields pattern.
- `src/server/training-store.ts` -- role-scoped `listFor` with manager-scope and `readAllPages`; error class style. Mirror it for `assessments-store`.
- `src/server/employees-store.ts` -- `nestedFor` (stop returning skills/review), `toEmployee` (add skills/review params), `trainingFor` wrapper pattern, `listForManager`/`getForManager`/`listFor`/`getFor`, `detailsRefusal` mapping, `createEmployeesStore` injection + default export at the bottom.
- `src/server/employee-actions.ts` -- action shape, `text()` zod helper, role-dependent forbidden mapping.
- `src/components/employee-details-panel.tsx` -- client form pattern to mirror.
- `src/components/portal.tsx:171` (Overview snapshot) and `:174` (Skills & evaluation tab) -- render sites; `role`, `isManager`, `selected`.
- `src/components/staff-attendance.tsx` -- staff portal sections (`panel staff-training` style); add the read-only section.
- `src/data/employees.ts` -- `skills`/`review` fixture data; `trainingSeedRows` as the seed-builder pattern.
- `scripts/seed-employees.ts` -- add the two seed steps after training.
- Tests to mirror/extend: `tests/training-store.test.ts`, `tests/employees-store.test.ts`, `tests/employee-actions.test.ts`, `tests/employee-details-rls.test.ts`, `tests/components/employee-details-panel.test.tsx`, `tests/components/portal.test.tsx`, `tests/components/staff-attendance.test.tsx`, `tests/fixture-training.test.ts`, `tests/e2e/edit-employee.spec.ts`.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list and write paths.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261015030000_skills_and_evaluation.sql` -- tables, index, policies, functions, grants (ADDITIVE).
- `src/domain/assessment-input.ts` + `tests/assessment-input.test.ts` -- normalisation and validation.
- `src/server/assessments-store.ts` + `tests/assessments-store.test.ts` -- reads by role, writes, refusal mapping (fakes).
- `src/server/employees-store.ts` + `tests/employees-store.test.ts` -- merge from assessments; unavailable propagation; fixture no longer the source.
- `src/server/assessment-actions.ts` + `tests/assessment-actions.test.ts` -- role gate, zod, messages.
- `src/components/skill-rating-panel.tsx`, `src/components/evaluation-panel.tsx`, `src/components/portal.tsx`, `src/components/staff-attendance.tsx` (+ `src/app/styles.css` if needed) + component tests -- panels for admin/manager only, empty states, staff read-only.
- `src/data/employees.ts`, `scripts/seed-employees.ts` + `tests/fixture-assessments.test.ts` -- seed rows (every fixture employee's skills and evaluation, valid against the table checks).
- `tests/assessments-rls.test.ts` (new, live, skipped without env) -- throwaway departments P > C and unrelated U; employees in C and U (BS-86xx); a Staff account managing P; a plain Staff account linked to the C employee; the admin. Through each JWT: admin and P manager rate a skill and save an evaluation for the C employee (re-rate with different case updates one row; reviewer label correct); P manager on U → `not_authorized`; plain Staff on own record → `not_authorized`, and a direct insert into either table is refused; `invalid_input` for level 6 and blank evidence; reads: Staff sees own rows only, manager sees C not U; anon → permission denied. Cleanup via service role.
- `tests/e2e/skills-evaluation.spec.ts` (new) -- admin opens a throwaway employee's Skills & evaluation tab, rates a skill and saves an evaluation, sees both on the tab. Cleanup in `finally`.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- the migration, the write paths, the seed step.

**Acceptance Criteria:**
- Given an authorized manager, when they rate a skill (1–5 with evidence) or update the evaluation summary, then it is saved and shown on the Skills & evaluation tab.
- Given a Staff session, when it tries to change skills or the evaluation, including its own, then it is rejected at the server; the employee sees them read-only.
- Given the demo skills and evaluation data, when this story ships, then `npm run db:seed` moves them into the database, and runtime code no longer reads skills or the evaluation from `src/data/employees.ts`.

## Spec Change Log

## Review Triage Log

### 2026-10-14 — Review pass
- verdicts: 20 findings — high 0, medium 1, low 13, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: a manager can assess their own record when it sits in a department they manage — the epic defines "authorized manager" by subtree only, the same rule Story 7.2 kept for basic details; a self-assessment guard needs a System Owner decision, recorded in deferred-work.md.
  - `[low]` `[reject]` Blind: the re-rate confirmation echoes the typed case ("REACT") while the list keeps "React" — cosmetic; the fix changes the function's return shape.
  - `[false]` `[reject]` Blind: a misspelled skill can never be renamed or removed — the story asks only to rate skills; no removal is in scope (recorded in deferred-work.md).
  - `[low]` `[reject]` Blind: picking an existing skill does not prefill its level and evidence — UX nicety; the current values are shown in the list right above the form.
  - `[low]` `[reject]` Blind: evaluation saves are last-write-wins — same call as Story 7.2's free-text fields; a conflict token adds a parameter and state for a rare case (recorded in deferred-work.md).
  - `[low]` `[patch]` Blind: the default assessments store ignored the injected `scope`/`userClient` — `createEmployeesStore` now defaults to `createAssessmentsStore({ userClient, scope })`. The double scope read for managers is rejected: training-store does the same, and it costs one extra query.
  - `[low]` `[reject]` Blind: archived employees' assessments stay editable — same decision as Story 7.2 (records are kept, correcting them is harmless).
  - `[false]` `[reject]` Blind: no manager or Staff e2e — the manager path and Staff refusals run against the database in tests/assessments-rls.test.ts (CI supplies the secrets); the Staff read-only view is covered by component tests.
  - `[low]` `[patch]` Blind: new tables keep default write grants (TRUNCATE is not governed by RLS) — migration now revokes insert, update, delete, truncate from anon and authenticated, as audit_events does.
  - `[low]` `[patch]` Blind: the defence-in-depth filter is quadratic, and employees with no skills show an empty "Core skills" cell — filter now uses a Set; the empty cell is rejected as cosmetic (it was already empty for fixture-less employees).
  - `[low]` `[reject]` Blind: seeded reviewer labels ("Ayesha Karim · L&D Manager") differ from saved ones — demo data; rewriting it would break the insert-only seed rule.
  - `[low]` `[reject]` Blind: the skill form does not clear after a save that changes nothing — the inputs keep the values just saved and the success message shows; cosmetic.
  - `[low]` `[reject]` EdgeCase: stale evaluation form overwrites a newer one — duplicate of the last-write-wins row.
  - `[low]` `[reject]` EdgeCase: manager self-assessment — duplicate of the first row.
  - `[low]` `[reject]` EdgeCase: archived targets writable — duplicate of the archived row.
  - `[false]` `[reject]` EdgeCase: zero-width-only names/evidence — exotic input with no realistic caller; Story 7.2 rejected the same class.
  - `[false]` `[reject]` EdgeCase: confirmation names the typed case — duplicate of the second row (cosmetic).
  - `[medium]` `[patch]` VerificationGap: the seed's skip-existing filter was only checked by source-text regexes — moved into the pure helper `missingSkillSeedRows` in src/data/employees.ts, used by the seed, with three unit tests (different case skipped, new kept, other employee's same name not suppressing).
  - `[false]` `[reject]` Intent: evaluation history (R1b) not implemented — the story says "update the evaluation summary"; one current summary is the direct reading.
  - `[false]` `[reject]` Intent: the staff-portal read-only section goes beyond the named tab — AC2 says "employees see these read-only", and the staff portal is where employees see their record.

## Design Notes

Functions instead of insert/update policies (as in 7.2): the author (`updated_by`, `reviewer`) and date must come from the session, not the client, and RLS cannot stop a caller forging them or re-pointing `employee_id`. Skill names are unique per employee case-insensitively, so "rate a skill" is an upsert. Ordering skills strongest first is a display choice; the epic does not fix an order for this tab.

## Verification

**Commands:**
- `npm run typecheck` -- no errors.
- `npm run lint` (if part of `npm run check`) -- clean.
- `npm test` -- all pass, except live DB tests needing the unapplied 4.1–4.3, 7.1, 7.2 and 7.4 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205); quote them.
- `npm run build` -- success.
- `npm run test:e2e` with Chromium via a temporary config (`channel: undefined`, `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`; delete it afterwards) -- pass, or fail only with schema-missing errors.
- Optional: apply all migrations to a throwaway local Postgres (as 7.2 did) and exercise both functions.

## Auto Run Result

Status: done

**Summary:** Skills ratings and the manager evaluation now live in the database. The Administrator (anyone) and department managers (their subtree) rate a skill (1–5 with evidence; same name in any case updates it) and edit the evaluation summary on the profile's Skills & evaluation tab. Writes go only through two SECURITY DEFINER functions, which take the author and the date from the session. Staff are refused at the action, the store and the database, and see their own skills and evaluation read-only in the staff portal. `npm run db:seed` moves the demo data in; runtime code no longer reads skills or the review from `src/data/employees.ts`.

**Files changed:**
- `supabase/migrations/20261015030000_skills_and_evaluation.sql`: two tables, select-only RLS, write grants revoked, two functions (ADDITIVE).
- `src/domain/assessment-input.ts`: limits, normalisation, validation.
- `src/server/assessments-store.ts`, `src/server/assessment-actions.ts`: role-scoped reads, writes, refusal mapping, actions.
- `src/server/employees-store.ts`: skills and review merged from assessments-store.
- `src/components/skill-rating-panel.tsx`, `evaluation-panel.tsx`, `assessment-summary.tsx`, `portal.tsx`, `staff-attendance.tsx`, `src/app/styles.css`: forms for admin/manager, empty states, staff read-only section.
- `src/data/employees.ts`, `scripts/seed-employees.ts`: seed rows and the insert-only seed step.
- Tests: new input, store, action, fixture, panel, live RLS (BS-86xx) and e2e (`tests/e2e/skills-evaluation.spec.ts`) tests; extended employees-store, portal and staff-attendance tests; three live suites wired to a real assessments store.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`.

**Review:** 20 findings: 1 medium, 13 low, 6 false.
- **Patched (4):** medium: seed filter moved to a tested pure helper; low: write grants revoked on the new tables; low: default assessments store uses the injected scope; low: Set-based read filter.
- **Deferred:** none in frontmatter. Two decisions recorded in deferred-work.md: manager self-assessment, and skill rename/removal and evaluation history.
- **Rejected:** all others, with reasons in the triage log.

Follow-up review recommended: false (patched: high 0, medium 1).

**Verification:**
- `npm run typecheck`: pass. `npm run build`: pass.
- `npm test`: 1278 passed, 52 skipped. Five live files fail only with PGRST205 (`public.departments` missing): departments-rls, manager-scope-rls, employee-create-rls, employee-details-rls, assessments-rls.
- `npm run test:e2e` (Chromium): 8 passed, 21 failed, all schema-missing: PGRST205 for `employee_skills`, `employee_evaluations` and `departments`, and 42703 for `employees.department_id`.
- Local Postgres 16 with all migrations (by the implementer, before the grant revoke was added): both functions' authority, validation, case-insensitive re-rate, reviewer labels, Dhaka date, RLS reads and refused direct writes behaved as specified.

**Residual risks:**
- Until migration 20261015030000 is applied, every employee read fails ("Employee records are unavailable"), so the PR must merge only together with the migration (after the 4.1–4.3, 7.1 and 7.2 migrations).
- The revoke line was not run against Postgres.
