---
title: L&D Manager Workspace PRD
status: final
created: 2026-09-25
updated: 2026-09-30
---

# PRD: L&D Manager Workspace
*Working title — confirm.*

## 0. Document Purpose

This PRD defines what Brain Station 23's L&D manager workspace must do, for the L&D manager who owns the workflow, the engineers who build it, and downstream BMAD workflows (`bmad-architecture`, `bmad-create-epics-and-stories`) that build on it. It supersedes `docs/SRS.md` as the product-intent source of truth going forward; `docs/SRS.md` and `docs/ARCHITECTURE.md` remain the engineering-detail record of what is actually implemented and should be reconciled against this PRD by `bmad-architecture`. Features are grouped with functional requirements (FRs) nested under them; inline `[ASSUMPTION]` tags mark inferences not yet confirmed and are indexed in §9.

**Correction to the source document:** `docs/SRS.md` §2 and §3.1 state there is exactly one actor today (the demo Administrator) and that the employee "has no account; not a system actor." That's no longer true — a `staff` session role shipped (§4.2) after that SRS revision was written. This PRD treats the SRS's actor model as stale on this point, not as a future-only extension; `bmad-architecture` should correct SRS §2/§3.1 directly rather than layer around them.

## 1. Vision

A single internal workspace where Brain Station 23's L&D manager can see any employee's background, development, assignment history, and external-interview activity in one place — replacing scattered per-person lookups across spreadsheets and messages — and where employees themselves can report their own job-search activity and training progress directly, and see how their completed project work was evaluated, rather than the L&D manager chasing that information down or employees having no visibility into it at all.

Today it ships as a read-only demonstration prototype: one shared admin credential, fictional employee records, no persistence. The product is meant to grow into a real, persisted system with named accounts for both L&D managers (Administrators) and employees (Staff), each able to write to the parts of the record that are theirs.

## 2. Target User

### 2.1 Jobs To Be Done

**System Owner** — Brain Station 23's L&D manager in their governance capacity: approves scope, demo credentials today, and — in production — data retention, provisioning, and the gating configuration decisions in §4.7. Distinct from the day-to-day Administrator role below, though the same person holds both today (`docs/SRS.md` §2).
- Approve what the workspace is allowed to hold and for how long, before real employee data loads.

**L&D Manager (Administrator)**
- See any employee's full picture — role, skills, training, assignment history, external interviews, attendance — in one place, without asking around.
- Judge an employee's readiness for a role at another employer, using their assignment history, evaluations, and training history as evidence.
- Spot organisation-wide patterns: who's in training, who's interviewing externally, attendance/leave totals.
- Keep an objective, timestamped record of every assignment an employee has held — not just their current one — so history survives when someone moves to a new project.
- Record how a completed assignment went, including any client feedback on the service, once it's closed.

**Employee (Staff)**
- Clock in/out and log daily work without a separate system. *(Shipped.)*
- Let the L&D manager know they're interviewing elsewhere — schedule, stage, outcome — without a side conversation.
- See their own current and historical training, without asking whoever tracks it.
- See how a completed assignment was evaluated, including any client feedback on the service, as evidence of their own track record.
- Add their own account of project work nobody else tracked, for history that predates this system.

### 2.2 Non-Users (v1)

- Clients never sign in here; where their feedback appears (FR-7), it's relayed by the Administrator, not entered directly.
- External interviewers and BrainStation LMS instructors are data sources, not system users.

### 2.3 Key User Journeys

*Lighter treatment — internal tool, three roles (System Owner, Administrator, Staff), no complex navigation.*

- **UJ-1. The L&D manager checks a candidate's external-role readiness.** The manager opens an employee's profile ahead of a promotion or reference conversation, reviews their skills, training history, and now their full assignment history with evaluations and interview activity, and forms a judgement without pinging anyone else.
- **UJ-2. An employee reports they're interviewing elsewhere.** Signed in to the staff portal, the employee adds an external interview (company, role, date, stage) as it happens, and updates the outcome once they hear back. Realized by FR-1–FR-3.
- **UJ-3. An employee checks their own training record.** Signed in to the staff portal, the employee sees what they're currently enrolled in (synced from BrainStation's LMS) and their full completed-training history. Realized by FR-4–FR-5.
- **UJ-4. A project wraps up and its manager records how it went.** The Administrator, acting as the relevant department's manager, closes out the employee's current assignment when the project ends (unchanged from today's workflow, except the closed record is now kept, not discarded), then writes an evaluation of how the work went — optionally adding the client's own feedback on the service, relayed on the client's behalf. The employee later opens that closed assignment in their own portal and sees the evaluation. Realized by FR-6–FR-7.

## 3. Glossary

- **System Owner** — Brain Station 23's L&D manager in their governance capacity: approves scope, retention, and gating configuration decisions (§4.7). Same person as the Administrator today; kept distinct because production accountability differs (`docs/SRS.md` §2).
- **Administrator** — The L&D manager's day-to-day account role: full, org-wide read access to every employee record, today held by one shared demo credential. Production adds named administrator accounts (SRS 11.1). Distinct in kind from Department Manager below, even though today's one Administrator also happens to be L&D's Department Manager.
- **Department Manager** — The role that may evaluate closed Assignments (FR-7) belonging to a Department. Authority flows down the Department hierarchy: a Department's own manager, plus every ancestor Department's manager up to the Administrator, may all evaluate its Assignments — a manager's manager retains authority over what's below them, they aren't replaced by a more specific manager being assigned. Today there is exactly one Department Manager account (the Administrator, managing L&D); Central R&D is confirmed to get its own manager eventually, subordinate to L&D's — narrower, department-scoped rights, not full Administrator authority. The FR-7 permission check resolves by walking up a Department's manager chain, not by "is this user an Administrator," so adding Central R&D's manager later doesn't require reworking the check — only its exact scoped-rights shape, still undefined (§8).
- **Staff** — An employee's own account role. Shipped for attendance only (session role `staff`, scoped to one `employeeId`, cannot see the Administrator portal). This PRD extends it to interviews, training, and viewing (not authoring) their own assignment evaluations. See the Document Purpose correction above — this role already exists; the SRS's "no employee accounts" language is stale, not a future statement.
- **Employee** — The person a record is about. Same person may hold a Staff account for that record.
- **External Interview** — A job interview with a company other than Brain Station 23: company, role, date, stage, outcome, feedback. Currently Administrator-visible, fixture-sourced, no write path. This PRD makes it Staff-writable for their own record (self-reported).
- **Training Enrolment** — A training programme an employee is taking or has taken: programme, provider, progress, target/completion date, result. Currently Administrator-visible, fixture-sourced. This PRD adds a live sync from BrainStation's LMS for current enrolments, plus full history.
- **Department** — An organisational unit an Assignment or Backfilled Project Entry belongs to, drawn from an Administrator-managed list (FR-10). May have a parent Department. Today exactly two exist: L&D (top-level, managed by the Administrator) and Central R&D (its sub-department, confirmed to get its own manager eventually — not yet assigned). Until Central R&D has its own manager, its Assignments are evaluated by L&D's manager, per the Department Manager entry's authority-flows-down rule. All other departments are stubbed placeholders for the Administrator to add later — see §9.
- **Assignment** — Work an employee is doing, or did, for a client: client, project name, Department, allocation, start date, and — once closed — a completion date. Administrator-authored and Administrator-owned. Today the data model holds exactly one *current* assignment per employee and discards it when replaced (`docs/SRS.md` FR-PROF-006); this PRD makes closing an assignment archive it instead, so every employee accumulates a full assignment history over time, not just their current one.
- **Assignment Evaluation** — The Department Manager's written account of how a closed Assignment went, plus an optional client-feedback note about the service (not the employee), added once the Administrator has closed that Assignment (FR-7). Visible to, but never writable by, the employee it concerns. Not independently verified (§5) — the client-feedback note is the Department Manager's relay of what the client said, not the client's own words.
- **Backfilled Project Entry** — A historical project record an employee adds themselves, for work never tracked by an Administrator Assignment (e.g., pre-dating this system). Same fields as an Assignment plus an outcome, but employee-authored from creation, with no Department Manager evaluation — there's no Administrator record to evaluate against. Carries no independent confirmation that the work happened, unlike an Administrator-authored Assignment.
- **BrainStation LMS** — Brain Station 23's external learning-management system. New integration point: not mentioned in `docs/SRS.md` Section 11's production roadmap today. [ASSUMPTION: "BrainStation's LMS" refers to a system BS23 already operates and can grant this product API access to — not yet confirmed; FR-4 ships against a stub interface in the meantime, see §9.]

## 4. Features

### 4.1 Employee Directory & Profiles *(shipped)*

**Description:** Administrator-only. Searchable/filterable directory, CSV export, and seven-tab employee profiles (Overview, Employment, Training, Skills & evaluation, Current work, Interviews, Attendance). Fully specified in `docs/SRS.md` §5.1–5.5 (FR-DIR-*, FR-PROF-*, FR-ORG-*, FR-NAV-*) — not re-specified here to avoid duplicate sources of truth. Baseline NFRs (security, reliability, accessibility) are likewise not re-specified — see `docs/SRS.md` §7 (NFR-SEC-*, NFR-REL-*, NFR-UX-*).

**Notes:** The Training and Interviews tabs shown here are the read side of the data this PRD's §4.3 makes Staff-writable. The "Current work" tab's single-assignment view is superseded by §4.3 FR-6 — it becomes one view onto the full assignment history, not a standalone field. FR-7's Assignment Evaluation is a per-project sibling of this tab's existing "most recent manager evaluation" (`docs/SRS.md` FR-PROF-005) — the product already holds Administrator-authored evaluations of an employee's work today; FR-7 doesn't introduce a new category of data, just a per-Assignment one.

### 4.2 Staff Attendance *(shipped)*

**Description:** Employees sign in with their fixture email and a shared demo staff password, clock in/out in Dhaka time, record work mode and breaks, write a daily task log, and view recent days. Staff sessions cannot open the Administrator portal. In-memory storage only, resets on restart. Realizes attendance-related JTBDs in §2.1.

**Functional Requirements:** as implemented in `src/domain/timesheet.ts`, `src/server/attendance-*`, `src/components/staff-attendance.tsx` — not re-specified here.

**Notes:** [NOTE FOR PM] Nothing currently surfaces attendance data to the Administrator — `attendanceStore.listAll()` has no caller. Worth an FR once this PRD moves to build.

### 4.3 Staff Self-Service Extensions *(new — this PRD's primary addition)*

**Description:** Extends the same Staff portal and session role from §4.2 with three more capabilities: external interview self-reporting, live training visibility, and assignment history. Interviews and training are fully employee-authored. Assignment history is joint and asymmetric: the Administrator authors and closes Assignments (FR-6, replacing today's single-current-assignment field) and, acting as Department Manager, writes the evaluation once a record is closed (FR-7) — the employee only views it. A separate path (FR-8) lets the employee self-report project history the Administrator never tracked at all.

#### FR-1: Staff can add an external interview record

Staff can create an external-interview entry for their own record: company, role, date, stage. Realizes UJ-2.

**Consequences (testable):**
- The employee ID on the record is taken from the signed session, never from the submitted form (matches the pattern already used for attendance in `src/server/attendance-actions.ts`).
- The new entry appears in the Administrator's Interviews tab for that employee (§4.1) without further action.

#### FR-2: Staff can update an interview's stage and outcome

Staff can edit the stage and, once known, the outcome and feedback of their own previously-added interview entries.

**Consequences (testable):**
- Only the entry's own author (by session employeeId) can edit it.
- Company, role, and date are locked after creation — not editable by anyone, including the reporting employee, once the entry exists. Only stage, outcome, and feedback stay editable.

**Out of Scope:**
- Administrator editing or deleting a Staff-authored interview entry — not specified; treat as read-only for Administrators unless confirmed otherwise.

#### FR-3: Interview visibility is Administrator + the reporting employee only

No other employee can see another employee's interview activity.

**Consequences (testable):**
- Org-wide "Interviews & placements" view (`docs/SRS.md` FR-ORG-002) remains Administrator-only; nothing in this PRD exposes it to other Staff sessions.

#### FR-4: Staff can view their current LMS enrolments

The staff portal shows what the employee is currently enrolled in, synced from BrainStation's LMS.

**Consequences (testable):**
- Enrolment data (programme, provider, progress, target date) matches BrainStation LMS's own record for that employee within [ASSUMPTION: a sync-latency window, not yet defined].
- If BrainStation LMS is unreachable, the employee sees a clear stale/unavailable state rather than blank or stale-looking-fresh data.
- Ships against a stub integration interface until BrainStation LMS access is confirmed (see §9) — `bmad-architecture` AD-4 fixes the adapter boundary now so this FR's own code never needs to change once a real implementation lands behind it.

**Feature-specific NFRs:**
- **Retires `docs/SRS.md` NFR-REL-001** ("no failure mode where partial data loads, because there is no external data source"). This FR is the first external data source the product has ever had; the "clear stale/unavailable state" consequence above is the replacement reliability contract, and `bmad-architecture` should state it as such rather than leave NFR-REL-001 standing unamended.

#### FR-5: Staff can view their full training history

Independent of the live LMS sync (FR-4), Staff can see every past training entry on their own record (programme, provider, completion date, result).

**Consequences (testable):**
- History entries predating the LMS integration (fixture/legacy data) still display correctly alongside LMS-synced entries.

#### FR-6: Administrators create and close assignment records, building history automatically

Administrators create an Assignment for an employee (client, project name, Department, allocation, start date) and close it when the work ends (completion date). Closing an Assignment archives it into that employee's history rather than overwriting it — replacing today's single-current-assignment-with-no-history behaviour (`docs/SRS.md` FR-PROF-006). Realizes UJ-4 (first half).

**Consequences (testable):**
- An employee can have any number of closed (historical) Assignments over time, plus at most one open (current) Assignment.
- Closing an Assignment is the only way it leaves the "current" state; no Assignment is ever deleted once created.
- Department is chosen from the fixed list an Administrator maintains (FR-10), not free text.

#### FR-7: Department Manager evaluates a closed Assignment, with optional client feedback on the service

Once an Assignment (FR-6) is closed, the Department Manager (§3 — the Administrator, for now) writes an Assignment Evaluation of how the work went. An optional second field carries the client's own feedback specifically about the service delivered, not the employee, relayed by the Department Manager since clients are not system users (§2.2). Realizes UJ-4 (second half).

**Consequences (testable):**
- Who may write the evaluation is anyone with authority over the Assignment's Department: its own manager, or any ancestor Department's manager, up to the Administrator (§3 Department Manager) — never an "is Administrator" check directly, so adding Central R&D's manager later changes who's in that set, not how the check works.
- The evaluation and any client feedback are visible to the employee the Assignment belongs to, read-only — the employee can never write or edit either field.
- Client, project name, Department, allocation, and dates remain exactly as set by FR-6; this FR only adds the evaluation and optional client-feedback fields on top.

**Out of Scope:**
- The client entering feedback directly — always relayed by the Department Manager (§2.2). [NOTE FOR PM] Worth flagging as a fidelity gap: this is the manager's summary of what the client said, not the client's own words.
- Defining a future Department Manager's exact scoped rights (confirmed narrower than Administrator, shape undefined) — deferred; see §8 and §9.

#### FR-8: Staff can backfill a standalone historical project entry

For project work that predates this system or was never tracked by an Administrator Assignment, Staff can create their own Backfilled Project Entry directly: Department, client, project name, completion date, and outcome — the same fields FR-6 captures, plus an outcome, but entirely employee-authored, with no Department Manager evaluation (there's no Administrator record to evaluate against).

**Consequences (testable):**
- A Backfilled Project Entry is distinguishable from an Administrator-authored Assignment (e.g., a provenance flag) wherever the Administrator views it, since it carries no independent confirmation that the work happened.
- A Staff member can only create/edit their own Backfilled Project Entries, matching the FR-1 ownership pattern.

**Notes:** [NOTE FOR PM] Unlike FR-7, this entry's outcome is entirely self-reported — worth the same trust/verification-gap flag to the L&D manager as FR-7's client-feedback fidelity gap.

#### FR-9: Assignment and project history is visible to the reporting employee and Administrators only

Same visibility rule as FR-3 — Assignments, their Evaluations (FR-6/7), and Backfilled Project Entries (FR-8) are never visible to other Staff. FR-7's evaluation is written directly with no separate review step before the employee sees it — there's no one else in this workflow to review it against.

#### FR-10: Administrators manage the department list

Administrators can create and maintain the fixed list of Departments that FR-6 and FR-8 draw from, including parent/sub-department relationships (e.g., Central R&D under L&D). Employees select from this list; they cannot add a new Department themselves.

**Consequences (testable):**
- Every Assignment (FR-6) and Backfilled Project Entry (FR-8) references a Department that exists in the Administrator-managed list at the time of creation.
- A Department may optionally reference a parent Department.

**Notes:** Initial seed is L&D (top-level) and Central R&D (sub-department of L&D); all other departments are stubbed placeholders — see §9.

### 4.4 Production Identity & Persistence *(roadmap, gates real data — SRS 11.1 + 11.2)*

**Description:** Named Supabase-authenticated accounts (Administrator + Staff roles) and Supabase Postgres persistence with Row-Level Security, replacing the single shared Administrator credential, the fixture-file Staff email/password pattern, and the in-memory attendance store. This is the release gate: `docs/SRS.md` NFR-SEC-004 states *"because there is a single shared credential and no per-record authorization, this build must not be exposed with real employee data under any configuration"* — neither auth nor persistence alone satisfies that; both are needed together. Confirmed: Administrators provision every account, both Administrator and Staff; there is no self-registration path, matching `docs/SRS.md` §11.1's "public self-registration stays disabled."

**Notes:** Now gates §4.3 too, not just today's Administrator-only data — interview/training/assignment data needs the same durable, per-employee-authorized storage attendance currently lacks.

### 4.5 Editable Records *(roadmap — SRS 11.3)*

**Description:** Administrator create/update workflows for employment history, skills assessments, attendance/leave; audit-logged for security-relevant changes. §4.3 FR-6/FR-7 already specify the "current assignments" piece of this SRS item in full (Administrator-authored, history-preserving, with evaluation) — `bmad-architecture` should treat FR-6/FR-7 as that requirement's concrete design, not a separate overlapping one. The remaining overlap to reconcile is narrower: Staff-side interview/training editing (§4.3 FR-1/2/4/5) against SRS 11.3's employee edit rights over the same fields.

### 4.6 Leave Workflow *(roadmap — SRS 11.4)*

**Description:** Wires the already-built, already-tested `src/domain/leave.ts` into a real leave-record workflow. Depends on §4.4 (persistence) and a holiday-calendar decision (§4.7).

### 4.7 Gating Configuration Decisions *(roadmap — SRS 11.5)*

**Description:** Org timezone, approved holiday calendar, and data retention periods — approvals, not engineering, but block §4.4 and §4.6. Approved by the System Owner (§2.1), not the Administrator role.

### 4.8 Colour-Contrast Remediation *(roadmap — SRS 11.7)*

**Description:** Fixes known WCAG 2.2 AA colour-contrast gaps via a palette/token pass. No dependency on §4.4–§4.7; can ship independently, any time.

## 5. Non-Goals (Explicit)

- This is not a payroll, leave-entitlement, medical, surveillance, or automated performance-scoring system (`docs/SRS.md` §1). FR-7 adds Administrator-authored Assignment Evaluations, but this is a per-project sibling of the already-shipped "most recent manager evaluation" (`docs/SRS.md` FR-PROF-005), not a new category of surveillance or scoring — it evaluates one piece of work, not the person, and stays fully manual (§5 below).
- Any Git-provider integration (GitHub or otherwise) — the "commits" figure remains fixture/disclaimer data.
- Individual rosters or per-person calendars.
- Independent verification of self-reported or relayed data — interviews (Staff), training entries not sourced from the LMS sync (Staff), client feedback (relayed by the Department Manager, not the client), and Backfilled Project Entries (Staff). This product records what people report; it does not audit it.
- Cross-employee visibility of interview, training, or assignment/project data among Staff accounts (§4.3 FR-3, FR-9).
- Plain-text engineering logbooks and GitHub-webhook activity tracking — dropped from an earlier (v0.2) spec revision and explicitly not being revived by this PRD; see `docs/SRS.md` §12 if that scope ever needs reviving.

## 6. MVP Scope

*"MVP" here means the already-shipped baseline (§6.1) versus everything this PRD adds or roadmaps (§6.2) — including its own primary addition, §4.3, which is entirely forward-looking. Nothing in §4.3 ships without §4.4 (persistence) underneath it first.*

### 6.1 In Scope (shipped baseline)
- Administrator directory, profiles, org-wide views (§4.1).
- Staff attendance clock in/out and daily log (§4.2).

### 6.2 Out of Scope for MVP (this PRD's roadmap, in rough dependency order)
- §4.7 Gating configuration decisions — blocks §4.4 and §4.6, do first.
- §4.4 Production identity & persistence — the real release gate for handling actual employee data.
- §4.3 Staff self-service extensions (interviews, training, assignment history) — depends on §4.4 for durable, authorized storage. FR-4 (LMS integration) ships against a stub adapter regardless (§9). FR-10's department list ships with just L&D/Central R&D seeded, more added later.
- §4.5 Editable records (Administrator side, remaining scope beyond FR-6/7) — depends on §4.4.
- §4.6 Leave workflow — depends on §4.4 and §4.7.
- §4.8 Colour-contrast remediation — no dependency, can run any time in parallel.

## 7. Success Metrics

*[ASSUMPTION: proposed, not yet confirmed with the L&D manager or stakeholder.]*

**Primary**
- **SM-1**: % of employee readiness/development reviews conducted through the workspace vs. the prior scattered method (spreadsheets, Slack, email). Target: full replacement within a defined window of production launch. Validates §4.1, §4.4.
- **SM-2**: Time for the L&D manager to answer "is employee X ready for role Y," using the workspace vs. today's ad hoc cross-system lookup. Validates §4.1, §4.3.

**Secondary**
- **SM-3**: % of closed Assignments that receive an Evaluation (FR-7) within an expected turnaround, and % of employee-authored records (interviews, training, Backfilled Project Entries) kept current. Validates §4.3, §4.5.

**Counter-metrics (do not optimize)**
- **SM-C1**: Zero unauthorized-access incidents once real employee data replaces fixtures. `docs/SRS.md` NFR-SEC-004 (quoted in §4.4) forbids real data under the current access model — production launch must not trade speed for the access control it's fixing. Counterbalances SM-1.

## 8. Open Questions

1. **BrainStation LMS integration contract (FR-4)** — does a real API or export exist, and who owns granting access? Deliberately not blocking: FR-4 ships against a stub adapter interface in the meantime (`bmad-architecture` AD-4).
2. **Editable-records overlap, narrowed (§4.5 vs §4.3)** — only the Staff-side interview/training editing (FR-1/2/4/5) still needs reconciling against SRS 11.3's Administrator-side edit rights over the same fields; FR-6/FR-7's assignment-history-and-evaluation design already resolves the "current assignments" piece.
3. **SRS correction ownership** — confirm `bmad-architecture` (not this PRD) is the right place to formally correct `docs/SRS.md` §2/§3.1's stale actor model (see Document Purpose).
4. **Future Department Manager's exact rights** — confirmed: Central R&D will get its own manager, subordinate to L&D's, with narrower department-scoped rights, not full Administrator authority; authority flows down so L&D's manager retains rights over Central R&D even once it has its own manager. The FR-7 write-check already resolves via this manager chain (see FR-7), but the actual scoped-rights model (what else a subordinate Department Manager can and can't do beyond FR-7) is undefined until Central R&D's manager account actually exists.
5. **Additional departments beyond L&D/Central R&D** — stubbed for now (§9); no blocker, just not yet defined.

## 9. Assumptions Index

- §3 — "BrainStation LMS" is a system BS23 already operates and can grant API access to; FR-4 ships against a stub adapter interface until this is confirmed either way.
- §3 / §4.3 FR-7 — "Department Manager" is filled by the single Administrator role for L&D today; confirmed as a hierarchy of conceptually distinct, narrower-rights roles as departments get their own managers (Central R&D's is the first confirmed case), not "Administrator" relabeled per department (see Open Question 4).
- §3 Department — authority flows down the Department hierarchy: a Department's own manager plus every ancestor's manager, up to the Administrator, may all evaluate its Assignments. Central R&D has no manager of its own yet, so only L&D's manager can evaluate its Assignments today.
- §4.3 FR-8 — a Backfilled Project Entry needs a provenance flag distinguishing it from an Administrator-authored Assignment; exact treatment (visual marker vs. structural field) left to `bmad-architecture`.
- §4.3 FR-10 / §3 Department — initial seed is just L&D (top-level) and Central R&D (its sub-department); every other department is a stub the Administrator fills in later through FR-10 itself, not a data migration.
