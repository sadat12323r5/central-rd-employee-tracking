---
title: 'Story 4.2: Administrator assigns a department manager'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: '0e21739babcdd2acf617dbf772e774d42a17ae6f'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-department-list.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Departments exist (Story 4.1) but nobody manages them, and sessions know only `admin` and `staff`, so a team lead cannot get a management view without org-wide Administrator access.

**Approach:** Add an optional manager account to each department (`departments.manager_user_id`), an Administrator-only "set manager" path (store + action + UI) that requires an existing sign-in account, derive a `manager` session role fresh on every request for staff accounts that manage at least one department, route manager sessions to the management portal, add the pure authority-chain resolver in `src/domain/departments.ts`, and seed L&D's manager as the Administrator.

## Boundaries & Constraints

**Always:**
- Migration `supabase/migrations/20261014010000_department_managers.sql` is ADDITIVE: new nullable column `departments.manager_user_id uuid references auth.users(id) on delete set null`, its index, and a new select policy letting an authenticated user read the departments they manage (`manager_user_id = (select auth.uid())`). Nothing existing is altered or tightened.
- Role precedence: `app_metadata.role = 'admin'` is always `admin` (never downgraded, even when it manages a department). Only a valid staff identity whose auth user manages ≥1 department becomes `{ role: "manager", employeeId }`. Derived in `auth.ts` on every request (after the existing session-window and archived checks), never stored in the token or cached.
- If the manages-check read fails, the session is the plain `staff` identity (the less-privileged role) and the error is logged; never grant `manager` on an error.
- Setting a manager: Administrator only (action checks `session.role === "admin"` first; store re-checks). The chosen person is an employee (by Employee ID) who must already have a linked, non-archived sign-in account; it never creates an account. "No manager" removes the manager. Department must exist.
- Department add/rename/re-parent and set-manager stay Administrator-only; a manager session is rejected at the server exactly like Staff.
- Manager sessions never read interviews through the management portal: `interviews-store.listFor` returns `[]` for a manager session without querying; add/update/withdraw stay staff-only.
- `src/domain/departments.ts` gains pure `authorityChain(list, departmentId)` (manager user ids of the department then each ancestor, nearest first, skipping unmanaged, no duplicates; uses the visited-set guard so a looping list throws `DepartmentHierarchyError`) and `hasDepartmentAuthority(actor, list, departmentId)` (`admin` → always true; otherwise the actor's user id is in the chain).
- Seed (`scripts/seed-employees.ts`) sets L&D's manager to the Administrator only when L&D has no manager: the auth user whose email equals `SEED_ADMIN_EMAIL` when set, else the earliest-created user with `app_metadata.role = 'admin'`; if none exists it logs a warning to run `npm run db:seed-admin` first and continues. Central R&D gets no manager.

**Never:**
- No manager scoping of directory/profile/training/attendance (Story 4.3: a manager sees what the non-admin read paths already return, i.e. their own record); no "My record" area (4.10); no assignments.
- No change to session lengths: the 8 h / 12 h window stays decided by the account's `app_metadata` role (a manager's account is a staff account → 12 h).
- No account creation as a side effect; no service-role use at runtime for this story.
- No delete paths.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Assign | admin; dept exists; employee has active account | saved; that account's next request is `manager` and renders the management portal | "Manager updated." |
| No account | employee without linked account | rejected, nothing saved | "<Name> has no sign-in account yet. Provision their account first, then make them a manager." |
| Archived account | employee archived | rejected | "<Name>'s account is archived. Restore it first." |
| Remove | manager = "none" | manager cleared; if that account manages nothing else its next request is `staff` | "Manager removed." |
| Unknown | unknown department or employee | rejected | "Choose an existing department and employee." |
| Bad input | non-uuid department, malformed employee id, missing choice | rejected before store | field message |
| Non-admin | staff or manager session calls set-manager / add / rename / re-parent | rejected at server, store not called | "Only an Administrator can manage departments." |
| Admin manages | admin account is L&D manager | session `admin` | none |
| Manages-check fails | departments read error for a staff account | session `staff`, error logged | none |
| Loop in data | `authorityChain` over a looping list | throws `DepartmentHierarchyError` | no infinite loop |

</intent-contract>

## Code Map

- `src/server/session.ts` -- `SessionIdentity` union; add `{ role: "manager"; employeeId: string }`; `sessionHours` must treat manager like staff (12 h).
- `src/server/auth.ts` -- `identityFor` (metadata → identity), `supabaseSession` (window + `employeesStore.isActive` for staff; derive manager after these using the validated user id). `getActor` returns `{ identity, userId }`.
- `src/server/departments-store.ts` -- from Story 4.1: `createDepartmentsStore({ userClient })`, typed errors, `refusal` mapping, `checked()`. Add `setManager(session, departmentId, employeeId | null)` and `managesAny(userId)`; `list` (admin) also returns `managerUserId` and `managerEmployeeId` (resolved via an admin read of `employees.employee_id, auth_user_id` for the manager ids).
- `src/server/department-actions.ts` -- 4.1 actions; add `setDepartmentManagerAction` (fields `id`, `manager` = Employee ID or `none`).
- `src/domain/departments.ts` -- `Department` type (add `managerUserId`, `managerEmployeeId`, both `string | null`), `ancestorIds` with guard: build `authorityChain` / `hasDepartmentAuthority` on it.
- `src/server/interviews-store.ts:146` -- `listFor`; manager → `[]`.
- `src/server/employees-store.ts` -- non-admin paths already scope to `session.employeeId`; manager must take those paths (no admin columns).
- `src/app/page.tsx` -- staff branch → staff portal; admin branch loads departments; add manager branch → `Portal` with `role="manager"`, no departments read.
- `src/components/portal.tsx` -- add `role: "admin" | "manager"` prop (default admin). For manager hide: Departments and Interviews & placements nav sections, the profile Interviews tab, the interview overview stat, and the account panels (`StaffAccountPanel`, `AccountAccessPanel`); sidebar identity text says "Department manager".
- `src/components/departments-panel.tsx` -- per-row manager display ("No manager", employee name, or "Administrator account") and a manager form: select with "Choose…" (empty, invalid), "No manager" (`none`), and every non-archived employee (label notes "no account" when `hasAccount` is false); needs `employees` prop.
- `scripts/seed-employees.ts`, `src/data/departments.ts` -- 4.1 seed; add the L&D manager step after the departments insert.
- `tests/departments-rls.test.ts`, `tests/e2e/departments.spec.ts`, `tests/e2e/global-setup.ts` -- live-test patterns (one sign-in per user per file; throwaway rows; service-role cleanup; bulk inserts with `{ defaultToNull: false }`).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261014010000_department_managers.sql` -- column, index, `departments_select_managed` policy -- ADDITIVE.
- `src/domain/departments.ts` + `tests/departments.test.ts` -- `authorityChain`, `hasDepartmentAuthority`, Department manager fields.
- `src/server/session.ts`, `src/server/auth.ts` + `tests/session.test.ts`, `tests/auth.test.ts` -- manager role derivation and precedence, failure → staff.
- `src/server/departments-store.ts`, `src/server/department-actions.ts` + their tests -- set manager, `managesAny`, list with manager fields; manager sessions rejected everywhere.
- `src/server/interviews-store.ts` + test -- manager → `[]`.
- `src/app/page.tsx`, `src/components/portal.tsx`, `src/components/departments-panel.tsx` + `tests/page.test.tsx`, `tests/components/portal.test.tsx`, `tests/components/departments-panel.test.tsx` -- manager routing, hidden sections, manager form.
- `scripts/seed-employees.ts`, `docs/DEPLOYMENT.md` -- L&D manager seed step and run order (`db:seed-admin` before `db:seed`).
- `tests/departments-rls.test.ts` -- a staff user reads only departments it manages; cannot update `manager_user_id`; admin can set/clear it.
- `tests/e2e/departments.spec.ts` (or `department-manager.spec.ts`) -- admin assigns a throwaway Staff account as manager of a throwaway department, that user's next sign-in reaches the management portal (no Interviews nav); admin removes it and the user's next request shows the staff portal; an employee without an account is refused with the provision-first message.

**Acceptance Criteria:**
- Given the seed has run after `db:seed-admin`, when the Administrator opens Departments, then L&D shows the Administrator account as manager and Central R&D shows "No manager".
- Given a manager session, when it requests the page, then it sees the management portal without Departments, Interviews & placements, the Interviews tab or account controls.
- Given any department-scoped permission check, when `hasDepartmentAuthority` runs, then it walks `authorityChain` fresh and an Administrator always has authority.

## Spec Change Log

## Review Triage Log

### 2026-10-14 — Review pass
- verdicts: 31 findings — high 0, medium 8, low 20, false 3, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap) Seed step that makes the Administrator L&D's manager is never tested — selection moved to a pure `pickSeedAdministrator` helper with unit tests.
  - `[medium]` `[patch]` (verification-gap other) `SEED_ADMIN_EMAIL` branch accepts a non-admin account — helper only returns admin users; same patch.
  - `[medium]` `[reject]` (verification-gap other) A Staff account made manager loses Staff self-service (clock in, own interviews) — real, but the intent places this in Story 4.10 ("My record"); stories build strictly in order; flagged in the PR.
  - `[medium]` `[patch]` (edge) update/setManager report "Nothing was saved" when the post-write manager lookup fails — post-write lookup failure now returns the saved department without the employee link.
  - `[medium]` `[patch]` (edge) SEED_ADMIN_EMAIL non-admin — same root cause as the verification-gap finding; same patch.
  - `[medium]` `[reject]` (edge) Manager loses clock-in/interview actions — same as above; Story 4.10.
  - `[low]` `[patch]` (edge) `hasDepartmentAuthority` grants chain authority to a staff actor — now admin or manager only.
  - `[low]` `[patch]` (edge) Archived employee without account gets the provision-first message — archived checked first.
  - `[low]` `[patch]` (edge) Manager topbar shows the Administrator's initials — neutral manager initials.
  - `[low]` `[reject]` (edge) Manages-check logs an error on every Staff request until the migration is applied — transient until the migration lands; the PR says to apply migrations before deploying.
  - `[low]` `[reject]` (edge) BS-93xx RLS slot collision between concurrent runs — same randomized-slot convention as every other RLS file.
  - `[low]` `[reject]` (edge) Archived-employees filter and export visible to managers — inert for a manager who sees only their own record; scoping is Story 4.3.
  - `[medium]` `[reject]` (blind) Staff made manager loses Staff functions — Story 4.10 (see above).
  - `[medium]` `[patch]` (blind) SEED_ADMIN_EMAIL non-admin — same patch.
  - `[low]` `[reject]` (blind) Archiving a manager leaves `manager_user_id` set — the archived account cannot sign in, ancestor managers keep authority via the chain, and the Administrator can reassign; manager archiving is Story 4.9.
  - `[low]` `[reject]` (blind) "Administrator account" label for any manager without an employee row — through the app only the seeded Administrator can be such a manager.
  - `[low]` `[reject]` (blind) setManager check-then-write race — needs a concurrent archive between two requests; the archived account still cannot sign in.
  - `[low]` `[reject]` (blind) setManager reads all departments first — a few extra rows on an admin-only action.
  - `[low]` `[reject]` (blind) Extra departments query per Staff request and log flood without migration — one indexed `limit 1` query; required by "derived on every request".
  - `[false]` `[reject]` (blind) `authorityChain`/`hasDepartmentAuthority` unused in production — no department-scoped permission check exists yet; Story 4.3 is the first caller; AC6 asks for the resolver in `src/domain/departments.ts`.
  - `[low]` `[reject]` (blind) Manager form doesn't preselect the current manager — the current manager is shown in its column; an explicit choice avoids accidental resubmits.
  - `[low]` `[reject]` (blind) Manager Overview shows "1 employee" / fixed notes — manager scoping is Story 4.3.
  - `[low]` `[patch]` (blind) No tests for the seed manager step — same patch as the verification-gap finding.
  - `[low]` `[reject]` (blind) training-store manager-session tests missing — training-store is unchanged; the non-admin path it takes is already tested.
  - `[low]` `[reject]` (blind) No tests for manager signIn / duplicate auth_user_id / sibling departments RLS — `auth_user_id` is unique; signIn derives nothing; policy is a plain equality.
  - `[low]` `[reject]` (blind) Error message doesn't say whether the department or the employee was wrong — both come from the same form's selects; rare.
  - `[false]` `[reject]` (intent) AC6 tree walk not wired into a runtime check — no department-scoped permission check exists in this story; the resolver exists with its loop guard.
  - `[low]` `[reject]` (intent) No test of the Administrator renaming a managed department — department writes are Administrator-only regardless of manager (4.1 tests).
  - `[low]` `[patch]` (intent) Seed manager step only exercised in definitions — same patch.
  - `[low]` `[reject]` (intent) No live test of an Administrator who also manages — precedence is structural (admin returned before any manages-check), covered in auth tests.
  - `[false]` `[reject]` (intent) No RLS test of a manager renaming/re-parenting — 4.1's update policy is admin-only and RLS-tested; a manager is a staff JWT.

## Design Notes

The manager reference is an auth user id, not an Employee ID, because the seeded L&D manager is the Administrator account, which has no employee row. The UI picks people by Employee ID and the store resolves the linked account, which is what makes "no account → provision first" observable. Deriving `manager` only from staff identities makes the admin precedence structural. Falling back to `staff` when the manages-check read fails is fail-closed for manager powers and keeps Staff working; the existing archived check stays fail-closed for access. Session length follows the account's `app_metadata` role, so no new session-length decision is introduced.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests needing the 4.1/4.2 migrations, failing only with schema-missing errors (42P01/42703/PGRST204/PGRST205)
- `npm run build` -- expected: success
- `npm run test:e2e` (here: Chromium via `launchOptions.executablePath: "/opt/pw-browsers/chromium"`) -- expected: pass, or fail only with schema-missing errors until the migrations are applied

## Auto Run Result

Status: done

**Summary:** Departments gain an optional manager account (`manager_user_id`, ADDITIVE migration with a "read departments you manage" policy). Only the Administrator can set or remove a manager, through the store, an action and the Departments panel. The employee must have a linked, non-archived account, so the action never creates one. Staff accounts that manage at least one department get the `manager` role, worked out fresh on every request; Administrators are always `admin`, and a failed check falls back to `staff`. Manager sessions reach the management portal without Departments, Interviews or account controls, and the interviews store returns nothing for them. `authorityChain` and `hasDepartmentAuthority` are pure and guard against loops. The seed makes the Administrator L&D's manager.

**Files changed:**
- `supabase/migrations/20261014010000_department_managers.sql`: ADDITIVE column, index, policy.
- `src/domain/departments.ts`: manager fields, `authorityChain`, `hasDepartmentAuthority`.
- `src/server/session.ts`, `src/server/auth.ts`: manager role, its precedence, the staff fallback.
- `src/server/departments-store.ts`, `src/server/department-actions.ts`: `setManager`, `managesAny`, manager fields on `list`.
- `src/server/interviews-store.ts`: managers get `[]`.
- `src/app/page.tsx`, `src/components/portal.tsx`, `src/components/departments-panel.tsx`: manager routing and hidden sections, Manager column and form.
- `src/data/departments.ts`, `scripts/seed-employees.ts`, `docs/DEPLOYMENT.md`: L&D manager seed (`pickSeedAdministrator`) and run order.
- Tests: domain, store, actions, session, auth, interviews, page, portal, panel, RLS (live), e2e `department-manager.spec.ts`, e2e setup with 2 more throwaway employees.

**Review findings:** 31 in total.
- Patched: 11 rows, covering 5 root causes (3 medium, 2 low).
- Deferred: 0.
- Rejected: 20, each with its reason in the triage log.

**Follow-up review recommended:** false. The patches fixed no high findings, and every patched entry was re-verified.

**Verification:**
- Typecheck and build pass.
- `npm test`: 815 passed and 12 skipped. The only failures are in `tests/departments-rls.test.ts`, with PGRST205.
- E2E: 11 passed. The 12 admin-portal specs fail only with 42703/PGRST205 (schema missing).

**Residual risks:**
- Both migrations (4.1, then 4.2) must be applied before deploying. Until then, Staff requests log a failed manager check and continue as Staff.
- A Staff account made manager loses Staff self-service until Story 4.10 adds "My record".
