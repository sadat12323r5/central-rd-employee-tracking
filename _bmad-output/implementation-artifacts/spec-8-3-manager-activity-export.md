---
title: "Story 8.3: Department managers export within their department"
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '9f74ea5f0cf6442385dd92c8ffee6063d3833147'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-2-admin-bulk-exports-activity.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-manager-scoping.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The per-employee and bulk activity exports (Stories 8.1, 8.2) are Administrator-only, so a department manager cannot review their own team's activity offline.

**Approach:** Open both export actions to the `manager` role, scoped to the manager's department subtree through the existing session-aware stores (Story 4.3), with `interview` rows always excluded for managers. Each successful manager export writes one audit row recording the manager, the scope (the employee, or the manager's departments) and the period. The profile and directory export panels appear in the management portal.

## Boundaries & Constraints

**Always:**
- **Roles.** `exportActivity` and `exportAllActivity` (`src/server/activity-export.ts`) and their actions (`src/server/activity-actions.ts`) accept `admin` and `manager`; anything else (Staff, no session) → "Only an Administrator or a department manager can export activity." before any read (rename the constant, e.g. `NOT_ALLOWED`; update its users and tests).
- **Single export, manager.** The employee is read through `employees.getFor(session, id)`: `null` for a manager (outside the subtree, or no such employee) → `ActivityForbiddenError`-style refusal with "You can only export employees in your own department or its sub-departments." and no other read, no audit. Attendance is read through the session-aware `attendance.listFor(session, employeeId)` for both roles (replacing `listForEmployee`); training through `training.listFor`/`currentFor` with the session (already scoped).
- **Interviews.** For a manager, `interviews` sources are always `[]` and the interviews store is not called (defence in depth on top of interviews-store returning `[]` for managers). The Administrator's exports are unchanged (interviews included).
- **Bulk export, manager.** `employees.listFor(manager)` already returns only the subtree (archived ones flagged); the same "Include archived" rule applies. Attendance from `attendance.listAll()` is used only for the included employees (as today). Interviews are dropped for managers. Filename stays `activity-all-employees-<from>_to_<to>.csv`.
- **Audit.**
  - Single: `audit.recordActivityExport({ actorId, employeeId, from, to })` for both roles (target = the employee).
  - Bulk, admin: unchanged (`recordBulkActivityExport`, target `all-employees[+archived]`).
  - Bulk, manager: new `audit.recordDepartmentActivityExport({ actorId, departmentIds, includeArchived, from, to })` calling a new function `public.record_department_activity_export(p_actor uuid, p_department_ids uuid[], p_include_archived boolean, p_from date, p_to date) returns bigint`: `invalid_period` (null or reversed), `invalid_scope` (null or empty array); inserts one `audit_events` row, action `export_activity`, target `departments:<ids sorted, comma-separated>` plus `+archived` when included. `security invoker`, execute for `service_role` only (as `record_bulk_activity_export`). `departmentIds` = `scope.forManager(session).departmentIds` read during the export (new dep `scope: Pick<ManagerScope, "forManager">`); `ManagerScopeUnavailableError` → unavailable.
  - Exactly one audit row per successful export; none when anything fails.
- **Migration** `supabase/migrations/20261015050000_department_activity_export_audit.sql`: ADDITIVE (one new function and its grants). Header style as `20261013010000_bulk_activity_export_audit.sql`.
- **UI** (`src/components/portal.tsx`): render `ActivityExportPanel` for managers too — on the profile Overview (single) and in the Employees section (bulk). For a manager the bulk heading reads "Download activity (your departments)" and a note says interviews are not included; the Administrator's panels are unchanged. Keep the other admin-only panels (account, access) hidden from managers.
- Same CSV columns, BOM, quoting, sorting, periods, validation and all-or-nothing behaviour as 8.1/8.2.

**Never:**
- No `interview` rows in any manager export, whatever the stores return.
- No Staff export path; no change to the Administrator's output or audit targets.
- No assignment, evaluation or leave rows (Story 8.4).
- No change to existing migrations, tables or policies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Manager, one employee in subtree | Valid period | CSV of attendance, training, enrolments; no interview rows; audit target = employee id | — |
| Manager, employee outside subtree (or unknown) | Any period | No CSV, no other read, no audit | scope message |
| Manager bulk | Subtree has 2 active + 1 archived | CSV of the 2 active only, no interviews; audit target `departments:<ids>` | — |
| Manager bulk, include archived | `includeArchived=on` | Archived one included; target ends `+archived` | — |
| Manager bulk, empty subtree | Manages a department with no employees | Header-only CSV; audit written | — |
| Stores return an interview for a manager | Fake store returns one | Not in the CSV | — |
| Staff / no session | Either action | No reads, no CSV | "Only an Administrator or a department manager…" |
| Scope or source unavailable | Scope read, a store, LMS or audit fails | No CSV, no audit (or audit failure → no CSV) | 8.1 unavailable message |
| Admin | Single and bulk | Unchanged from 8.1/8.2 (interviews included, same targets) | — |
| Bad period | Reversed/future custom range | No CSV, no audit | inline validation message |

</intent-contract>

## Code Map

- `src/server/activity-export.ts` -- `exportActivity`, `exportAllActivity`, deps types, `NOT_ADMIN`, `UNAVAILABLE_ERRORS`, `activityErrorMessage`; add the manager branches and the scope dep.
- `src/server/activity-actions.ts` -- role gate (`actor?.identity.role !== "admin"`), deps wiring (add `managerScope`, switch to `attendanceStore` `listFor`).
- `src/server/audit-store.ts` -- `recordBulkActivityExport` and its zod input; add `recordDepartmentActivityExport` (uuid array, non-empty).
- `src/server/attendance-store.ts:124` -- session-aware `listFor` (admin: any; manager: subtree; staff: own).
- `src/server/employees-store.ts` -- `getFor`/`listFor` manager branches (subtree, `interviews: []`, archived flagged).
- `src/server/manager-scope.ts` -- `managerScope`, `ManagerScopeUnavailableError`, `ManagerScopeSet.departmentIds`.
- `supabase/migrations/20261013010000_bulk_activity_export_audit.sql` -- function template.
- `src/components/activity-export-panel.tsx` -- single/bulk modes; add a `manager` prop (heading and note only).
- `src/components/portal.tsx` -- `!isManager && <>...<ActivityExportPanel .../></>` on the Overview and `section === "Employees" && !isManager && <ActivityExportPanel key="activity-all" />`.
- Tests: `tests/activity-export.test.ts`, `tests/audit-store.test.ts` (unit + live skip-if-unconfigured block), `tests/components/activity-export-panel.test.tsx`, `tests/components/portal.test.tsx`, `tests/e2e/activity-export.spec.ts`, `tests/e2e/department-manager.spec.ts` (manager e2e setup pattern).
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` -- migration list, export section.

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261015050000_department_activity_export_audit.sql` -- the function and grants (ADDITIVE).
- `src/server/audit-store.ts` + `tests/audit-store.test.ts` -- `recordDepartmentActivityExport` (validation, rpc args, error mapping; live block for the function).
- `src/server/activity-export.ts` + `tests/activity-export.test.ts` -- manager branches; every matrix row with fakes, including an interview returned by a fake store being dropped and the scope dep failing.
- `src/server/activity-actions.ts` -- role gate and wiring.
- `src/components/activity-export-panel.tsx`, `src/components/portal.tsx` + component tests -- panels for managers, manager heading/note; admin unchanged.
- `tests/e2e/activity-export.spec.ts` -- a manager (throwaway department + Staff account made its manager, service-role setup and cleanup) downloads a single in-subtree export and a bulk export; asserts filename, BOM, header and no `interview` rows, or the migration fail-fast unavailable message.
- `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`.

**Acceptance Criteria:**
- Given a department manager, when they export one employee or use the bulk export, then only employees in their own department subtree are allowed or included, and asking for anyone else is rejected at the server.
- Given a department manager's export, when it is produced, then it contains no `interview` rows.
- Given a successful manager export, when it completes, then exactly one audit event records the manager, the scope and the period.

## Spec Change Log

## Review Triage Log

## Design Notes

The manager's bulk scope is recorded as the subtree's department ids at export time, so the audit row stays meaningful after later re-parenting or manager changes. A single export's scope is the employee itself, already recorded by `record_activity_export`, so no new function is needed there. Stacked on Story 4.3 (manager scope); Story 4.4's interview privacy is honoured here independently by never reading interviews for managers.

## Verification

**Commands:**
- `npm run typecheck` -- no errors.
- `npm test` -- all pass, except live DB tests needing the unapplied 4.1–4.3 and 8.3 migrations, which may fail only with schema-missing errors (42P01, 42703, 42883, PGRST202, PGRST204, PGRST205); quote them.
- `npm run build` -- success.
- `npm run test:e2e` with Chromium via a temporary config (`channel: undefined`, `launchOptions.executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`; delete it afterwards) -- pass, or fail only with schema-missing errors.
- Optional: apply all migrations to a throwaway local Postgres 16 (`/usr/lib/postgresql/16/bin`) and exercise the new function.
