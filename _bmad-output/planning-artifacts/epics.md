---
stepsCompleted: [1]
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
FR-2: Staff can update an interview's stage and, once known, outcome and feedback; company/role/date lock after creation.
FR-3: Interview visibility is Administrator + the reporting employee only.
FR-4: Staff can view their current LMS enrolments, synced from BrainStation's LMS via a stub adapter.
FR-5: Staff can view their full training history, independent of the live LMS sync.
FR-6: Administrators create and close Assignment records; closing archives instead of overwriting, building history automatically.
FR-7: The Department Manager (Administrator, for now) evaluates a closed Assignment, with an optional client-feedback note on the service; visible read-only to the employee.
FR-8: Staff can backfill a standalone historical project entry for work never tracked by an Administrator Assignment.
FR-9: Assignment and project history (Assignments, Evaluations, Backfilled Entries) is visible to the reporting employee and Administrators only.
FR-10: Administrators manage the department list (hierarchical, parent/child); Staff select from it, cannot add departments themselves.

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
- `Department` is a self-referencing hierarchy; `departments-store.ts` rejects any write that would introduce a cycle (Architecture AD-5). Seed data: L&D (top-level) and Central R&D (sub-department of L&D, manager not yet assigned).
- All account creation (Administrator or Staff) funnels through one repository method; no self-registration; account deactivation denies future requests immediately while preserving historical records (Architecture AD-6).
- Every new server action validates input with zod before touching a store (Architecture AD-7).
- Named uniqueness constraints (Employee ID, primary email, skill/training/interview identifiers) have no app-layer check today — accepted gap until Supabase lands (SRS 11.2, Architecture AD-1).
- Production identity & persistence (Supabase Auth + Postgres + RLS, SRS 11.1/11.2) gates all of the above going live with real data — it is the release gate, not an independent epic to sequence anywhere but first among the roadmap items.
- SRS 11.4 Leave workflow: `src/domain/leave.ts` already exists and is fully tested; only the repository/server-action wiring is unbuilt, and it depends on production persistence plus a holiday-calendar decision (PRD §4.7) — not yet architected at the store layer (Architecture Deferred).
- Deployment & Environments open items named but undecided (Architecture spine): Supabase org/project/environment mapping, forward-only migration tooling, RLS-policy test strategy, `AuditEvent` schema and write path, secrets/env-var cutover strategy, staged-vs-big-bang cutover, whether Vercel+Supabase remains the target stack post-demonstration.
- Gating configuration decisions (org timezone, approved holiday calendar, data retention periods) are System Owner approvals, not engineering — block persistence and leave-workflow epics, not story-writable themselves (PRD §4.7).
- Colour-contrast remediation (PRD §4.8, SRS 11.7, NFR-UX-004) is independent CSS/token work with no dependency on anything else — can be its own small epic, sequenced anywhere.

### UX Design Requirements

None — no UX design contract exists for this project.

### FR Coverage Map

| Requirement | Epic |
| --- | --- |
| FR-1, FR-2, FR-3 | Epic 2: Staff-Reported External Interviews |
| FR-4, FR-5 | Epic 3: Training Visibility |
| FR-6, FR-7, FR-8, FR-9, FR-10 | Epic 4: Assignment History & Department-Manager Evaluation |
| SRS 11.1/11.2, NFR-SEC-004 | Epic 1: Production Identity & Persistence |
| SRS 11.4 | Epic 5: Leave Workflow |
| PRD §4.8, NFR-UX-004 | Epic 6: Colour-Contrast Remediation |

## Epic List

*Drafted, pending your confirmation before Step 2 designs each epic's stories in full.*

1. **Epic 1: Production Identity & Persistence** — the release gate; nothing below it can hold real employee data until it lands.
2. **Epic 2: Staff-Reported External Interviews** — FR-1/2/3.
3. **Epic 3: Training Visibility** — FR-4/5, including the LMS stub adapter.
4. **Epic 4: Assignment History & Department-Manager Evaluation** — FR-6/7/8/9/10, the PRD's primary new feature set.
5. **Epic 5: Leave Workflow** — SRS 11.4, wiring up already-built domain logic.
6. **Epic 6: Colour-Contrast Remediation** — independent, no dependency on the above.
