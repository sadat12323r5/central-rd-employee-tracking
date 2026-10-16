---
title: 'Story 4.10: Managers use "My record" for their own self-service'
type: 'feature'
created: '2026-10-16'
status: 'in-review'
baseline_revision: 'cab115b16487e881b5ae413f341ff344a35188b2'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred: []
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

## Design Notes

Reusing the staff paths through a derived `{ role: "staff", employeeId }` identity is the least invasive way to get "the same own-record rules as Staff". Every store's own-record branch, and the RLS own policies (`auth_user_id = auth.uid()`), already enforce exactly those rules. Widening the admin and manager branches of each store instead would risk mixing org-wide reads into own-record views. Assignment evaluations stay read-only in My record because `StaffSelfService` renders them through `EvaluationView`, with no form. The 4.6 store and RLS rules also already refuse writes on the writer's own linked employee.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors.
- `npm test` -- expected: all pass, except the parent PR's (Story 4.8) live transfer tests, which may fail only with PGRST202 or 42703 until its migration is applied.
- `npm run build` -- expected: success.
- e2e with Chromium (a local uncommitted config with `launchOptions.executablePath` set to `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) -- expected: `my-record` passes. The parent's `transfer` spec may fail only with its schema-missing error.
