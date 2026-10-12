---
title: 'Story 2.2 — Staff updates or withdraws an interview'
type: 'feature'
created: '2026-10-12'
baseline_revision: '1aaec7db2639e33e301e51d7be45d195c3143add'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** After Story 2.1, staff can add an external interview but cannot record what happened next (stage, outcome, feedback) or withdraw an entry added by mistake, and nothing stops company, role or date from being changed at the database.

**Approach:** An ADDITIVE migration adds `external_interviews.withdrawn_at`, an own-row UPDATE policy, and a trigger that locks company/role/date/employee and makes withdrawn rows immutable. `interviews-store` gains `update` and `withdraw` (author-only, staff-only), `interviews-actions` gains zod-validated `updateInterviewAction` / `withdrawInterviewAction`, and the staff portal and Administrator views split active from withdrawn entries.

## Boundaries & Constraints

**Always:**
- Only `stage` (required, 1–200), `outcome` (≤200) and `feedback` (≤2000) are editable, by the author only (session employee = row employee), only while the entry is not withdrawn.
- Company, role and date are rejected if submitted to the update action, never passed by the store, and refused by the DB trigger for everyone (including the service role).
- Withdraw sets `withdrawn_at` once; a withdrawn row can never be changed again (store + trigger). No hard delete; no DELETE policy.
- Withdrawn entries leave active views (staff list, Administrator profile Interviews list, org-wide "Interviews & placements", "Upcoming interviews" stat) and appear in a "Withdrawn" history list labelled "Withdrawn" in the staff portal and the Administrator profile Interviews tab.
- Administrator stays read-only: store rejects admin updates/withdrawals, RLS has no admin update policy, no edit controls in admin views.
- Another staff member's entry (or an unknown id) → store `InterviewNotFoundError`; the action reports "not found or not yours" without saving.
- Every query uses `getUserClient()`; failures raise `InterviewsUnavailableError`, never a success message.
- RLS predicate stays employee-or-admin only; the UPDATE policy uses exactly the own-employee predicate (`employees.auth_user_id = auth.uid()`).

**Never:**
- No Administrator edit path (deferred to Epic 7). No delete path. No un-withdraw.
- Do not alter the 2.1 migration file or any existing policy (migration must be ADDITIVE).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Update | Author submits id + stage/outcome/feedback | Saved; "Interview updated." | None |
| Locked field | Form also has company/role/date | Nothing saved; "Company, role and date can't be changed…" | `{ error }` |
| Invalid | Empty stage, too-long feedback, non-uuid id | Nothing saved; field message | zod → `{ error }` |
| Other staff's entry | id of BS-1008's interview | Nothing saved; not found/not yours | `InterviewNotFoundError` → `{ error }` |
| Withdrawn entry | update/withdraw a withdrawn id | Nothing saved; "already withdrawn" | `InterviewWithdrawnError` → `{ error }` |
| Withdraw | Author withdraws | `withdrawn_at` set; leaves active views; in Withdrawn history; "Interview withdrawn." | None |
| Corrected entry | Add after withdraw | New entry active; withdrawn one unchanged | None |
| Admin | Admin session calls update/withdraw | Nothing saved; sign-in-as-staff error | `InterviewsForbiddenError` |
| DB down | Read/update fails | "…nothing was saved…" | `InterviewsUnavailableError` |

</intent-contract>

## Code Map

- `supabase/migrations/20261012010000_external_interviews.sql` -- 2.1 table + select/insert policies (read-only; mirror policy style). New file sorts after it.
- `src/server/interviews-store.ts` -- `createInterviewsStore`, `run()` error mapping (null data → unavailable), `COLUMNS`, `toInterview`, `InterviewsForbiddenError`. Add `withdrawn_at` to COLUMNS/row; add `update`, `withdraw`, `InterviewNotFoundError`, `InterviewWithdrawnError`; needs a maybe-null read helper (`maybeSingle`).
- `src/server/interviews-actions.ts` -- `text()` zod helper, `field()`, `SIGN_IN`/`UNAVAILABLE`, `ActionState`; add the two actions alongside `addInterviewAction`.
- `src/data/employees.ts:12` -- interview item type; add `withdrawn: boolean`; fixture items `withdrawn: false`; `interviewSeedRows` unchanged (column default null).
- `src/server/employees-store.ts:76` -- `interviewsOf` strips `employeeId`; passes `withdrawn` through unchanged.
- `src/components/staff-attendance.tsx:173-210` -- External interviews section; table of `employee.interviews`; add per-entry editor (own `useActionState` per entry → small child component) and Withdrawn history.
- `src/components/portal.tsx:40,65,70,73` -- `interviews` flat list (org-wide + stat), profile Interviews tab; filter active, add Withdrawn history in the tab.
- `tests/interviews-store.test.ts` -- `fakeClient` builder (add `update`, `is`, `maybeSingle`); `COLUMNS` constant must include `withdrawn_at`.
- `tests/interviews-actions.test.ts`, `tests/components/staff-attendance.test.tsx`, `tests/components/portal.test.tsx`, `tests/employees-store.test.ts`, `tests/fixture-interviews.test.ts` -- extend for new fields/behaviour.
- `tests/interviews-rls.test.ts` -- "lets nobody signed in update or delete interviews" becomes: author updates editable fields; others/admin/manager update nothing; locked fields refused; nobody deletes.
- `tests/e2e/interviews.spec.ts` -- 2.1 flow; add a 2.2 test (update, withdraw, admin sees withdrawn history).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261012020000_external_interview_updates.sql` -- ADDITIVE: `add column withdrawn_at timestamptz null`; function `external_interviews_guard()` + `before update` trigger raising (errcode `check_violation`-style, e.g. `23514`) when `id`, `employee_id`, `company`, `role`, `interview_date` or `created_at` change, when `old.withdrawn_at is not null`; policy `external_interviews_update_own` for update to authenticated using/with check own-employee predicate.
- `src/data/employees.ts` -- `withdrawn: boolean` on interviews; fixture `false`.
- `src/server/interviews-store.ts` -- map `withdrawn_at` → `withdrawn`; `update(session, id, { stage, outcome, feedback })`, `withdraw(session, id)`: staff-only (Forbidden), reject any extra locked key (`InterviewLockedError`), read row by id (null or other employee → NotFound; withdrawn → Withdrawn), update filtered by `id`, `employee_id = session`, `withdrawn_at is null`, return mapped row; zero rows → NotFound.
- `src/server/interviews-actions.ts` -- `updateInterviewAction`, `withdrawInterviewAction` (zod: uuid id; editable fields; reject presence of company/role/date before the store); revalidate `/`.
- `src/components/staff-attendance.tsx` -- active table shows feedback; per active entry an "Update" `<details>` with labelled Stage/Outcome/Feedback form and a "Withdraw interview" form; Withdrawn history list with "Withdrawn" label.
- `src/components/portal.tsx` -- active-only for org-wide list, stat, profile list; profile tab adds "Withdrawn (history)" with a "Withdrawn" badge; no controls.
- Tests -- offline store/actions/component tests for every matrix row; live RLS update cases; e2e update-and-withdraw flow.
- `docs/DEPLOYMENT.md` -- list the new migration in apply order (after 2.1's).

**Acceptance Criteria:**
- Given an interview the employee added, when they change stage, outcome or feedback in the staff portal, then the change is saved and shown.
- Given an existing entry, when anyone (author, Administrator, or service role) tries to change company, role or date, then it is rejected (action, store and DB trigger).
- Given the author withdraws an entry, then it disappears from both active views but stays in history labelled "Withdrawn", still visible to the Administrator.
- Given a withdrawn entry, when the employee adds a corrected entry, then the new one is saved normally and the withdrawn one is unchanged and cannot be edited.
- Given another Staff member's entry, when someone edits or withdraws it, then the server rejects it (store NotFound; RLS updates zero rows).
- Given a Staff-authored entry, when the Administrator views it, then no edit or withdraw control is offered and admin writes are refused.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 26 findings — high 0, medium 6, low 14, false 6, maybe-false 0
- findings:
  - `low` `patch` (verification-gap) Trigger branch "unchanged update of a withdrawn row passes" untested — live withdraw test now issues a same-value service-role update and asserts no error and an unchanged row.
  - `medium` `patch` (verification-gap other) "Interview withdrawn." lives in the per-row editor that unmounts after revalidate — withdraw action state and its status message hoisted to the External interviews section.
  - `medium` `patch` (blind) Withdraw success message never shown — same root cause and fix as above.
  - `low` `reject` (blind) No confirm step before withdraw — the mistake is recoverable by adding a corrected entry (the story's own flow); a confirm adds a branch.
  - `low` `patch` (blind) withdrawn_at chosen by the client/app clock; author can set any time via PostgREST — trigger now forces `new.withdrawn_at := now()` on withdrawal; live test asserts a forged 2000-01-01 is replaced.
  - `false` `reject` (blind) A withdrawing UPDATE can also rewrite stage/outcome/feedback — the author may edit those fields anyway immediately before withdrawing; no state is reachable that two legal calls cannot produce.
  - `low` `reject` (blind) Absent outcome/feedback in a crafted form clears stored values — the UI always submits all three fields and only the author's own entry is affected; requiring presence adds branches.
  - `low` `reject` (blind) Trigger 23514 reported as "unavailable" — the store pre-checks lock, ownership and withdrawal, so this needs a race; mapping adds a branch.
  - `medium` `patch` (blind) db:seed re-run silently overwrites staff edits to seeded interviews — seed now inserts interviews with `ignoreDuplicates` (never updates existing rows); DEPLOYMENT.md updated.
  - `low` `reject` (blind) Withdrawal date / edit audit trail not shown — not required by any AC; would need new schema.
  - `low` `reject` (blind) Staff and Administrator withdrawn histories differ (feedback, hand-built badge) — cosmetic.
  - `low` `reject` (blind) No phone-width rule for the wider table and editor — the table already sits in `.table-scroll`; cosmetic.
  - `low` `patch` (blind) No tests for direct-PostgREST withdrawn_at forging — covered by the withdrawn_at patch's live assertion.
  - `false` `reject` (blind) E2E withdrawn rows never cleaned up — tests/e2e/global-teardown.ts deletes the throwaway employees' interviews (service role) before the employees.
  - `medium` `patch` (edge) Withdraw message unmounts — same root cause as the verification-gap other finding; fixed there.
  - `low` `reject` (edge) Row withdrawn between pre-read and update reported as "not found" — a two-tab race; nothing is saved either way.
  - `low` `reject` (edge) Absent form fields default to "" — same as the blind finding.
  - `low` `patch` (edge) Author can set withdrawn_at to any timestamp — fixed by the trigger `now()` patch.
  - `low` `patch` (edge) withdrawn_at from the app server clock — fixed by the same trigger patch.
  - `medium` `patch` (edge) db:seed reverts staff edits on seeded interviews — fixed by insert-only seeding.
  - `medium` `patch` (edge) One edited+withdrawn seeded row fails the whole seed batch (23514) — fixed by insert-only seeding (no UPDATE is issued).
  - `false` `reject` (edge) Store accepts an empty stage — the only caller (updateInterviewAction) validates with zod first and the DB check refuses it; the store never reports it as saved.
  - `low` `reject` (edge) An active entry whose free-text outcome is "Withdrawn" gets the grey badge — the label text is still exactly what the employee wrote; cosmetic.
  - `false` `reject` (intent) Staff-visible withdrawn history goes beyond AC3 — the AC only requires leaving active views; Design Notes record the choice; hiding an employee's own record serves no privacy purpose.
  - `false` `reject` (intent) AC4 (corrected entry) not exercised through the UI — the add flow is unchanged from 2.1 (its e2e covers it) and the live suite asserts the withdrawn row is byte-identical after a corrected add.
  - `false` `reject` (intent) DB-level guarantees verified only by live suites — environment limit (migration applied by a human), not a code gap; offline tests cover action/store/UI layers.

## Design Notes

Locking uses a trigger rather than column-level `REVOKE UPDATE` so the migration stays ADDITIVE (revoking existing grants would tighten something existing) and also covers the service role. `withdrawn_at` (not a boolean) records when; the UI only needs `withdrawn`. Staff see their own withdrawn entries in history too: the AC only requires they leave active views, and hiding an employee's own record from them would serve no privacy purpose.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean
- `npm test` -- expected: pass, except live suites touching `external_interviews` (schema-missing only: PGRST205 / 42703 / PGRST204 until both interview migrations are applied)
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, except flows reading interviews (schema-missing only)

## Auto Run Result

Status: done

**Summary:** Staff can update the stage, outcome and feedback of their own interviews and withdraw an entry. Company, role and date are locked at four layers: the UI doesn't offer them, the action rejects them, the store refuses them, and a DB trigger enforces the lock for every role. Withdrawn entries leave the active views (staff table, Administrator profile list, "Interviews & placements", "Upcoming interviews" stat). They stay in a read-only "Withdrawn (history)" list with a "Withdrawn" label for both staff and the Administrator. The Administrator remains read-only.

**Files changed:**
- migration `20261012020000_external_interview_updates.sql` (ADDITIVE): `withdrawn_at` column, guard trigger (locks fields, freezes withdrawn rows, stamps `now()`), own-row UPDATE policy
- `src/server/interviews-store.ts`: `update`, `withdraw`, and the NotFound, Withdrawn and Locked errors
- `src/server/interviews-actions.ts`: `updateInterviewAction`, `withdrawInterviewAction`
- `src/components/staff-attendance.tsx`: per-entry editor, section-level withdraw status, Withdrawn history
- `src/components/portal.tsx`: active-only views, Withdrawn history in the profile
- `src/data/employees.ts`: `withdrawn` flag
- `scripts/seed-employees.ts`: interviews are insert-only
- `src/app/styles.css`
- `docs/DEPLOYMENT.md`
- tests: store, actions, components, fixture, live RLS, e2e

**Review:**
- 26 findings, 0 high.
- 4 entries patched (2 medium, 2 low):
  - the withdraw message unmounted with its row;
  - db:seed overwrote staff edits and could fail on withdrawn rows;
  - the DB now stamps `withdrawn_at`;
  - an untested no-op branch in the trigger.
- 0 deferred, 16 rejected. The reasons are in the triage log.

**Follow-up review recommended:** true. Two medium entries were patched on a first pass. The named unverified risk is that the RLS policy and the trigger have not run against the shared project.

**Verification:**
- `npm run typecheck`: clean.
- `npm run build`: succeeds.
- `npm test`: 413 passed. Only 8 live tests in `tests/interviews-rls.test.ts` fail, all with schema-missing errors (42703 `column external_interviews.withdrawn_at does not exist` / PGRST204).
- `npm run test:e2e` with the installed Chromium (the configured msedge channel is not available here): 8 passed. 8 failed, every one because employee reads fail with 42703 on `withdrawn_at`.
- Both interview migrations were applied to a throwaway local Postgres 16 with auth stand-ins. Results:
  - the author can update their own row;
  - other staff and deletes affect 0 rows;
  - a forged `withdrawn_at` is replaced by `now()`;
  - a no-op update of a withdrawn row passes;
  - an edit or un-withdraw of a withdrawn row, and a company change, are refused (23514).

**Residual risk:** none of this has run against the shared project. After the migration is applied, re-run `npm test` and `npm run test:e2e`.
