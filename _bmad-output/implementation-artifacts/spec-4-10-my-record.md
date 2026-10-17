---
title: 'Story 4.10: Managers use "My record" for their own self-service'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_revision: 'cab115b16487e881b5ae413f341ff344a35188b2'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A manager's own row still appears in their Employees directory with management controls (assignments, transfer).
    evidence: |-
      Self-evaluation is already refused by the store and RLS (4.6). Assignment writes have no own-record exclusion (4.5, assignments_insert_authorized / assignments-store authorize), and 4.8 allows self-transfer by design. An exclusion or a redirect of the self row to "My record" is a product decision outside this story.
    location: >-
      src/components/portal.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Department managers and Administrators who are also employees cannot clock in, keep a daily log, report interviews, see their training or backfill past projects. The management portal has no self-service, and the attendance and interview actions accept only Staff sessions.

**Approach:**
- An account linked to an employee record (manager, or Administrator) gets a "My record" section in the management portal. It shows the same self-service body as the staff portal, built from the session's own employee id.
- Every own-record read and write runs under the Staff own-record rules. Page code and actions hand the stores a derived `{ role: "staff", employeeId }` identity.
- RLS is already keyed on `employees.auth_user_id = auth.uid()`, so no migration is needed.

## Boundaries & Constraints

**Always:**
- **Session** (`src/server/session.ts`, `src/server/auth.ts`):
  - The admin identity becomes `{ role: "admin"; employeeId?: string }`.
  - `supabaseSession` sets `employeeId` on an admin identity only when exactly one non-archived `employees` row has `auth_user_id = user.id`. It gets the id through a new `employeesStore.linkedEmployeeId(userId)`, an RLS-scoped user-client read that returns the id or null.
  - A read error leaves the admin identity unlinked (logged). It never ends the session.
  - The manager identity already carries `employeeId`, and the staff identity is unchanged.
- **Own-record identity:** `ownRecordIdentity(session)` in `session.ts` (pure). It returns `{ role: "staff", employeeId }` for a staff session, for a manager, and for an admin that has `employeeId`; otherwise null.
- **Actions:** each one takes the employee only from `ownRecordIdentity(await getSession())`, and refuses with its existing sign-in message when that is null.
  - `attendance-actions.ts` `staffId()`.
  - `interviews-actions.ts` add, update and withdraw. They call the interviews store with the derived staff identity, so the store's staff-only checks apply unchanged.
  - `backfill-actions.ts` already accepts any session with an `employeeId`; it is left as is.
- **Page** (`src/app/page.tsx`): in the manager and admin branches, when `ownRecordIdentity(session)` is non-null, it builds `myRecord = { employee, entries, serverNow, current, departmentOptions }` using only the derived staff identity:
  - `employee`: `employeesStore.getFor(own, own.employeeId)`;
  - `entries`: `attendanceStore.listFor(own, id)`;
  - `current`: `currentTraining(own, [id])`;
  - `departmentOptions`: the existing `departmentOptionsFor()`.
  - It is passed to `Portal` as an optional `myRecord` prop. `myRecord.employee` keeps the user's own interviews: it is their own record. The manager branch's `withoutInterviews` still applies to the `employees` list.
  - If the own employee read returns null, `myRecord` is omitted. A `*UnavailableError` from these reads follows the existing unavailable pages.
- **Self-service body:** extract the content of `staff-attendance.tsx` (everything inside the page shell) into an exported `StaffSelfService` component with the same props, minus the shell. `StaffAttendance` renders the shell plus `StaffSelfService`, and its output is unchanged.
- **Portal** (`src/components/portal.tsx`): a "My record" nav section and heading appear only when `myRecord` is set. The section renders `StaffSelfService` with `myRecord`'s props. With no `myRecord`, there is no nav entry and no section.

**Never:**
- No migration and no RLS change.
- No service-role reads for My record.
- My record never takes an employee id from a form.
- A manager's own interviews are never added to the `employees` list a manager receives (FR-3; 4.4 stays as is).
- No leave recording (Epic 5).
- No change to evaluation or assignment write rules.
- No own-record exclusion on assignment writes; that is pre-existing 4.5 behaviour, out of scope here.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Manager | Manager session (always linked) | "My record" nav and section with their own attendance, log, interviews (their own included), training, assignments/evaluations read-only, backfill | — |
| Linked Administrator | Admin whose auth user is linked to a non-archived employee row | My record shown for that row | — |
| Unlinked Administrator | No linked row, the row is archived, or the link lookup fails | No "My record" nav or section | Lookup failure is logged; the session stays admin |
| Manager clocks in or saves a log | Manager session | Saved to their own employee id via RLS own policies | Existing attendance messages |
| Manager adds, updates or withdraws an interview | Manager or linked admin session | Saved through the interviews store with `{ role: "staff", employeeId }`; a form `employeeId` is ignored | Existing interview messages |
| Unlinked admin calls an attendance or interview action | Admin with no `employeeId` | Refused before any store call | Existing "sign in" message |
| Evaluations in My record | Own closed assignment with an evaluation | Shown read-only; no write control | — |
| Upper manager views a lower manager's profile | Manager above opens a subordinate manager's profile | No interviews (unchanged 4.4 behaviour) | — |

</intent-contract>

## Code Map

- `src/server/session.ts:1-4` -- the `SessionIdentity` union. Add `employeeId?` to admin, and add `ownRecordIdentity`.
- `src/server/auth.ts:88-136` -- `supabaseSession`. After the staff block (:106-129), an admin branch looks up the linked id. `identityFor` (:49-56) is unchanged.
- `src/server/employees-store.ts` -- add `linkedEmployeeId(userId)`: `select employee_id, archived_at` where `auth_user_id = userId`, `maybeSingle`. It returns the id when the row is not archived, otherwise null, and throws `EmployeesUnavailableError` on error. Default wiring is at the bottom.
- `src/server/attendance-actions.ts:13-16` -- `staffId()`.
- `src/server/interviews-actions.ts:52-53, 93-94, 115-116` -- the `role !== "staff"` gates. The store calls must pass the derived identity.
- `src/server/backfill-actions.ts:46-52` -- `employeeSession()`, already role-agnostic. No change.
- `src/server/interviews-store.ts:147-190`, `attendance-store.ts:112-121`, `training-store.ts:205-239` -- the staff own-record paths that the derived identity reuses. Do not change these stores.
- `src/app/page.tsx` -- the manager and admin branches (around :260-275); `currentTraining`, `departmentOptionsFor`, `withoutInterviews`.
- `src/components/staff-attendance.tsx:293-346` -- the props and the shell (`<main className="staff-page">`, header, sign-out). Extract the inner `staff-content` body into `StaffSelfService`.
- `src/components/portal.tsx:18-30, 103-125, 159, 173-195` -- the `Section` type, the `paths` icon map (the nav is built from its keys), `MANAGER_HIDDEN_SECTIONS`, the props and the section rendering. Filter "My record" out when `myRecord` is absent.
- Tests:
  - `tests/page.test.tsx`: hoisted mocks, plus `portalProps` and `staffProps` capture.
  - `tests/auth.test.ts`, `tests/staff-session.test.ts` and `tests/support/fake-auth.ts`: fake users ADMIN and STAFF. The departments store is mocked.
  - `tests/attendance-actions.test.ts` (fake-auth plus the memory store), `tests/interviews-actions.test.ts` (getSession mock), `tests/components/staff-attendance.test.tsx` and `tests/components/portal.test.tsx`.
  - `tests/e2e/department-manager.spec.ts`: makes `E2E_STAFF_MANAGER_*` a manager through a throwaway department. `tests/e2e/staff.ts` has the helpers.

## Tasks & Acceptance

**Execution:**
1. `src/server/session.ts`, `src/server/employees-store.ts` and `src/server/auth.ts`, plus `tests/session.test.ts`, `tests/employees-store.test.ts` and `tests/auth.test.ts` (or `staff-session.test.ts`) -- the admin `employeeId`, `ownRecordIdentity`, `linkedEmployeeId`, and the admin link lookup. Cover linked, unlinked, archived and lookup-error cases.
2. `src/server/attendance-actions.ts` and `src/server/interviews-actions.ts`, plus their tests -- the derived own-record identity. Cover manager, linked admin and unlinked admin. The interviews store receives `{ role: "staff", employeeId }`.
3. `src/components/staff-attendance.tsx` plus `tests/components/staff-attendance.test.tsx` -- extract `StaffSelfService`. Existing tests stay green; add one test that `StaffSelfService` renders without the shell (no Sign out button).
4. `src/components/portal.tsx` plus `tests/components/portal.test.tsx` -- add the "My record" nav and section when `myRecord` is present, for both the manager and admin roles, and leave them out otherwise. Its evaluations show no write control.
5. `src/app/page.tsx` plus `tests/page.test.tsx` -- build `myRecord` for a manager and for a linked admin; leave it undefined for an unlinked admin. The own reads use the staff identity. The manager list stays interview-free while `myRecord.employee` keeps its own interviews.
6. `tests/e2e/my-record.spec.ts` -- the e2e manager account is given a throwaway department. It signs in, opens "My record", adds an interview, and sees it listed there. The e2e (unlinked) Administrator sees no "My record". Cleanup in `finally`: clear `manager_user_id` and delete the department. Interviews are removed by the existing teardown.

**Acceptance Criteria:**
- Given a manager session, when they open "My record", then they see their own attendance, daily log, interviews, training and backfill controls, with no second sign-out or brand header.
- Given the unlinked e2e Administrator, when the portal renders, then there is no "My record" navigation entry.

## Spec Change Log

## Review Triage Log

### 2026-10-16 — Review pass
- verdicts: 23 findings — high 0, medium 0, low 18, false 5, maybe-false 0
- findings:
  - blind-hunter
    - `[low]` `[patch]` The app has no way to link an Administrator to an employee row — linking is the existing `employees.auth_user_id` mechanism (as in the 4.9 tests); DEPLOYMENT.md now explains how to set it.
    - `[low]` `[reject]` The link lookup adds one read to every admin session check — it is a single indexed read through RLS; per-request memoisation would be new infrastructure with no measured cost behind it.
    - `[low]` `[reject]` A failed own-record read replaces the whole portal with the unavailable page — the spec chose this ("follows the existing unavailable pages"), and the reads hit the same database as the portal's own lists; changing it is a spec edit.
    - `[low]` `[reject]` Two `h1` headings once the staff body is embedded — axe passes; a heading-level parameter adds surface for a cosmetic outline issue.
    - `[low]` `[reject]` Leaving "My record" unmounts unsaved drafts — every portal section and profile tab already behaves this way.
    - `[low]` `[patch]` A linked admin's `employeeId` reaches the backfill store as an admin session — the backfill actions now pass `ownRecordIdentity(...)`, as attendance and interviews do.
    - `[low]` `[patch]` No backfill test for a manager or linked admin — tests added (grouped with the row above).
    - `[low]` `[reject]` e2e covers only a manager adding an interview — clock-in, log and backfill run through the unchanged RLS own policies (`auth_user_id = auth.uid()`) and are unit-tested; a linked-admin e2e user would need new global-setup accounts.
    - `[low]` `[patch]` e2e cleanup ignores errors — it now checks `.error` and throws, tolerating schema-missing codes.
    - `[low]` `[patch]` The sign-in copy still says "as a staff member" — the copy is now role-neutral (grouped with the unlinked-admin message).
    - `[false]` `[reject]` Redundant admin guard in `ownRecordIdentity` — it restates the following check, with no behavioural harm.
    - `[low]` `[patch]` The section description omits past projects — added.
    - `[low]` `[defer]` A manager's own row still appears in the directory with management controls (assignments, transfer) — the server already refuses self-evaluation; an own-record exclusion on assignment writes is pre-existing 4.5 behaviour, and the spec's Never section keeps it out of scope.
  - edge-case-hunter
    - `[low]` `[patch]` Backfill uses the raw session — duplicate; same fix.
    - `[low]` `[patch]` An unlinked Administrator is told their session ended — they now get "Your account isn't linked to an employee record, so there is nothing to record here."
    - `[low]` `[reject]` The section stays on "My record" if a later render drops `myRecord` — it needs the link to be removed mid-session; fixing it means adding an effect.
  - verification-gap
    - `[low]` `[patch]` Linked-admin backfill writes have no test — duplicate; tests added.
  - intent-alignment
    - `[false]` `[reject]` "Record leave" from the story sentence is missing — the ACs list attendance, interviews, training and backfill; leave is Epic 5 (5.2 records it "from My record").
    - `[low]` `[reject]` No linked-admin or clock-in e2e — duplicate of the e2e-coverage row.
    - `[false]` `[reject]` A linked admin's JWT is still admin at the RLS layer — the own-record views read only `employeeId` through the derived staff identity, and own writes pass the auth.uid()-keyed own policies; the admin read policies widen nothing My record shows.
    - `[low]` `[patch]` Backfill does not use the derived identity — duplicate; same fix.
    - `[false]` `[reject]` No test of a higher manager viewing a lower manager's profile — `tests/interview-privacy-rls.test.ts` (4.4) covers exactly that case, and the diff leaves those paths unchanged.
    - `[false]` `[reject]` An archived linked admin is covered only at the session level — `ownRecordIdentity` returns null for an admin without `employeeId`, and the page test for an unlinked admin covers what follows from that.

## Design Notes

Reusing the staff paths through a derived `{ role: "staff", employeeId }` identity is the least invasive way to get "the same own-record rules as Staff". Every store's own-record branch, and the RLS own policies (`auth_user_id = auth.uid()`), already enforce exactly those rules. Widening the admin and manager branches of each store instead would risk mixing org-wide reads into own-record views. Assignment evaluations stay read-only in My record because `StaffSelfService` renders them through `EvaluationView`, with no form. The 4.6 store and RLS rules also already refuse writes on the writer's own linked employee.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors.
- `npm test` -- expected: all pass, except the parent PR's (Story 4.8) live transfer tests, which may fail only with PGRST202 or 42703 until its migration is applied.
- `npm run build` -- expected: success.
- e2e with Chromium (a local uncommitted config with `launchOptions.executablePath` set to `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) -- expected: `my-record` passes. The parent's `transfer` spec may fail only with its schema-missing error.

## Auto Run Result

Status: done

**Summary:** Accounts linked to an employee record now get a "My record" section in the management portal. That means every manager, and any Administrator whose auth user is `employees.auth_user_id` on one non-archived row.
- **Content:** it shows the staff portal's self-service body (`StaffSelfService`, extracted from `StaffAttendance`): attendance and daily log, interviews, training, assignments with read-only evaluations, and past projects.
- **Own-record rules:** every read and write in it goes through `ownRecordIdentity(session)`, which is `{ role: "staff", employeeId }`, so the stores and RLS apply exactly the Staff own-record rules. This covers the page reads and the attendance, interview and backfill actions.
- **Admin link:** the admin identity gains an optional `employeeId`, looked up each request through RLS (`employeesStore.linkedEmployeeId`). A failed lookup leaves the admin unlinked.
- **Unlinked accounts** get no "My record" and are refused by own-record actions with a clear message.
- **Manager interviews:** a manager's own interviews stay out of the employee list they receive (4.4), and appear only in their own "My record".

**Migration:** none, and no RLS change. The branch is stacked on Story 4.8 (#40), whose migration is still unapplied.

**Files:**
- `src/server/session.ts`: the admin `employeeId` and `ownRecordIdentity`.
- `src/server/employees-store.ts`: `linkedEmployeeId`.
- `src/server/auth.ts`: the admin link lookup.
- `src/server/attendance-actions.ts`, `interviews-actions.ts`, `backfill-actions.ts`: the derived own-record identity and role-neutral or unlinked messages.
- `src/components/staff-attendance.tsx`: `StaffSelfService` extracted.
- `src/components/portal.tsx`: the "My record" nav and section.
- `src/app/styles.css`: the embedded layout rule.
- `src/app/page.tsx`: `myRecordFor`.
- `docs/DEPLOYMENT.md`: how an Administrator gets "My record".
- Tests: `session`, `employees-store`, `auth`, `attendance-actions`, `interviews-actions`, `backfill-actions`, `components/staff-attendance`, `components/portal`, `page`, plus `tests/e2e/my-record.spec.ts` (new).

**Review:** one pass, 23 findings. 5 were false.
- **Patched (low only):**
  - backfill actions use the derived identity, with tests for managers and linked admins;
  - role-neutral session copy and an explicit unlinked-account message;
  - e2e cleanup checks errors;
  - the section description mentions past projects;
  - a DEPLOYMENT note on linking an Administrator.
- **Deferred:** 1, the manager's own row in the directory, recorded in frontmatter.
- **Rejected:** the rest, with reasons in the triage log.

**Follow-up review recommended:** false. No high or medium entries were patched.

**Verification:**
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 1488 passed, 10 failed. All 10 are in the parent's `tests/transfer-rls.test.ts` and fail only with PGRST202 or 42703 until the 4.8 migration is applied.
- e2e on Chromium:
  - full suite before the review patches: 33 passed, 1 failed (the parent's `transfer` spec, schema-missing);
  - after the patches, `my-record`, `department-manager`, `staff-attendance` and `interviews`: 10 passed.

**Residual risks:**
- No end-to-end test covers a linked Administrator, because the e2e Administrator is unlinked. That path is covered by unit tests only.
- Embedding the staff body adds a second `h1` (the date) inside the section.

