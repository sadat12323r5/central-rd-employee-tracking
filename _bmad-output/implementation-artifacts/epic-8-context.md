# Epic 8 Context: Employee Activity Export

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let the Administrator (for anyone) and Department Managers (for employees in their own department subtree) download a single timeline CSV of everything recorded about an employee in a chosen period: attendance and work logs, interviews, completed training, LMS enrolments and, once their epics land, assignments, evaluations and leave. It works for one employee or in bulk for everyone in scope, extends the existing directory CSV export, and every export is audited so offline copies of employee data stay accountable.

## Stories

- Story 8.1: Administrator downloads one employee's activity timeline
- Story 8.2: Administrator bulk-exports every employee's activity
- Story 8.3: Department managers export within their department
- Story 8.4: Exports include assignments, evaluations and leave

## Requirements & Constraints

- **Who may export:** Administrator org-wide; Department Managers only for employees in their own department subtree. Staff cannot export, not even their own record. Out-of-scope requests (wrong role, employee outside subtree) are rejected at the server, not just hidden in the UI.
- **CSV format:** one timeline CSV, one row per event, sorted by date then time (bulk: by employee, then date). Columns in this exact order: `employee_id, employee_name, date, type, title, details, status`. `type` ∈ `attendance | interview | training | enrolment | assignment | evaluation | leave`.
  - UTF-8 with BOM (Excel compatibility).
  - Fields quoted the same way as the existing directory export.
  - CSV-injection guard: any cell starting with `=`, `+`, `-` or `@` is prefixed with `'`.
  - Filename for single-employee export: `activity-<employeeId>-<from>_to_<to>.csv`.
- **Periods:** this week, last week (weeks run Monday to Sunday), a month (month + year), a year, a custom inclusive date range, all time. All dates are calendar dates in Asia/Dhaka. "All time" resolves to the employee's first and last record dates. Custom range with end before start, or ending in the future, is a validation error and nothing downloads.
- **Empty period:** returns a header-only CSV, never an error page.
- **Failure handling:** if any source store is unavailable, nothing partial is downloaded; show an "unavailable, try again" message. Never silently return partial or stale-looking-fresh data.
- **Bulk:** covers every active employee in scope; archived employees excluded unless "Include archived" is ticked. Large exports (e.g. all time, everyone) must page or stream through the stores rather than rely on one query capped at the PostgREST row limit.
- **Privacy:** `interview` rows are never included in a Department Manager's export (interviews are visible only to the employee and the Administrator). Evaluation client feedback appears in `details` only for authorized managers.
- **Row content (8.4):** `assignment` rows show project, client, role, start/end, and include backfilled past projects; an assignment overlapping the period is included. `evaluation` rows show evaluator and outcome summary, dated by the evaluation date. `leave` rows show type, dates, working-day count and status (cancelled leave included); a leave period touching any day of the range is included.
- **Audit:** each successful export (single or bulk) writes exactly one audit event recording actor, scope (the employee, "all employees", or the manager's scope) and period.
- **Definition of Done applies:** zod validation on every new server action, store-level plus RLS access control on any new table, nothing deleted, a test file per new domain/server module with each acceptance criterion covered, `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Layering (ports & adapters, horizontal layers):** pure logic (period resolution, row building, CSV encoding/escaping, sorting) belongs in `src/domain/` with zero framework or DB imports; extend the existing `src/domain/csv.ts` rather than duplicating quoting logic. Store access and server actions live in `src/server/`. No feature folders.
- **Read only through stores:** every source (attendance, interviews, training/enrolments, assignments, backfilled entries, evaluations, leave) is read through its own repository; no direct table or fixture reads. LMS enrolments come only via `training-store.ts` (the sole caller of the LMS adapter); honour its `stale` flag / `LmsUnavailableError` contract.
- **Store contracts:** `null` for not-found reads, typed errors for validation/authorization failures. Visibility scoping is role-asymmetric and enforced at the store layer; interview stores check the Administrator role directly rather than resolving the department chain.
- **Manager authority:** the `manager` role and its department subtree are derived fresh on every request from the manages-relationship (department hierarchy walk), never cached in the session. An Administrator is always `admin` even if they also manage a department.
- **Audit:** write through the existing append-only `audit_events` table (actor, target, action, safe metadata, server timestamp) introduced with account archive/restore.
- **Provenance:** history rows distinguish tracked assignments from employee-backfilled entries via an explicit materialized `provenance: 'assignment' | 'backfilled'` field, never inferred from source table.
- **Dates:** ISO 8601 at rest; org timezone `Asia/Dhaka`. Server-action results use the `{ error, message }` `ActionState` shape.
- **Working week:** Monday to Friday, matching the leave calculator's Saturday/Sunday weekend; reuse `src/domain/leave.ts` for working-day counts.
- **Secrets:** the Supabase service-role key is server-only; never expose it to the client.

## UX & Interaction Patterns

- Single-employee entry point: "Download activity" on an employee's profile. Bulk entry point: "Download activity (all employees)" on the directory, with an "Include archived" checkbox.
- Period picker offers this week, last week, month + year, year, custom range and all time; validation errors shown inline with no download.
- Controls must be keyboard-operable; status conveyed by text, not colour alone; displayed dates use `D MMM YYYY`. Meet the WCAG 2.2 AA palette established by the contrast-remediation epic.

## Cross-Story Dependencies

- 8.1 and 8.2 depend on Epic 1 (named accounts, persistence, `audit_events`) and on the stores from Epics 1-3 (attendance, interviews, training, LMS enrolments).
- 8.2 reuses 8.1's timeline builder, CSV encoder, period resolution and audit write; 8.3 and 8.4 extend the same pipeline rather than adding parallel paths.
- 8.3 depends on Epic 4 department-manager authority and interview privacy for managers (Stories 4.2-4.4) and on account archiving scoping.
- 8.4 depends on Epic 4 assignments, evaluations and backfilled projects (Stories 4.5-4.7) and Epic 5 leave records (Stories 5.2-5.3).
