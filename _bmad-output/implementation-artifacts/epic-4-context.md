# Epic 4 Context: Assignment History & Department-Manager Evaluation

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Introduce departments and department managers so that managers get admin powers scoped to their own department subtree (never interviews), while the Administrator stays the only org-wide role. Replace today's single overwritten "current work" record with a full assignment history that managers create, close, and evaluate (with optional relayed client feedback), which employees can see read-only and add to by backfilling untracked past projects. Higher managers can transfer employees between departments and archive or restore accounts in their own subtree, and managers keep their own self-service through "My record". This gives the L&D manager objective, timestamped evidence of each employee's track record.

## Stories

- Story 4.1: Administrator manages the department list
- Story 4.2: Administrator assigns a department manager
- Story 4.3: Managers see only their own department
- Story 4.4: Interview privacy holds for managers
- Story 4.5: Managers create and close assignments
- Story 4.6: Manager evaluates a closed assignment; employee sees it
- Story 4.7: Staff backfills a past project
- Story 4.8: Higher manager transfers an employee between departments
- Story 4.9: Managers archive and restore accounts in their own department
- Story 4.10: Managers use "My record" for their own self-service

## Requirements & Constraints

- **Departments:** Administrator-only list (create, rename, set parent); names unique; no delete path (retiring departments is deferred). Every employee belongs to exactly one department. Staff pick from the list only when backfilling and can never add departments.
- **Assignments:** created by the Administrator or a manager with authority over the employee's department. Fields: client, project name, employee's role, allocation, start date, a "latest update" note (the only field editable while open), plus status and completion date. Identifying fields lock after creation. At most one open assignment per employee. Closing moves it into history; nothing is ever overwritten or deleted.
- **Evaluations:** only on closed assignments; one per assignment (a second record is rejected, so amending is the only path); optional client-feedback note about the service, relayed by the manager. Employees view them read-only and can never write them.
- **Backfilled projects:** employee-authored (department from the list, client, project name, completion date, outcome); only the owner can edit or withdraw them (withdrawn entries are kept and marked). Admin and managers can view but not edit them.
- **Visibility:** assignment, evaluation and backfill history is visible to the employee, managers over them, and the Administrator, never to other Staff. Interviews are never visible to any manager, including through direct queries (zero rows from both the store and the database). A manager's own interviews are hidden from managers above them.
- **Transfers:** one step, only by an account with authority over both the source and destination departments; blocked while the employee has an open assignment; past assignments keep their recorded department; training history follows the employee; one audit row (who, whom, from, to, when).
- **Manager archive/restore:** same behaviour as Administrator archiving (access ends next request, history kept, reversible, audit row), limited to the manager's subtree. Rejected for the manager's own account and for accounts with equal or higher authority (managers of their own or ancestor departments, or Administrators).
- **Migration:** each fixture "current work" record becomes an open assignment (client "Not recorded"; start date from the period, falling back to join date). The "recorded Git activity" sample is dropped and its panel removed (Git tracking is a non-goal).
- **Definition of Done (every story):** zod validation in every server action; both a store-level check and an RLS policy on every new table; own-record identity from the session; no hard deletes; a test file for each new domain/server module, with each acceptance criterion covered; DB uniqueness constraints; `npm run check` and `npm run test:e2e` pass.
- **UX baseline:** keyboard-operable controls, status shown as a text label as well as colour, dates in `D MMM YYYY`.

## Technical Decisions

- **Layers:** pure rules in `src/domain/` (no framework or DB imports); store interfaces and implementations in `src/server/` following the `AttendanceStore` shape; no feature folders. New modules: `domain/departments.ts`, `server/departments-store.ts`, `assignments-store.ts`, `assignment-evaluations-store.ts`, `backfilled-project-store.ts`; `employees-store.transfer()` and `accounts-store.archive()/restore()` are extended.
- **Store contract:** `null` for not-found reads; typed errors for validation and authorization failures. Cross-entity invariants are enforced at the store, which is the load-bearing point; domain checks are optional extras.
- **Three separate records, single writer each:** `Assignment` has no evaluation-shaped fields. Only `assignments-store` writes `status`/`completionDate`. The evaluations store rejects writes against a non-closed assignment and never force-closes it. `create()` copies `department_id` from the employee (never caller-supplied), and nothing updates it afterwards.
- **Provenance:** history rows returned to admin/manager views carry an explicit, materialized `provenance: 'assignment' | 'backfilled'` field, never inferred from the source table.
- **Authority set:** the department's own manager, plus every ancestor department's manager, plus every Administrator (unconditionally). It is computed fresh on each request or write and never cached in the session. Any member of the set may create or amend an evaluation; every write records `authoredBy` and `updatedAt`. Never implement this as an "is Administrator" check. The one exception is interviews, which check the Administrator role directly.
- **Hierarchy:** `Department` has an optional `parent_department_id`. The store rejects cycles at write time. The domain chain walker also has a visited-set guard that raises an error instead of looping, but this is a backup and does not replace the store check. Assignment and backfill stores reject department ids that are not in the list.
- **Session roles:** a discriminated union of `admin` / `manager` / `staff`. `manager` is derived on every request from managing at least one department. An Administrator account is always `admin`, even when it also manages a department. Admin and manager accounts linked to an employee also carry `employeeId`, which enables "My record" under the Staff own-record rules.
- **Accounts:** only `accounts-store.create()` creates accounts. Assigning a manager requires an existing account, so the action is rejected with a prompt to provision one first; it never creates an account as a side effect.
- **Audit:** archive/restore and transfer write a minimal `AuditEvent` (actor, target, action, timestamp) in the same transaction as the change.
- **Seed:** L&D (top-level, managed by the Administrator) and Central R&D (parent L&D, no manager yet, so authority resolves to L&D's manager).
- **Formats:** ISO 8601 dates at rest; employee IDs `^BS-\d{4}$`; action results use the `{ error, message }` shape. A record's subject `employeeId` is derived from the target record (for example, an evaluation's assignment) and kept separate from `authoredBy`.
- **Persistence/RLS:** Supabase with forward-only migrations in `supabase/migrations/`, applied to the shared project only once the PR is approved. RLS tests sign in as admin, manager and staff test accounts, using only test-created rows and never the seeded demo data. The service-role key is server-only.

## UX & Interaction Patterns

- For manager sessions, the management portal hides the profile Interviews tab and the org-wide "Interviews & placements" view. Directory, profile, L&D, attendance and CSV export views are filtered to the manager's subtree.
- The directory shows each person's department.
- The profile's Current work tab shows the open assignment plus the full history, with each row marked self-reported or manager-created.
- The staff portal shows the employee's assignment history and evaluations read-only, plus backfill add/edit/withdraw.
- "My record" appears in the management portal only for accounts linked to an employee record.

## Cross-Story Dependencies

- Stories build strictly in order: 4.1, then 4.2 (managers need departments), 4.3 and 4.4 (scoping needs the manager role), 4.5, 4.6 (evaluations need closed assignments), 4.7, 4.8 (transfers need the open-assignment check), 4.9, 4.10.
- Builds on Epic 1: persistence, `accounts-store` provisioning (1.3), archive/restore and `audit_events` (1.4; 4.9 reuses that behaviour). Builds on Epic 2 (interview store and privacy, which 4.4 and 4.10 extend) and Epic 3 (training views that 4.3 scopes and 4.10 reuses).
- Epics 5 (managers recording leave), 7 (departments and manager authority for employee records) and 8 (manager-scoped exports, assignments and evaluations in exports) depend on this epic.
