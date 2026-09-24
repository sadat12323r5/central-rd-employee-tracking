# Software Requirements Specification

## Brain Station 23 · People & Development workspace

**Status:** implementation baseline — supersedes v0.2
**Version:** 0.3
**Last updated:** 24 September 2026

## 1. Purpose and success criteria

This specification defines an internal workspace for Brain Station 23's Learning & Development (L&D) manager to review employees' background, development, present assignments, and readiness for roles at other employers. It replaces v0.2, which specified a GitHub-activity/logbook tracking system that was never built. Section 12 traces which v0.2 requirements were dropped and why.

The system currently ships as a **read-only demonstration prototype**: a single demo administrator identity, fictional employee records held in a source file, and no persistent data store. This document specifies (a) the prototype as it exists today, which is the accepted baseline, and (b) the requirements a production deployment must additionally satisfy (Section 11), which are not yet implemented.

The system records operational and developmental activity. It is not a payroll, leave-entitlement, medical, surveillance, or automated performance-scoring system. Recorded Git activity is a sample metric, never a productivity score.

## 2. Stakeholders and actors

| Actor | Goal | Authority today | Authority in production |
|---|---|---|---|
| System owner | Brain Station 23's L&D manager; owns the workflow this tool supports | Approves scope and demo credentials | Approves scope, provisioning, and data retention |
| Administrator | Reviews employees' profiles, development, and readiness | One fictional demo identity ("Ayesha Karim"), shared password, full read access to fixture data | Named, provisioned accounts with full workspace access and record-editing rights |
| Employee (subject of records) | Has profile, training, skills, assignment, interview, and attendance data reviewed | No account; not a system actor | Not specified as a system actor in this document; see Section 11.6 |
| Developer/operator | Builds, deploys, and diagnoses the service | Repository and Vercel/local access; no implied application role | Same, plus database migration and backup authority |

There is one application role today: the demo Administrator. Section 11.1 specifies the production role model.

## 3. Scope

### 3.1 In scope today (implemented and verified)

- Demo administrator sign-in via a signed, expiring, HTTP-only session cookie, and sign-out
- A dashboard summarising workforce, training, availability, and interview counts
- An employee directory, searchable by name, employee ID, and skill, filterable by team and status, exportable to CSV
- Employee profiles with seven views: Overview, Employment history, Training, Skills & evaluation, Current work, External interviews, Attendance
- Organisation-wide views: Learning & development (all training enrolments), Interviews & placements (all external interviews), Attendance & leave (organisation totals)
- Responsive layouts usable at desktop and mobile viewport widths
- Fictional records for eight employees, held in `src/data/employees.ts`
- A pure leave-calculation domain module (`src/domain/leave.ts`) and its tests, currently unused by any UI workflow

### 3.2 Out of scope today (not implemented, regardless of production status)

- Any data persistence: all employee records are compiled fixture data; nothing written by the application survives a restart
- Creating, editing, or deleting any record through the interface
- Real user accounts: there is exactly one shared demo credential, not tied to an individual
- Any integration with GitHub, HR systems, or calendars; the "commits" figure shown per employee is fixture data with an on-screen disclaimer, not a live integration
- Plain-text engineering logbooks, trainee/Senior-Researcher assignment records, and webhook ingestion (dropped from v0.2; see Section 12)
- Payroll, leave balances, leave approvals, or leave reasons
- Individual rosters or per-person calendars

### 3.3 Production scope

Section 11 specifies what a production deployment must add on top of Sections 4–10. Nothing in Section 11 is implemented; it is a roadmap, not a description of current behaviour.

## 4. Current system description

The application is a Next.js server-rendered app with one route. On each request, the server checks for a valid session cookie:

- **No valid cookie:** render the sign-in page. Credentials default to `manager@example.com` / `Brain23Demo!` and are shown on-screen unless `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD` are set in the environment.
- **Valid cookie:** render the workspace with the full in-memory employee fixture list. There is no per-record authorization check because there is only one identity and it can see everything.

All eight employee records are compiled into the server bundle from `src/data/employees.ts`. No database, ORM, or external API is present in the runtime path.

## 5. Functional requirements (current prototype)

### 5.1 Session and access

- **FR-SESS-001:** The sign-in form shall accept an email and password and reject any pair that does not match the configured demo credentials, returning a generic "incorrect" message that does not reveal which field was wrong.
- **FR-SESS-002:** On success, the server shall issue an HMAC-signed session token in an HTTP-only, `SameSite=Lax` cookie with an 8-hour expiry.
- **FR-SESS-003:** A request bearing a missing, malformed, tampered, or expired token shall be treated as signed out and shall render the sign-in page.
- **FR-SESS-004:** Sign-out shall delete the session cookie and return the user to the sign-in page; a subsequent reload shall not display any workspace data.
- **FR-SESS-005:** Without a configured `DEMO_SESSION_SECRET`, the signing secret shall be regenerated per process start, invalidating all outstanding sessions on restart.

### 5.2 Directory

- **FR-DIR-001:** The directory shall list every employee with name, employee ID, designation, team, up to two core skills, and status.
- **FR-DIR-002:** A search box shall filter the visible list by case-insensitive substring match against name, employee ID, job title, and any assessed skill name.
- **FR-DIR-003:** Team and status filters shall each independently narrow the visible list; a combined filter and search state that matches no employee shall show an empty-state message instead of an empty table.
- **FR-DIR-004:** A reset control shall appear only while at least one filter or the search box is non-default, and shall clear all three back to their defaults.
- **FR-DIR-005:** Exporting shall generate a CSV of exactly the currently visible (filtered/searched) rows, with columns Employee ID, Name, Designation, Team, Status, Email, quote every field, and escape embedded double quotes by doubling them.
- **FR-DIR-006:** After an export, the interface shall show a status message stating how many records were exported.

### 5.3 Employee profile

- **FR-PROF-001:** Selecting an employee shall open a profile with tabs Overview, Employment, Training, Skills & evaluation, Current work, Interviews, Attendance; each tab shall be keyboard-selectable and expose ARIA tab/tabpanel roles.
- **FR-PROF-002:** Overview shall summarise the employee's role, contact email, employment type, manager, office location, latest development review readiness, current project, and in-progress training.
- **FR-PROF-003:** Employment shall list employment history entries in reverse-chronological order with role, employer, period, and detail.
- **FR-PROF-004:** Training shall list every training entry with programme name, provider, a 0–100 progress indicator, target/completion date, and result label.
- **FR-PROF-005:** Skills & evaluation shall display each assessed skill with a 1–5 rating, supporting evidence text, and the most recent manager evaluation (strengths, development priorities, readiness).
- **FR-PROF-006:** Current work shall display the employee's active project, responsibility, allocation percentage, latest update, and a labelled "recorded Git activity" sample figure with an on-screen disclaimer that it is not a productivity measure and that GitHub is not connected.
- **FR-PROF-007:** Interviews shall list external job interviews (company, role, date, stage, outcome, feedback) or, when none are recorded, an explicit empty state; internal assignments shall not appear in this view.
- **FR-PROF-008:** Attendance shall show scheduled, worked, leave, and missing-record day counts for the reporting period, plus a dated record table, with a disclaimer that worked days come from attendance records, not from Git commits or a scheduled-minus-leave calculation.

### 5.4 Organisation-wide views

- **FR-ORG-001:** Learning & development shall list every employee's training enrolments across the organisation with programme, provider, and progress.
- **FR-ORG-002:** Interviews & placements shall list every recorded external interview across the organisation with outcome.
- **FR-ORG-003:** Attendance & leave shall total worked, leave, and missing-record days across all employees and list them per employee.

### 5.5 Navigation and layout

- **FR-NAV-001:** The workspace shall be usable at a 390px-wide mobile viewport without introducing horizontal page scroll.
- **FR-NAV-002:** Sign-out shall be reachable from both the desktop sidebar and a mobile-specific control.

## 6. Data model (current fixture)

The `Employee` type (`src/data/employees.ts`) is the sole data structure. It holds, per employee: identity (ID, name, title, team, employment type, status, email, join date, manager, office); an evaluation summary; an array of assessed skills (name, 1–5 level, evidence text); employment history entries; training entries; one current-work assignment (including the sample commit count); an array of external interviews; an attendance summary with dated records; and a latest manager review. There are no foreign keys, no uniqueness constraints, and no persistence layer — this is an in-memory TypeScript literal, not a schema.

## 7. Non-functional requirements (current prototype)

### 7.1 Security and privacy

- **NFR-SEC-001:** The demo password comparison shall use a constant-time comparison to avoid timing side channels.
- **NFR-SEC-002:** Session secrets and demo credentials shall be read only from environment configuration, never hard-coded for production use, and excluded from source control.
- **NFR-SEC-003:** The demo banner and login page shall make clear that all data is fictional and that production accounts are not connected.
- **NFR-SEC-004:** Because there is a single shared credential and no per-record authorization, this build must not be exposed with real employee data under any configuration.

### 7.2 Reliability

- **NFR-REL-001:** All views shall render correctly from the static fixture set with no network calls beyond the initial page load; there is no failure mode where partial data loads, because there is no external data source.

### 7.3 Accessibility and usability

- **NFR-UX-001:** Interactive controls (search, filters, tabs, buttons, export, sign-out) shall be reachable and operable by keyboard alone.
- **NFR-UX-002:** Status (e.g., "On project", "Not selected") shall be conveyed with a text label in addition to colour.
- **NFR-UX-003:** Dates shall render in an unambiguous `D MMM YYYY` format.
- **NFR-UX-004:** The workspace targets WCAG 2.2 AA; this is not yet independently verified (see Section 8, gap).

## 8. Verification matrix

| Requirement area | Minimum automated evidence | Status |
|---|---|---|
| Session/access (FR-SESS-*) | Valid/expired/tampered/missing token handling, sign-in failure message, sign-out clearing state | Covered: `tests/session.test.ts`, `tests/e2e/portal.spec.ts`; server-action level (`src/server/auth.ts`) added in this revision — see `tests/auth.test.ts` |
| Directory (FR-DIR-*) | Search/filter combinations, empty state, reset visibility, CSV row/quote-escaping correctness, exported-count message | CSV formatting covered in isolation — see `tests/csv.test.ts`; filter/search/reset behaviour covered by component test — see `tests/components/portal.test.tsx`; one flow covered end-to-end in `tests/e2e/portal.spec.ts` |
| Employee profile (FR-PROF-*) | All seven tabs render their expected content for at least one fixture employee, including the interview empty state | Partially covered end-to-end (`tests/e2e/portal.spec.ts` visits all tabs); empty-state case added — see `tests/components/portal.test.tsx` |
| Organisation-wide views (FR-ORG-*) | Each of the three views is reachable and lists all employees/records | Covered end-to-end (navigation only); row-content assertions not yet added — **gap** |
| Leave domain (unused by UI, retained for reuse) | Inclusive dates, weekends, weekday/weekend holidays, month/year/leap boundaries, invalid/reversed/zero ranges, unsupported years, overlap, category boundaries | Covered: `tests/leave.test.ts` |
| Accessibility (NFR-UX-004) | Automated a11y assertions (e.g., axe) on the sign-in page and at least one profile tab | **Gap** — not yet automated; deferred by explicit product decision (see Section 1 answer log), tracked here for the next QA pass |
| CI enforcement | `npm run check` and `npm run test:e2e` run automatically on every push/PR | **Gap** — no CI workflow exists yet; deferred by explicit product decision, tracked here for the next QA pass |

Coverage reports support the scenario evidence but do not replace it.

## 9. Milestones and acceptance (current phase)

- [x] Demo administrator can sign in and out; invalid credentials are rejected with a safe message.
- [x] Directory search, team filter, and status filter each narrow results correctly, singly and combined.
- [x] CSV export contains exactly the visible rows with correctly escaped fields.
- [x] All seven profile tabs render for every fixture employee, including employees with zero interviews.
- [x] Layout remains usable and free of horizontal scroll at 390px width.
- [x] Leave-calculation domain module passes its full boundary/overlap test suite (unused by the UI; retained for the production leave workflow).
- [ ] Server-action-level tests exist for sign-in/sign-out (`src/server/auth.ts`) — added in this revision.
- [ ] CSV formatting is unit-tested independently of the DOM export flow — added in this revision.
- [ ] Automated accessibility checks and CI enforcement — explicitly deferred; see Section 8.

## 10. Traceable user stories (current prototype)

- **US-01:** As the L&D manager, I can search and filter the employee directory so I can find someone by name, skill, team, or status. Covers FR-DIR-001–004.
- **US-02:** As the L&D manager, I can export the currently filtered directory to CSV for offline review. Covers FR-DIR-005–006.
- **US-03:** As the L&D manager, I can open an employee's profile and review their employment history, training, assessed skills, current assignment, external interview activity, and attendance in one place. Covers FR-PROF-001–008.
- **US-04:** As the L&D manager, I can see organisation-wide training, interview, and attendance summaries without opening each profile individually. Covers FR-ORG-001–003.
- **US-05:** As the demo administrator, I can sign in with the demo credential and sign out, and my session expires automatically after 8 hours. Covers FR-SESS-001–005.

## 11. Production roadmap (not yet implemented)

The following are release-blocking for any deployment handling real employee data. None are implemented today; they extend, and in places replace, Sections 4–8.

### 11.1 Identity and roles

Named, Supabase-authenticated accounts replace the single shared demo credential. At minimum, an Administrator role (manage all records) and a Standard User / employee role (view and maintain their own record) are required before any real employee's data is loaded. Public self-registration stays disabled. Account deactivation must deny new and existing sessions on their next server request while preserving historical records.

### 11.2 Persistence and integrity

Records move from the compiled fixture file to Supabase PostgreSQL with forward-only migrations. Employee ID, primary email, and skill/training/interview identifiers get database uniqueness constraints. Row-Level Security (or an equivalent database-enforced policy) becomes the final data boundary — hiding a UI element is not authorization. Every protected operation is authorized at both the API boundary and the database.

### 11.3 Editable records

Administrators (and, for their own record, employees) gain create/update workflows for the fields currently read-only: employment history, training enrolments, skill assessments, current assignments, interview outcomes, and attendance/leave entries. Mutations validate input server-side and, where they change security-relevant state (role, deactivation), emit an immutable audit event with actor, target, action, and server timestamp in the same transaction as the change.

### 11.4 Leave workflow

`src/domain/leave.ts` is production-ready pure logic but has no caller. Production wires it into a real leave-record workflow: create/edit with recalculation, same-employee overlap rejection (excluding the record being edited), a configured holiday calendar with a supported year range, and the existing 1–3/4–14/15–30/31–90/91+ category labels and colours.

### 11.5 Configuration decisions

Release-blocking, not safe defaults: an organisation IANA timezone for future-date validation and display; an approved holiday calendar (jurisdiction, supported years, version); retention periods for profiles, records, and backups, approved by the system owner before any real data is loaded.

### 11.6 Explicitly still out of scope in production

Carried forward from v0.2 because they remain true statements of intent, not just leftover text: GitHub or other Git-provider integration, plain-text logbooks, payroll, leave balances/approvals, and any automated productivity or performance score derived from recorded activity.

## 12. Disposition of v0.2 requirements

v0.2 specified GitHub push-webhook ingestion, commit-author mapping, plain-text daily logbooks, and trainee/Senior-Researcher assignment records (its FR-GH-*, FR-LB-*, and FR-AS-* series, and the `webhook_deliveries`/`commits`/`logbook_entries`/`assignments` entities in the companion architecture document). None of that was built; the implemented product instead centres on employment history, training, skills, current work, and external interviews. This revision removes those requirements rather than carrying them as unimplemented scope, per the product-direction note in `README.md`. If Git-activity tracking or logbooks become a real requirement again, treat v0.2 as a source document to revive, not this revision's baseline.
