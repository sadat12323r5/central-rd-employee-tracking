---
title: 'Story 4.1: Administrator manages the department list'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '5411f91d578845d490ef1f692639aaa1f26b3f65'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** There are no departments: employees are not attached to any organisational unit, so Epic 4's department managers, scoping and assignments have nothing to hang on.

**Approach:** Add a `departments` table (unique name, optional parent, no delete), an `employees.department_id` column, an Administrator-only `departments-store` + server actions with cycle rejection at the store (and a DB trigger as backstop), a "Departments" section in the management portal, a Department column in the directory, and seed L&D → Central R&D with every fixture employee in Central R&D.

## Boundaries & Constraints

**Always:**
- Migration is ADDITIVE only: new table, new nullable FK column on `employees`, index, trigger, RLS policies. No alter of existing columns/policies.
- Every department action checks `session.role === "admin"` at the server first; the store re-checks (typed `DepartmentsForbiddenError`). zod validation in every action. Action results use `{ error, message }`.
- Store uses the per-request user client (RLS enforced); never the service role. `null` for not-found reads; typed errors for validation/authorization.
- Names: trimmed, inner whitespace collapsed, 1–100 chars, unique case-insensitively (store pre-check + DB unique index on `lower(name)`; DB `23505` maps to the same typed error).
- Cycle rule: a department may not be its own parent or ancestor. Store rejects using the pure `src/domain/departments.ts` walker (visited-set guard throws instead of looping); a DB trigger (serialised with an advisory lock) also rejects, mapped to the same typed error.
- Seed is idempotent and insert-only for departments (fixed UUIDs); employees get Central R&D only where `department_id is null` and only for fixture employee ids.

**Never:**
- No delete path anywhere (no store method, action, UI control or RLS delete policy).
- No manager role, manager assignment or department scoping (Stories 4.2–4.3).
- No `NOT NULL` on `employees.department_id` in this story (would be a DESTRUCTIVE tightening and breaks test rows); recorded as deferred.
- No change to the staff portal, CSV export columns, or interviews.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create top-level | admin, name "Quality", parent "" | saved, parent null | "Department added." |
| Create child | admin, name "QA Lab", parent = L&D id | saved under L&D | No error |
| Rename / re-parent | admin, id, new name, new parent | saved | "Department updated." |
| Duplicate name | "central r&d " when "Central R&D" exists (other id) | rejected | "A department with that name already exists." |
| Rename to own name | same id, same name different case | saved (not a duplicate) | No error |
| Self parent | id = parent | rejected | "A department can't be placed under itself or one of its own sub-departments." |
| Ancestor cycle | set L&D's parent to Central R&D | rejected at store | same cycle message |
| Unknown parent / id | uuid not in list | rejected | "Choose an existing department." |
| Invalid input | empty name, >100 chars, non-uuid | rejected before store | field message |
| Staff / no session | any department action | rejected at server, store never called | "Only an Administrator can manage departments." |
| DB unreachable | any | nothing reported saved | "Departments are temporarily unavailable. Nothing was saved." |

</intent-contract>

## Code Map

- `supabase/migrations/20261006000000_employees.sql`, `20261012010000_external_interviews.sql` -- table/RLS style to copy (admin = `auth.jwt()->'app_metadata'->>'role' = 'admin'`).
- `src/server/interviews-store.ts` -- store shape to copy: `createXStore({ userClient })`, `runMaybe`/`run`, `XUnavailableError`, typed errors, exported singleton.
- `src/server/interviews-actions.ts` -- action shape: `getSession()`, zod `safeParse`, `field()`, `refusal()` mapping, `revalidatePath("/")`; `ActionState` from `attendance-actions.ts`.
- `src/server/employees-store.ts` -- `ADMIN_COLUMNS` / `EmployeeRow` / `toEmployee(withAccount)`: admin-only fields go here (`department_id` → `departmentId`).
- `src/data/employees.ts` -- `Employee` type (add optional `departmentId?: string | null`); seed helpers live beside the fixture.
- `scripts/seed-employees.ts` -- idempotent seed; departments must be inserted before employees are updated.
- `src/app/page.tsx` -- admin branch loads employees; add departments list, catch `DepartmentsUnavailableError`.
- `src/components/portal.tsx` -- `Section` union + `paths` map drive the sidebar nav (adding a key adds a nav item); `employeeTable` at line 131 is the directory.
- `src/components/account-access-panel.tsx` -- `useActionState` client form pattern.
- `tests/interviews-rls.test.ts` -- live RLS test pattern (one sign-in per user per file, throwaway rows, cleanup).
- `tests/e2e/global-setup.ts`, `tests/e2e/admin.ts` -- e2e admin sign-in and throwaway cleanup (`SCHEMA_MISSING`).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261014000000_departments.sql` -- create `departments(id uuid pk, name text check trimmed 1..100, parent_department_id uuid null fk departments on delete restrict, created_at)`, check `parent_department_id <> id`, unique index on `lower(name)`; trigger `departments_prevent_cycle` (before insert/update of parent: `pg_advisory_xact_lock`, walk ancestors, raise `check_violation` with message `department_cycle`); RLS: admin select/insert/update only, no delete; `alter table employees add column department_id uuid references departments(id) on delete restrict` + index -- ADDITIVE schema.
- `src/domain/departments.ts` -- `Department` type, `normalizeDepartmentName`, `sameDepartmentName`, `ancestorIds(list, id)` with visited-set guard (`DepartmentHierarchyError`), `wouldCreateCycle(list, id, parentId)` -- pure rules.
- `src/server/departments-store.ts` -- `list(session)`, `create(session, {name, parentId})`, `update(session, id, {name, parentId})`; typed errors `DepartmentsForbiddenError`, `DepartmentNameTakenError`, `DepartmentCycleError`, `DepartmentNotFoundError`, `DepartmentsUnavailableError` -- load-bearing guard.
- `src/server/department-actions.ts` -- `createDepartmentAction`, `updateDepartmentAction` (admin check, zod, refusal mapping, revalidate).
- `src/server/employees-store.ts`, `src/data/employees.ts` -- admin reads add `department_id` → `departmentId`.
- `src/data/departments.ts` -- seed constants: L&D and Central R&D fixed UUIDs, rows, `DEFAULT_EMPLOYEE_DEPARTMENT_ID` (Central R&D).
- `scripts/seed-employees.ts` -- insert departments (ignoreDuplicates), then set Central R&D on fixture employees whose `department_id is null`.
- `src/app/page.tsx` -- admin: load `departmentsStore.list` with employees; unavailable → records-unavailable page.
- `src/components/departments-panel.tsx` -- list (name, parent label), add form, per-row edit form (name + parent select excluding itself); no delete control; errors via `role="alert"`.
- `src/components/portal.tsx` -- `departments` prop; "Departments" nav section rendering the panel; directory Department column ("No department" when unset).
- `tests/departments.test.ts`, `tests/departments-store.test.ts`, `tests/department-actions.test.ts`, `tests/components/departments-panel.test.tsx`, `tests/departments-rls.test.ts`, updates to `tests/employees-store.test.ts`, `tests/components/portal.test.tsx`, `tests/page.test.tsx`; `tests/e2e/departments.spec.ts` (admin adds, renames, re-parents; no delete control) with teardown deleting its throwaway departments via the service role.

**Acceptance Criteria:**
- Given the Administrator, when they add or rename a department or set its parent in the Departments section, then the change is saved and listed.
- Given any user, when they look for a way to delete a department, then no UI control, action, store method or delete policy exists.
- Given the seed has run, when the Administrator opens the directory, then L&D (top-level) and Central R&D (under L&D) exist and every fixture employee shows Central R&D.
- Given a Staff session, when it calls any department action or the store, then it is rejected at the server and RLS returns no rows / refuses writes.

## Spec Change Log

## Review Triage Log

## Design Notes

`employees.department_id` stays nullable: making it `NOT NULL` is a tightening (DESTRUCTIVE) and existing test fixtures insert employees without it. The "exactly one department" rule is met by the FK (at most one) plus the seed (at least one); the NOT NULL constraint is deferred until Epic 7 adds employee creation. All fixture employees go to Central R&D because the workspace tracks Central R&D staff; L&D is the managing department (AD-5 seed). Department names are read separately (`departments-store.list`) and joined in the portal by id, so the employees query never embeds another table.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass except live-DB tests that need the new schema, failing only with 42P01/42703/PGRST204/PGRST205
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass, or fail only with schema-missing errors until the migration is applied
