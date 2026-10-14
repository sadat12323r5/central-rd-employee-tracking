# Epic 7 Context: Editable Employee Records

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Until now nobody could add a new employee or keep an employee's record current without a developer editing `src/data/employees.ts`. This epic gives the Administrator (org-wide) and Department Managers (within their own department subtree) the screens to add new employees, each placed in a department from the start, and to maintain basic details, employment history, skills assessments and the evaluation summary. Employees can edit their own employment history. Each field moves into the database as its story lands, so once this epic and the earlier epics are done the fixture file is used only for seeding.

## Stories

- Story 7.1: Add a new employee
- Story 7.2: Edit an employee's basic details
- Story 7.3: Maintain employment history
- Story 7.4: Record skills assessments and the manager evaluation

## Requirements & Constraints

- **Authorized manager:** the Administrator for anyone, or a Department Manager for employees in their own department subtree. Manager scope is resolved fresh on every request, never cached.
- **Who can edit what:**
  - Basic details, skills and the evaluation summary: authorized managers only. Staff are rejected at the server, even on their own record, and see skills and the evaluation read-only.
  - Employment history: authorized managers, plus the employee for their own record only.
- **New employees:** need Employee ID, name, title, team, email, department, manager, office and employment type. A department is required at creation. A duplicate Employee ID or primary email is rejected. A Department Manager cannot add someone to a department outside their subtree.
- **Department changes:** an employee's department is never changed through basic-details editing. Department changes go only through a transfer (`employees-store.transfer()`).
- **Nothing is hard-deleted:** a removed employment-history entry disappears from the Employment tab but stays in history.
- **Display:** employment history is shown newest first. Migrating the demo employment history must leave the Employment tab looking the same. Skills (rated 1–5 with supporting evidence) and the evaluation summary (strengths, development priorities, readiness) show on the Skills & evaluation tab.
- **Deferred, out of scope:** correcting past clock-in/out entries; creating or editing training entries outside the LMS; Administrator editing of Staff-authored interview outcomes (these stay read-only).
- **Definition of Done (every story):**
  - Every server action validates input with zod before calling a store.
  - Access control has two layers: a store-level check and a database RLS policy for each new table. Neither replaces the other.
  - For Staff actions on their own record, the employee ID comes from the session, never from the form.
  - No hard-delete paths.
  - Each new `src/domain/*` or `src/server/*` module gets a matching `tests/*.test.ts`, and every acceptance criterion has an automated test.
  - Unique identifiers (Employee ID, primary email, skill identifiers) are enforced with database constraints.
  - `npm run check` and `npm run test:e2e` pass.
- **Accessibility and format:** controls work with the keyboard alone; status always has a text label, not only a colour; dates render as `D MMM YYYY`; target is WCAG 2.2 AA.

## Technical Decisions

- **Layering:** `src/domain/` is pure, with no framework or database imports. `src/server/` holds the store interfaces and their implementations, following the `AttendanceStore` shape. `src/app` and `src/components` are the UI. Do not create feature folders.
- **Repository rule:** every entity is accessed through a store in `src/server/`; employee data goes through `employees-store.ts`, never a direct fixture or database import. A store returns `null` for a not-found read and throws a typed error for validation or authorization failures. Do not mix the two for equivalent cases.
- **Invariants are enforced in the store:** cross-entity invariants (department required and existing, scope checks) are enforced at the store layer. A domain or UI check is fine as an extra, but never as the only one.
- **Department authority:** use the pure authority-chain resolver in `src/domain/departments.ts`, which walks up parent departments. Departments form a self-referencing hierarchy; every employee has exactly one required `department_id`.
- **Account creation stays separate:** adding an employee does not create an account. Accounts are created only through `accounts-store.create()` (Story 1.3), and nothing creates one as a side effect.
- **Sessions:** a session has one of three roles, `admin`, `manager` or `staff`. `manager` is derived each request from managing at least one department, and an Administrator is always `admin`. An `admin` or `manager` linked to an employee gets a "My record" area with the same own-record rules as Staff.
- **Conventions:**
  - Server actions return `ActionState`, shaped `{ error, message }`.
  - Dates are stored as ISO 8601 strings; the org timezone is `Asia/Dhaka`.
  - Employee IDs match `^BS-\d{4}$`.
  - Files are kebab-case and entities PascalCase singular.
  - A record's subject `employeeId` comes from the target record; the author comes from the session.
- **Persistence:**
  - Supabase Postgres with RLS, using forward-only SQL migrations in `supabase/migrations/`. A migration is applied to the single shared Supabase project only once its PR is approved.
  - RLS tests are Vitest integration tests that sign in as `admin`, `manager` and `staff`. They use dedicated test accounts and rows the test creates and removes itself, never the seeded demo employees.
  - The service-role key is server-only.
- **Fixture migration:** Story 7.3 moves the demo employment history into the database, and Story 7.4 moves the skills and evaluation data. After 7.4, neither is read from `src/data/employees.ts`.
- **Audit:** only archive/restore and transfer have defined `AuditEvent` records. Which other changes get audited has not been decided, so do not invent audit requirements.

## UX & Interaction Patterns

- Edits appear on the existing employee profile tabs: Overview/basic details, Employment, and Skills & evaluation. After migration the Employment tab must look unchanged.
- A new employee shows up in the directory straight away and can then be given an account through the existing provisioning flow.
- Hiding controls in the UI is not enough; every forbidden action must also be rejected at the server.

## Cross-Story Dependencies

- **Depends on Epic 1:** persistence, real accounts, and account provisioning (Story 1.3 provides accounts for new employees).
- **Depends on Epic 4:** departments and the department list, manager authority and subtree scoping, the transfer path (Story 4.8, the only way to change a department), and "My record" for managers (Story 4.10).
- **Fixture fields owned elsewhere:** Story 1.1 already persists basic details, summary, status, join date and avatar. Within this epic, 7.3 owns employment history and 7.4 owns skills and the review.
