---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - '_bmad-output/planning-artifacts/prds/prd-AI-DLC-Employee-management-2026-09-25/prd.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md'
  - 'docs/SRS.md'
---

# L&D Manager Workspace - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the L&D Manager Workspace, decomposing the requirements from the PRD and the Architecture Spine into implementable stories. No UX design contract exists for this project. Already-shipped work (Employee Directory & Profiles, Staff Attendance) is excluded — this breakdown covers what still needs to be built.

## Requirements Inventory

### Functional Requirements

FR-1: Staff can add an external interview record (company, role, date, stage) for their own record.
FR-2: Staff can update an interview's stage and, once known, outcome and feedback; company/role/date lock after creation; the employee can withdraw their own entry (kept in history, marked withdrawn, never deleted).
FR-3: Interview visibility is the Administrator (L&D manager) + the reporting employee only — Department Managers excluded even within their own department.
FR-4: Staff (and the Administrator, on the employee's profile) can view current LMS enrolments, synced from BrainStation's LMS via a stub adapter that returns demo in-progress training until the real LMS is connected. Training always comes from L&D; no department is recorded on enrolments.
FR-5: Staff can view their full completed-training history, independent of the live LMS sync.
FR-6: The Administrator, or a Department Manager over the employee's department, creates and closes Assignment records; closing archives instead of overwriting; the assignment's department is copied from the employee and frozen.
FR-7: A Department Manager with authority over the assignment's department (or the Administrator) evaluates a closed Assignment, with an optional client-feedback note on the service; visible read-only to the employee.
FR-8: Staff can backfill, edit, and withdraw their own standalone historical project entries for work never tracked by an Assignment; the Administrator and managers can view but not edit them.
FR-9: Assignment and project history is visible to the reporting employee, Department Managers over them, and the Administrator — never to other Staff.
FR-10: Administrators manage the department list (hierarchical, parent/child); every employee belongs to exactly one department; Staff pick from it only when backfilling, cannot add departments themselves.
FR-11: A manager with authority over both the employee's current and destination departments transfers them directly (one step); blocked while the employee has an open assignment; past Assignments keep their recorded department; minimal audit record.

### NonFunctional Requirements

NFR-SEC-001: Demo password comparison uses constant-time comparison (already implemented; applies to any new credential checks).
NFR-SEC-002: Session secrets and demo credentials read only from environment configuration, never hard-coded, excluded from source control.
NFR-SEC-003: Demo banner and login page disclose that all data is fictional and production accounts aren't connected.
NFR-SEC-004: Single shared credential + no per-record authorization means this build must not be exposed with real employee data under any configuration — the production release gate (Architecture AD-6, PRD §4.4).
NFR-REL-001 (retired, successor stated): "No failure mode where partial data loads, because there is no external data source" no longer holds once FR-4's LMS adapter and Supabase persistence land. Successor (Architecture AD-3): every network-dependent read surfaces a stale/unavailable/loading state rather than silently returning partial or stale-looking-fresh data.
NFR-UX-001: Interactive controls reachable and operable by keyboard alone.
NFR-UX-002: Status conveyed with a text label in addition to colour.
NFR-UX-003: Dates render in unambiguous `D MMM YYYY` format.
NFR-UX-004: Workspace targets WCAG 2.2 AA; colour-contrast is a known, tracked gap requiring a deliberate palette pass (PRD §4.8).

### Additional Requirements

- No starter template — brownfield on the existing Next.js 15.5.26/React 19/TypeScript prototype. Epic 1's first story extends the existing structure, it does not scaffold a new one.
- Every new entity accessed through a repository/store interface in `src/server/`, matching the existing `AttendanceStore` shape (Architecture AD-1); `auth.ts`'s direct `import { employees }` is a pre-existing violation to fix.
- `Assignment`, `AssignmentEvaluation`, and `BackfilledProjectEntry` are three separate records with a single writer each — no evaluation-shaped fields on `Assignment` (Architecture AD-2).
- `src/server/lms-client.ts` ships as a stub adapter with a concrete contract (`{ data, asOf, stale }` / `LmsUnavailableError`); `training-store.ts` is the sole caller (Architecture AD-3).
- `AssignmentEvaluation` write-authorization resolves to a set (the Assignment's Department's manager, every ancestor's manager, and every Administrator, unconditionally) computed fresh per request; any authorized account may create or amend, with `authoredBy` recorded (Architecture AD-4).
- Sessions carry one of three roles: `admin` (org-wide), `manager` (derived fresh each request from managing at least one Department; management portal scoped to their subtree; never sees interviews), `staff` (Architecture Consistency Conventions).
- `Department` is a self-referencing hierarchy; `departments-store.ts` rejects any write that would introduce a cycle (Architecture AD-5). Seed data: L&D (top-level, managed by the Administrator) and Central R&D (sub-department of L&D, manager not yet assigned).
- All account creation (Administrator or Staff) funnels through one repository method; no self-registration. Accounts are archived, never deactivated or deleted: archiving ends access on the next request, keeps all history, hides the employee from the default directory, and is reversible via restore; each archive/restore writes a minimal audit record (Architecture AD-6).
- Every employee has exactly one department; an Assignment's department is copied from the employee at creation and frozen; a transfer is blocked while the employee has an open assignment (Architecture AD-2, AD-5).
- Every new server action validates input with zod before touching a store (Architecture AD-7).
- Named uniqueness constraints (Employee ID, primary email, skill/training/interview identifiers) have no app-layer check today — accepted gap until Supabase lands (SRS 11.2, Architecture AD-1).
- Production identity & persistence (Supabase Auth + Postgres + RLS, SRS 11.1/11.2) gates all of the above going live with real data — it is the release gate, not an independent epic to sequence anywhere but first among the roadmap items.
- SRS 11.4 Leave workflow: `src/domain/leave.ts` already exists and is fully tested; only the repository/server-action wiring is unbuilt, and it depends on production persistence plus a holiday-calendar decision (PRD §4.7).
- Deployment & Environments open items named but undecided (Architecture spine): Supabase org/project/environment mapping, forward-only migration tooling, RLS-policy test strategy, `AuditEvent` beyond its minimal form, secrets/env-var cutover strategy, staged-vs-big-bang cutover, whether Vercel+Supabase remains the target stack post-demonstration.
- Gating configuration decisions (org timezone, approved holiday calendar, data retention periods) are System Owner approvals, not engineering — block persistence and leave-workflow epics, not story-writable themselves (PRD §4.7).
- Colour-contrast remediation (PRD §4.8, SRS 11.7, NFR-UX-004) is independent CSS/token work with no dependency on anything else — can be its own small epic, sequenced anywhere.

### UX Design Requirements

None — no UX design contract exists for this project.

### FR Coverage Map

FR-1: Epic 2 - Staff can add an external interview record
FR-2: Epic 2 - Staff can update or withdraw an interview
FR-3: Epic 2 (and Epic 4, Story 4.4, for managers) - Interview visibility is Administrator + reporting employee only
FR-4: Epic 3 - Staff and Administrator view current LMS enrolments
FR-5: Epic 3 - Staff view completed-training history
FR-6: Epic 4 - Managers create and close Assignment records
FR-7: Epic 4 - Department Manager evaluates a closed Assignment
FR-8: Epic 4 - Staff backfill, edit, and withdraw historical project entries
FR-9: Epic 4 - Assignment/project history visibility scoping
FR-10: Epic 4 - Administrators manage the department list
FR-11: Epic 4 - Higher manager transfers an employee between departments

Epics 1, 5, 6, and 7 cover Additional/NFR requirements (SRS 11.1/11.2/11.3/11.4, NFR-SEC-004, PRD §4.5/§4.8, NFR-UX-004) rather than numbered FRs — see Epic List below.

## Epic List

**Approved 2026-10-01.** Revised the same day after final validation and a re-check (see `epics-validation.md`): Epic 1 reordered, Epic 4 split to ten stories, Epic 5 dependency on Epic 4 declared, Epic 7 deferrals recorded.

### Epic 1: Real Accounts & Durable Data
Administrators and Staff sign in with real, individually-provisioned accounts instead of one shared demo credential, and everything they enter survives a restart. Standalone and complete on its own — the release gate every other epic depends on.
**Covers:** SRS 11.1/11.2, NFR-SEC-004 (no numbered FRs — the infrastructure every FR below needs to hold real data).

### Epic 2: Staff-Reported External Interviews
Employees tell the L&D manager they're interviewing elsewhere as it happens, and update the outcome once they hear back.
**FRs covered:** FR-1, FR-2, FR-3

### Epic 3: Training Visibility
Employees see what they're currently enrolled in (synced from BrainStation's LMS) and their full completed-training history.
**FRs covered:** FR-4, FR-5

### Epic 4: Assignment History & Department-Manager Evaluation
Departments and department managers come into being; managers get admin powers scoped to their own department (never interviews); assignments are kept as full history and evaluated, with optional client feedback; employees see their evaluations and backfill untracked history; higher managers transfer employees; managers archive accounts in their own department and keep their own self-service through "My record".
**FRs covered:** FR-6, FR-7, FR-8, FR-9, FR-10, FR-11, plus the manager side of FR-3 — kept as one epic since all share the same tightly-coupled domain (Architecture AD-2/AD-4/AD-5).

### Epic 5: Leave Workflow
A real leave-record workflow — create/edit/cancel, overlap rejection, holiday-calendar awareness — replacing the unused `leave.ts` domain logic, and making the attendance summary fully real.
**Covers:** SRS 11.4. Depends on Epic 1, Epic 4 (managers record leave for their own department), and the holiday-calendar decision (PRD §4.7, outside engineering).

### Epic 6: Colour-Contrast Remediation
Every user gets a workspace that actually meets WCAG 2.2 AA colour contrast, closing the one known accessibility gap.
**Covers:** PRD §4.8, NFR-UX-004. No dependency on anything else — sequencing is flexible.

### Epic 7: Editable Employee Records
*Added 2026-10-01 after a coverage gap surfaced during Epic 4: PRD §4.5 had no epic, so nobody could add a new employee.*
Administrators (and Department Managers within their own department) add new employees — placed in a department from the start — and maintain basic details, employment history, skills, and the evaluation summary; employees edit their own employment history.
**Covers:** PRD §4.5, SRS 11.3 (partly — see Epic 7's deferrals). Depends on Epic 1 (persistence) and Epic 4 (departments, manager authority).

**Dependency flow:** Epic 1 gates Epics 2–5 and 7; Epic 4 gates Epics 5 and 7; Epic 6 is independent.

## Definition of Done (applies to every story)

Rather than repeating these in each story, every story is done only when all of the following hold:

- **Validation:** every new server action validates its input with a zod schema before calling a store (AD-7).
- **Two layers of access control:** every new table gets both a store-level check and a database (RLS) policy; neither substitutes for the other (AD-1, PRD §4.4).
- **Session-owned identity:** for Staff actions on their own records, the employee ID comes from the session, never from submitted form data.
- **Nothing deleted:** records are corrected by editing, or withdrawn/cancelled/archived and kept in history; no story adds a hard-delete path.
- **Tests:** every new `src/domain/*` or `src/server/*` module gets a matching `tests/*.test.ts`, and each acceptance criterion below is covered by an automated test; RLS policies are tested against real database roles once the RLS test strategy is decided (Architecture Deployment & Environments).
- **Uniqueness:** identifiers that must be unique (Employee ID, primary email, and interview, training, and skill identifiers) are enforced by database constraints for any table a story creates (SRS 11.2).
- **CI:** `npm run check` and `npm run test:e2e` pass.

## Epic 1: Real Accounts & Durable Data

Administrators and Staff sign in with real, individually-provisioned accounts instead of one shared demo credential, and everything they enter survives a restart. Covers SRS 11.1/11.2 and NFR-SEC-004; governed by Architecture AD-1, AD-6, AD-7. Employee records move first, because sign-in, provisioning, and archiving all need them.

**Preconditions (not stories):**
- The shared Supabase project exists (one project for dev, previews and the demo, split before real data), and its keys are set in `.env.local` and Vercel. The setup decisions (environments, CLI migrations, Vitest RLS tests, secrets, staged cutover) were made 2026-10-02; see the architecture spine, Deployment & Environments.
- ~~The System Owner has approved the org timezone and data retention periods (PRD §4.7).~~ Approved 2026-10-02: `Asia/Dhaka`, indefinite retention.
- The "all data is fictional" banner (NFR-SEC-003) stays until real employee data is loaded. Removing it is a System Owner decision, not part of any story.

### Story 1.1: Employee records persist with role-scoped access

As the L&D manager,
I want employee records stored in a real database,
So that the workspace can safely hold real data instead of compiled fixtures.

**Acceptance Criteria:**

**Given** employees' basic details (ID, name, title, team, status, email, join date, manager, office, employment type, profile summary, avatar initials and colour) are moved from `src/data/employees.ts` into Supabase
**When** an Administrator opens the directory and profiles
**Then** every view renders as before, and the existing component and e2e tests pass against the persisted data

**Given** a Staff identity (a seeded test auth user until Story 1.3 provisions real ones)
**When** employee records are queried
**Then** Row-Level Security returns only that employee's own record

**Given** a second employee with an existing Employee ID or primary email
**When** it is inserted
**Then** the database rejects it (SRS 11.2)

**Given** any code that reads employee records
**When** it runs
**Then** it goes through an `employees-store` interface, and `auth.ts` no longer imports `src/data/employees.ts` directly (AD-1)

**Given** an employee's nested profile data (skills, employment history, evaluation summary, attendance summary)
**When** their profile is opened
**Then** it is still served from the fixture behind `employees-store`, unchanged for callers, until a later story moves it

**Given** the database is unreachable
**When** the directory or a profile is opened
**Then** a clear error state appears instead of an empty or partial list (NFR-REL-001 successor)

### Story 1.2: Administrator signs in with a named account

As the L&D manager,
I want to sign in with my own account instead of a shared demo credential,
So that access to employee data is tied to an accountable person.

**Acceptance Criteria:**

**Given** an Administrator account exists in Supabase Auth
**When** the L&D manager signs in with correct credentials
**Then** they reach the same Administrator workspace as today, with a session carrying the `admin` role
**And** the existing admin/staff routing in `page.tsx` is unchanged

**Given** incorrect credentials
**When** they are submitted
**Then** a generic "incorrect" message appears that doesn't reveal which field was wrong (keeps SRS FR-SESS-001)

**Given** the deployed app
**When** its routes and pages are inspected
**Then** no sign-up or registration route or form exists (AD-6)

**Given** no Administrator exists yet
**When** the one-time seed script runs
**Then** it creates the first Administrator through `accounts-store.create()`
**And** this is the only account ever created outside an Administrator session, and it has no runtime route (the single sanctioned AD-6 exception)

**Given** Supabase auth is configured
**When** someone signs in with the old `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD` credentials
**Then** they are rejected
**And** Supabase keys and secrets are read only from environment configuration, never hard-coded (NFR-SEC-002)

### Story 1.3: Administrator provisions a Staff account

As the L&D manager,
I want to create a sign-in account for an employee,
So that they get their own credentials instead of a shared staff password.

**Acceptance Criteria:**

**Given** a signed-in Administrator
**When** they create a Staff account for an existing employee
**Then** the account is created through `accounts-store.create()` and the employee can sign in with it

**Given** an employee who already has an account
**When** another account is created for them
**Then** it is rejected with a validation error

**Given** a Staff session
**When** it calls the provisioning action directly
**Then** it is rejected at the server, not just hidden in the UI

**Given** Supabase auth is configured
**When** someone signs in with the shared `DEMO_STAFF_PASSWORD`
**Then** they are rejected

**Given** a signed-in Staff member
**When** they use the app
**Then** they see only their own portal and cannot open the Administrator portal (shipped behaviour kept)

**System Owner decisions (2026-10-06):**
- **Credential delivery:** the Administrator sets an initial password when creating the Staff account and passes it on outside the app.
  - No invite or magic-link email: the shared project has no SMTP, and the free default mailer is rate-limited.
  - A forced password change at first sign-in is not part of this story.
- **Demo access:** the shared `DEMO_STAFF_PASSWORD` sign-in is retired.
  - A seed step creates one real demo Staff account, linked to a fictional seeded employee, so the staff portal can still be demonstrated.
  - Its email and password come from environment variables and are never published on the sign-in page or in the repo.
  - CI and e2e provision their own throwaway Staff account through the service role.
- **Carry-over from Stories 1.1 and 1.2:**
  - Link `employees.auth_user_id` when an account is created.
  - Switch staff reads and the sign-in lookup from the service-role client to the per-request JWT client.
  - Retire the HMAC staff cookie.

### Story 1.4: Administrator archives and restores an account

As the L&D manager,
I want to archive an employee's account instead of deleting it,
So that someone who leaves loses access immediately, their history is kept, and they can be restored if they come back.

**Acceptance Criteria:**

**Given** this story ships
**When** the database is migrated
**Then** an append-only `audit_events` table exists (actor, target, action, server timestamp), and no code path can update or delete its rows

**Given** an active account with a live session
**When** the Administrator archives it
**Then** that session's next request is treated as signed out

**Given** an archived account
**When** it tries to sign in
**Then** sign-in fails with the same generic "incorrect" message

**Given** an archived employee
**When** the Administrator views the directory
**Then** the employee is hidden by default but appears under an "archived" filter, with all their history unchanged

**Given** an archived account
**When** the Administrator restores it
**Then** the employee can sign in again and reappears in the default directory

**Given** an archive or restore
**When** it completes
**Then** it went through `accounts-store.archive()` / `restore()` and wrote one `audit_events` row in the same transaction

**Given** a Staff session
**When** it calls archive or restore directly, on any account including its own
**Then** it is rejected at the server

**Given** the Administrator's own account
**When** they try to archive it
**Then** it is rejected

### Story 1.5: Staff attendance survives restarts

As an employee,
I want my clock-ins and daily logs to survive a server restart,
So that my attendance record is actually reliable.

**Acceptance Criteria:**

**Given** a Staff member clocks in and writes a daily log
**When** the server restarts
**Then** the entries are still there

**Given** a Staff session
**When** attendance is queried
**Then** only that employee's own entries are returned (RLS)

**Given** an Administrator session
**When** attendance is queried
**Then** every employee's entries are returned

**Given** the existing attendance tests
**When** the store's implementation moves from in-memory to Supabase
**Then** the `AttendanceStore` interface is unchanged and the tests pass

**Given** the database is unreachable
**When** a Staff member opens attendance or tries to clock in
**Then** a clear error appears and nothing is silently lost or shown as saved

## Epic 2: Staff-Reported External Interviews

Employees tell the L&D manager they're interviewing elsewhere as it happens, and update the outcome once they hear back. Covers FR-1, FR-2, FR-3. FR-3's privacy rule is built into both stories rather than a separate one, so interview data never exists without it enforced. Department Managers arrive in Epic 4; Story 4.4 adds an explicit test that they're excluded too.

### Story 2.1: Staff adds an external interview

As an employee,
I want to record an interview I have with another company,
So that the L&D manager knows without a side conversation.

**Acceptance Criteria:**

**Given** a signed-in Staff member
**When** they add an interview (company, role, date, stage)
**Then** it is saved to their own record and appears in their staff portal
**And** stage and outcome are free text, matching existing data

**Given** a submitted form containing a different employee's ID
**When** it is saved
**Then** the entry is saved to the signed-in employee, not the one in the form

**Given** the entry is saved
**When** the Administrator opens that employee's Interviews tab or the org-wide "Interviews & placements" view
**Then** it shows there with no extra step

**Given** the existing fixture interviews
**When** this story ships
**Then** they are moved into the new interviews table, so every view reads from one source

**Given** any session that is neither the reporting employee nor an Administrator
**When** interviews are queried
**Then** the database (RLS) returns none of that employee's entries
**And** the check is "is this the employee, or an Administrator", not a department lookup, so future Department Managers are excluded automatically (FR-3)

### Story 2.2: Staff updates or withdraws an interview

As an employee,
I want to update an interview as it progresses, or withdraw one I entered by mistake,
So that my record stays accurate.

**Acceptance Criteria:**

**Given** an interview the employee added
**When** they change its stage, outcome or feedback
**Then** the change is saved

**Given** an existing entry
**When** anyone tries to change its company, role or date
**Then** the change is rejected; those fields lock after creation (FR-2)

**Given** an interview the employee added
**When** they withdraw it
**Then** it leaves their active views and the Administrator's active views, but stays in history marked "withdrawn" and remains visible to the Administrator

**Given** a withdrawn interview
**When** the employee adds a corrected entry
**Then** the new entry is saved normally and the withdrawn one is unchanged

**Given** another Staff member's entry
**When** someone tries to edit or withdraw it
**Then** it is rejected at the server

**Given** a Staff-authored entry
**When** the Administrator views it
**Then** it is read-only for them (FR-2 interim default)

## Epic 3: Training Visibility

Employees see their full training history and what they're currently enrolled in on BrainStation's LMS. Covers FR-4, FR-5; governed by Architecture AD-3 (LMS stub adapter, `training-store` as sole caller, stale/unavailable/loading states as NFR-REL-001's successor). Training always comes from L&D, so enrolments carry no department. **The split is strict: history holds completed courses (stored entries plus courses the LMS reports as completed); "Current" holds only in-progress LMS enrolments; an entry never appears in both or twice.**

### Story 3.1: Staff views their completed-training history

As an employee,
I want to see every training programme I've completed,
So that I don't have to ask whoever tracks it.

**Acceptance Criteria:**

**Given** a signed-in Staff member
**When** they open training in their portal
**Then** they see all their completed training entries (programme, provider, completion date, result)

**Given** the existing fixture training data
**When** this story ships
**Then** completed entries move into a training table, and the Administrator's Training tab and the org-wide Learning & Development view read completed training from it, looking the same as before

**Given** the fixture's in-progress training entries
**When** this story ships
**Then** they are not copied into the history table and keep showing as today, served from the fixture behind `training-store`, until Story 3.2 replaces their source

**Given** a Staff session
**When** training is queried
**Then** the database (RLS) returns only that employee's own entries

**Given** the training table
**When** its schema is inspected
**Then** it has no department field, so history is never filtered by an employee's current department
**And** all training reads go through `training-store` (AD-1)

### Story 3.2: Staff and Administrator see current LMS enrolments

As an employee,
I want to see what I'm currently enrolled in on BrainStation's LMS,
So that I know where I stand without asking.

**Acceptance Criteria:**

**Given** the real LMS is not connected yet
**When** this story ships
**Then** the fixture's in-progress entries are seeded into a stub-data table that `lms-client`'s stub reads, and nothing reads `src/data/employees.ts` for training at runtime any more

**Given** a signed-in Staff member
**When** they open training in their portal
**Then** current enrolments from `lms-client` appear in a "Current" section (programme, provider, progress, target date), separate from completed history, with no entry in both

**Given** the Administrator
**When** they open an employee's profile Training tab
**Then** the same current enrolments appear there, with the same loading, stale and unavailable handling

**Given** the LMS call is still in progress
**When** training is opened
**Then** a loading state shows in the Current section while history renders immediately

**Given** the LMS responds but its data is stale
**When** enrolments are shown
**Then** they are clearly marked stale with an "as of" time

**Given** the LMS cannot be reached
**When** training is opened
**Then** a clear "unavailable" message replaces current enrolments, and history still shows normally

**Given** the LMS reports a course as completed
**When** training is shown
**Then** it appears in history, not Current, alongside pre-LMS history entries, and only once even if the same course is also stored in the training table (FR-5)

**Given** the org-wide Learning & Development view
**When** it is opened
**Then** in-progress enrolments for every employee come through `training-store` from `lms-client`, with the same loading, stale and unavailable handling, so in-progress figures don't disappear

**Given** any call to the LMS
**When** it is made
**Then** it goes through `lms-client`'s fixed contract (`{ data, asOf, stale }`, or `LmsUnavailableError` when unreachable), and only `training-store` calls it (AD-3)

## Epic 4: Assignment History & Department-Manager Evaluation

Departments and department managers come into being; managers get admin powers scoped to their own department and its sub-departments (never interviews); assignments are kept as full history and evaluated; employees see their evaluations and backfill untracked history; higher managers transfer employees; managers archive accounts in their own department. Covers FR-6 to FR-11 and the manager side of FR-3; governed by Architecture AD-2, AD-4, AD-5, AD-6 and the three-role session convention. Stories build strictly in order: departments, managers, manager scoping, interview privacy, assignments, evaluations, backfill, transfers, archiving.

### Story 4.1: Administrator manages the department list

As the L&D manager,
I want to maintain the list of departments and their parent/sub-department structure,
So that every employee and every piece of project work belongs to a real department.

**Acceptance Criteria:**

**Given** the Administrator
**When** they add or rename a department, or set its parent
**Then** the change is saved

**Given** a department name that already exists
**When** another department is saved with it
**Then** it is rejected

**Given** a change that would make a department its own ancestor
**When** it is saved
**Then** it is rejected at the store, not just in the UI (AD-5)

**Given** the department list
**When** any user looks for a way to delete a department
**Then** none exists; retiring departments is deferred

**Given** this story ships
**When** the database is seeded
**Then** L&D (top-level) and Central R&D (under L&D) exist, every existing employee belongs to exactly one department, and the directory shows each person's department

**Given** a Staff session
**When** it calls any department action
**Then** it is rejected at the server (FR-10)

### Story 4.2: Administrator assigns a department manager

As the L&D manager,
I want to make someone the manager of a department,
So that they can run their own team without needing org-wide access.

**Acceptance Criteria:**

**Given** the Administrator
**When** they make an existing account the manager of a department
**Then** that account's session carries the `manager` role from its next request, and it reaches the management portal

**Given** a person with no account
**When** the Administrator tries to make them a manager
**Then** it is rejected with a message to provision an account first (Story 1.3)

**Given** a manager is removed from a department and manages no other
**When** their next request arrives
**Then** their session role reverts to `staff`

**Given** an Administrator account that also manages a department (as the seeded L&D manager does)
**When** its session role is derived
**Then** it is always `admin`, never downgraded to `manager`, so it keeps org-wide access including interviews

**Given** this story ships
**When** the database is seeded
**Then** L&D is managed by the Administrator, and Central R&D has no manager yet

**Given** any department-scoped permission check
**When** it runs
**Then** authority is worked out fresh by walking up the department tree in `src/domain/departments.ts`, with a guard that stops with an error rather than looping forever (AD-4, AD-5)

**Given** a manager session
**When** it tries to add, rename or re-parent a department
**Then** it is rejected; the department list stays Administrator-only (FR-10)

**Given** any department
**When** the Administrator acts on it
**Then** the Administrator keeps full authority regardless of who manages it

### Story 4.3: Managers see only their own department

As a department manager,
I want the management portal to show only my own team,
So that I can work with my people without seeing the rest of the organisation.

**Acceptance Criteria:**

**Given** a manager session
**When** they open the directory, a profile, the org-wide Learning & Development or attendance views, or the CSV export
**Then** only employees in their department and its sub-departments appear

**Given** the manager of Central R&D
**When** they request an L&D employee's profile, attendance, or training directly
**Then** it is rejected at the server

**Given** the employees, attendance, and training tables
**When** a manager's queries run
**Then** both the store checks and the RLS policies limit results to the manager's subtree, while Staff and Administrator access is unchanged

**Given** the Administrator
**When** they use the same views
**Then** they still see every employee

### Story 4.4: Interview privacy holds for managers

As an employee,
I want my job-hunting kept private from my department manager,
So that I can report interviews honestly.

**Acceptance Criteria:**

**Given** a manager session
**When** they open the management portal
**Then** neither the profile Interviews tab nor the org-wide "Interviews & placements" view is shown

**Given** a manager session for a department containing an employee with recorded interviews
**When** it queries interviews directly, bypassing the UI
**Then** zero rows are returned, from both the store and the database (FR-3)

**Given** the same manager
**When** they open that employee's other profile data in their scope
**Then** it shows normally; only interviews are excluded

### Story 4.5: Managers create and close assignments

As a manager,
I want to assign project work to an employee in my department and close it when it's done,
So that every assignment they've ever had is kept instead of overwritten.

**Acceptance Criteria:**

**Given** the Administrator or a manager with authority over the employee's department
**When** they create an assignment (client, project name, the employee's role on it, allocation, start date)
**Then** it is saved with the employee's current department copied onto it automatically, not chosen by the creator (FR-6, AD-2)

**Given** an open assignment
**When** an authorized manager edits its "latest update" note
**Then** the change is saved; the note is the only field editable while the assignment is open

**Given** an employee who already has an open assignment
**When** another one is created for them
**Then** it is rejected

**Given** an existing assignment
**When** anyone tries to change its client, project name, role, department, allocation or start date
**Then** the change is rejected; those fields lock after creation

**Given** an open assignment
**When** it is closed with a completion date
**Then** it moves into the employee's history and is never overwritten or deleted
**And** only `assignments-store.ts` writes status and completion date (AD-2)

**Given** the existing fixture "current work" record for each employee
**When** this story ships
**Then** it becomes an open assignment: project name, role, allocation and latest update carry over; the client is set to "Not recorded" (the fixture has none); the start date comes from the record's period, or the employee's join date if the period can't be parsed
**And** the profile's Current work tab shows the open assignment plus the full history

**Given** the fixture's "recorded Git activity" sample (commits count)
**When** this story ships
**Then** it is not migrated, and the Current work tab no longer shows that panel (Git tracking is a PRD non-goal)

**Given** a manager without authority over the employee's department
**When** they try to create or close an assignment for them
**Then** it is rejected at the server, and the RLS policy on assignments enforces the same subtree scope

### Story 4.6: Manager evaluates a closed assignment; employee sees it

As a manager,
I want to record how a finished assignment went, including the client's feedback on the service,
So that the employee's track record is captured where they and the L&D manager can see it.

**Acceptance Criteria:**

**Given** a closed assignment
**When** any manager with authority over its department, or the Administrator, writes or amends its evaluation, optionally with client feedback on the service
**Then** it is saved with who wrote it and when; a later amendment by another authorized manager is allowed and also recorded (FR-7, AD-4)

**Given** a closed assignment that already has an evaluation
**When** a second evaluation record is created for it
**Then** it is rejected at the store; amending the existing one is the only path

**Given** an open assignment
**When** an evaluation is attempted
**Then** it is rejected, and the assignment is not force-closed (AD-2)

**Given** a Staff session, including the employee the assignment belongs to
**When** it tries to write or amend an evaluation
**Then** it is rejected at the server

**Given** the employee the assignment belongs to
**When** they open their portal
**Then** they see their assignment history and evaluations, read-only

**Given** any other Staff member
**When** they query assignments or evaluations
**Then** none of that employee's records are returned (FR-9)

### Story 4.7: Staff backfills a past project

As an employee,
I want to add projects I did before this system existed,
So that my full track record is in one place.

**Acceptance Criteria:**

**Given** a signed-in Staff member
**When** they add a past project (department from the list, client, project name, completion date, outcome)
**Then** it appears in their history alongside their assignments

**Given** a backfilled entry they own
**When** they edit it
**Then** the change is saved

**Given** a backfilled entry they own
**When** they withdraw it
**Then** it leaves active views but stays in history marked "withdrawn"

**Given** the Administrator or an authorized manager viewing that employee's history
**When** backfilled and manager-created entries are shown together
**Then** each row carries an explicit marker of whether it is self-reported or manager-created (AD-2 provenance)

**Given** the Administrator or a manager
**When** they try to edit or withdraw a backfilled entry
**Then** it is rejected; only the owner can (FR-8)

**Given** another Staff member's backfilled entry
**When** a different Staff member tries to view or edit it
**Then** it is rejected at the server (FR-9)

**Given** a department that isn't in the list
**When** a backfilled entry references it
**Then** it is rejected

### Story 4.8: Higher manager transfers an employee between departments

As a manager over two departments,
I want to move an employee from one to the other,
So that their department reflects where they work now, for example after finishing training in L&D.

**Acceptance Criteria:**

**Given** a manager with authority over both the employee's current department and the destination
**When** they transfer the employee
**Then** the employee's department changes in one step, through `employees-store.transfer()` (FR-11)

**Given** a manager with authority over only one of the two departments
**When** they try to transfer the employee
**Then** it is rejected

**Given** an employee with an open assignment
**When** a transfer is attempted
**Then** it is rejected with a message to close the assignment first

**Given** a completed transfer
**When** the employee's history is viewed
**Then** past assignments still show the department they were done under, their full training history still shows, and one `audit_events` row records who moved whom, from where, to where, and when

**Given** a Staff session
**When** it attempts any transfer, including its own
**Then** it is rejected at the server

### Story 4.9: Managers archive and restore accounts in their own department

As a department manager,
I want to archive and restore accounts for people in my department,
So that I can handle leavers on my own team without going through the L&D manager.

**Acceptance Criteria:**

**Given** a department manager
**When** they archive or restore an account in their department or its sub-departments
**Then** it behaves exactly as in Story 1.4: access ends on the next request, history is kept, it is reversible, and an `audit_events` row is written

**Given** an account outside the manager's subtree
**When** they try to archive or restore it
**Then** it is rejected at the server

**Given** an account with equal or higher authority than the manager (the manager of their own department or any ancestor, or an Administrator)
**When** they try to archive it
**Then** it is rejected

**Given** the manager's own account
**When** they try to archive it
**Then** it is rejected

### Story 4.10: Managers use "My record" for their own self-service

As a department manager,
I want to clock in, record leave, see my training, and report interviews like any other employee,
So that being a manager doesn't cut me off from my own record.

**Acceptance Criteria:**

**Given** a manager account, or an Administrator account, linked to an employee record
**When** they open "My record" in the management portal
**Then** they get the same self-service as the staff portal for their own record: attendance and daily log, interviews, training, and backfill

**Given** "My record"
**When** any action in it runs
**Then** the same own-record rules apply as for Staff: the employee ID comes from the session, and Staff-only restrictions (for example, read-only evaluations) still apply to their own record

**Given** a manager's own interviews
**When** their own department manager or a manager above them views their profile
**Then** the interviews are not shown; only the manager themselves and the Administrator see them (FR-3)

**Given** an account not linked to any employee record
**When** it opens the management portal
**Then** no "My record" area is shown

## Epic 5: Leave Workflow

A real leave-record workflow that puts the already-built, already-tested `src/domain/leave.ts` (working-day counting, the five length categories, overlap detection, validation errors) to use, and makes the attendance summary fully real. Covers SRS 11.4. No approvals, leave reasons or balances (PRD §5). Leave is recorded by the employee for themselves, by Department Managers for their own department, and by the Administrator for anyone. Depends on Epic 1 and Epic 4.

**Precondition (not a story):** the holiday calendar's contents (jurisdiction, timezone, supported years, holiday dates) must be approved by the System Owner (PRD §4.7) before Story 5.1 loads real data.

### Story 5.1: Administrator loads the approved holiday calendar

As the L&D manager,
I want to load the approved holiday calendar,
So that leave can be counted in real working days.

**Acceptance Criteria:**

**Given** an approved calendar (jurisdiction, timezone, supported years, holiday dates)
**When** the Administrator loads it
**Then** it is stored as a versioned calendar, and the store can return it as the `CalendarPolicy` that `src/domain/leave.ts` expects

**Given** the stored calendar and a date outside its supported years
**When** `countWorkingDays` is called with that calendar (tested at the store/domain level)
**Then** it fails with the existing `UNSUPPORTED_YEAR` error instead of guessing

**Given** a non-Administrator session
**When** it tries to load or replace the calendar
**Then** it is rejected at the server

### Story 5.2: Record a leave period

As an employee,
I want to record a leave period,
So that my attendance reflects time I'm away.

**Acceptance Criteria:**

**Given** a start and end date
**When** leave is recorded by the employee for themselves, a manager for someone in their department, or the Administrator for anyone
**Then** working days are counted against the calendar (weekends and holidays excluded), and the category label and colour are assigned automatically

**Given** a period that overlaps another active leave record for the same employee
**When** it is saved
**Then** it is rejected

**Given** an invalid date, a reversed range, a year outside the calendar, or a range with zero working days
**When** it is saved
**Then** it is rejected with the matching clear message

**Given** a manager
**When** they record leave for someone outside their department
**Then** it is rejected at the server

**Given** a manager or employee-linked Administrator
**When** they record their own leave from "My record" (Story 4.10)
**Then** it behaves exactly as for any employee recording their own leave

### Story 5.3: Edit or cancel a leave period

As an employee,
I want to change or cancel leave when plans change,
So that my record stays accurate.

**Acceptance Criteria:**

**Given** an existing leave record
**When** its dates change
**Then** working days and category are recalculated

**Given** the overlap check during an edit
**When** it runs
**Then** it ignores the record being edited

**Given** an existing leave record
**When** it is cancelled
**Then** it is marked cancelled, stays in history, and is excluded from later overlap checks; it is never deleted

**Given** someone who couldn't record leave for that employee
**When** they try to edit or cancel it
**Then** it is rejected at the server

### Story 5.4: Attendance views use real data

As the L&D manager,
I want attendance views built from real records,
So that worked and leave days reflect what actually happened.

**Acceptance Criteria:**

**Given** an employee's attendance records (Story 1.5), leave records, and the holiday calendar
**When** their Attendance tab or the org-wide Attendance & leave view is opened
**Then** the whole attendance summary is computed from real data: worked days from attendance records, leave days from non-cancelled leave records, scheduled days from the calendar, and missing-record days from the difference
**And** nothing in the summary is read from `src/data/employees.ts` any more

**Given** a cancelled leave record
**When** totals are calculated
**Then** it is not counted

**Given** a leave category is shown
**When** it is displayed
**Then** it has a text label as well as its colour (NFR-UX-002)

## Epic 6: Colour-Contrast Remediation

Every user gets a workspace that meets WCAG 2.2 AA colour contrast. Covers PRD §4.8, SRS 11.7, NFR-UX-004. Today `src/app/styles.css` has 106 distinct hard-coded colours and no shared colour variables, and both accessibility test files switch the axe `color-contrast` rule off. Keep the current look: colours that already pass become named variables with their values carried over unchanged; only failing colours are adjusted, as little as needed, so no design sign-off is required. Each story fixes one area and switches the contrast check back on for it, so CI enforces the fix from the moment it lands. No dependency on any other epic.

### Story 6.1: Sign-in page meets contrast, and the shared palette exists

As anyone signing in,
I want the sign-in page text to be readable,
So that it's usable regardless of eyesight or screen.

**Acceptance Criteria:**

**Given** the sign-in page
**When** it is scanned against WCAG 2.2 AA
**Then** there are no colour-contrast failures, including the copy on the lavender panel

**Given** the colours the sign-in page uses
**When** this story ships
**Then** each is a named CSS variable, every text/background pairing passes AA, and only colours that failed have changed value

**Given** `tests/e2e/accessibility.spec.ts`
**When** the sign-in scan runs
**Then** the `color-contrast` rule is enabled for it

### Story 6.2: Administrator workspace meets contrast

As the L&D manager,
I want the workspace's text and badges to be readable,
So that I can rely on it all day without strain.

**Acceptance Criteria:**

**Given** the dashboard, the directory and an open profile
**When** they are scanned against WCAG 2.2 AA with the `color-contrast` rule enabled
**Then** there are no failures, including muted secondary text, footer text and status badges

**Given** the colours these screens use
**When** this story ships
**Then** they come only from named variables, with passing colours carried over unchanged

**Given** any status shown on these screens
**When** it is displayed
**Then** it has a text label as well as its colour (NFR-UX-002)

### Story 6.3: Staff portal meets contrast

As an employee,
I want my portal to be readable,
So that I can use it without straining.

**Acceptance Criteria:**

**Given** the staff portal
**When** it is scanned with the `color-contrast` rule enabled in `tests/e2e/staff-attendance.spec.ts`
**Then** there are no failures

**Given** `src/app/styles.css` after this story
**When** it is inspected
**Then** every colour is a named variable (passing colours carried over unchanged), and no hard-coded colour values remain

## Epic 7: Editable Employee Records

Administrators, and Department Managers within their own department, add new employees and maintain their basic details, employment history, skills assessments and evaluation summary; employees can edit their own employment history. Covers PRD §4.5 and the remaining parts of SRS 11.3. Depends on Epic 1 (persistence) and Epic 4 (departments, manager authority). "Authorized manager" below means the Administrator for anyone, or a Department Manager for employees in their own department subtree. Every field in `src/data/employees.ts` has an owning story: basic details, summary, status, join date and avatar (1.1), attendance (1.5, 5.4), interviews (2.1), training (3.1, 3.2), current work (4.5; the Git sample is removed there), employment history (7.3), skills and review (7.4). Once all of those are done, the file is used only for seeding.

**Deferred (SRS 11.3 items not covered by any story; see PRD §8 Open Question 2):**
- Correcting past attendance (clock-in/out) entries.
- Creating or editing training entries outside the LMS.
- Administrator editing of Staff-authored interview outcomes (read-only per the FR-2 interim default).

### Story 7.1: Add a new employee

As the L&D manager,
I want to add a new employee to the system,
So that new joiners can be tracked and given an account without a developer editing code.

**Acceptance Criteria:**

**Given** an authorized manager
**When** they add an employee (Employee ID, name, title, team, email, department, manager, office, employment type)
**Then** the employee appears in the directory and can be given an account through Story 1.3

**Given** an Employee ID or primary email that already exists
**When** the new employee is saved
**Then** it is rejected

**Given** an employee submitted without a department
**When** it is saved
**Then** it is rejected; every employee needs a department from the start

**Given** a Department Manager
**When** they add an employee to a department outside their subtree
**Then** it is rejected at the server

### Story 7.2: Edit an employee's basic details

As a manager,
I want to keep an employee's details current,
So that the directory stays accurate.

**Acceptance Criteria:**

**Given** an authorized manager
**When** they change an employee's title, team, manager, office or employment type
**Then** the change is saved

**Given** any attempt to change an employee's department here
**When** it is submitted
**Then** it is rejected; department changes only through a transfer (Story 4.8)

**Given** a Staff session
**When** it tries to edit basic details, including its own
**Then** it is rejected at the server

### Story 7.3: Maintain employment history

As an employee,
I want to keep my own employment history up to date,
So that my background is accurate on my profile.

**Acceptance Criteria:**

**Given** the employee for their own record, or an authorized manager for anyone in their scope
**When** they add or edit an employment history entry (role, employer, period, detail)
**Then** it is saved and shown newest first

**Given** an entry added by mistake
**When** it is removed
**Then** it disappears from the Employment tab but is kept in history

**Given** the existing demo employment history
**When** this story ships
**Then** it is moved into the database and the Employment tab looks the same

**Given** a Staff member
**When** they try to edit another employee's history
**Then** it is rejected at the server

### Story 7.4: Record skills assessments and the manager evaluation

As a manager,
I want to rate an employee's skills and record my evaluation,
So that readiness decisions are based on current, written-down assessments.

**Acceptance Criteria:**

**Given** an authorized manager
**When** they rate a skill (1–5 with supporting evidence) or update the evaluation summary (strengths, development priorities, readiness)
**Then** it is saved and shown on the Skills & evaluation tab

**Given** a Staff session
**When** it tries to change skills or the evaluation, including on its own record
**Then** it is rejected at the server; employees see these read-only

**Given** the existing demo skills and evaluation data
**When** this story ships
**Then** it is moved into the database, and skills and the evaluation summary are no longer read from `src/data/employees.ts`
