# Software Requirements Specification

## Central R&D Employee Tracking System — 30-Day MVP

**Status:** implementation baseline  
**Version:** 0.2  
**Last updated:** 20 September 2026

## 1. Purpose and success criteria

This specification defines a demonstrable internal portal for employee profiles, leave records, GitHub commit metadata, trainee assignments, and engineering logbooks. The MVP succeeds when the day-30 acceptance scenarios pass with synthetic data and no known defect permits unauthorised access, loses a committed record, or blocks a core workflow.

The system records operational activity. It is not a payroll, leave-entitlement, medical, surveillance, or performance-scoring system.

## 2. Stakeholders and actors

| Actor | Goal | Authority in the MVP |
|---|---|---|
| System owner | Operate a safe, reproducible internal portal | Chooses configuration and authorised administrators |
| Administrator | Maintain people, mappings, assignments, and review records | Organisation-wide application access |
| Standard User | Maintain their leave and logbook; view their activity | Own records plus assignments involving them |
| GitHub | Deliver repository push events | Write-only through the signed webhook boundary |
| Developer/operator | Deploy, migrate, back up, and diagnose the service | Infrastructure access; no implied application role |

"Senior Researcher" is an assignment relationship, not an application role. During the MVP, supervisors who require organisation-wide logbook review use the Administrator role.

## 3. Scope

### 3.1 In scope

- Administrator-provisioned authenticated accounts and employee profiles
- Two application roles: Administrator and Standard User
- Account deactivation with historical-record preservation
- Full-day leave records and deterministic working-day calculation
- GitHub push-webhook verification, deduplication, and commit-author mapping
- Trainee-to-Senior-Researcher assignments
- Plain-text daily engineering logbooks
- Audit records for security-relevant administrator actions
- Automated domain, integration, policy, and end-to-end tests
- Reproducible setup, migration, backup, restore, and handover instructions

### 3.2 Out of scope

- Public registration, payroll, leave balances, approvals, leave reasons, or partial days
- Individual rosters, weekends other than Saturday/Sunday, or per-person calendars
- Detailed competency, training, and career-history workflows
- Git providers other than GitHub, source-code storage, commit messages, historical backfill, or repository permission management
- Rich-text logbooks, attachments, automatic summaries, or AI evaluation
- Using recorded activity as a productivity score

## 4. Configuration decisions

The following are release-blocking configuration choices, not safe assumptions.

| Decision | Required configuration | Acceptance evidence |
|---|---|---|
| Organisation timezone | One IANA timezone, used for future-date validation and display | Recorded in deployment config and shown in admin diagnostics |
| Holiday authority | One approved calendar, jurisdiction, supported year range, and version | Seed/migration source reviewed by system owner |
| Repository allowlist | Explicit GitHub repository IDs and webhook secrets | Unlisted repositories rejected by integration test |
| Authentication | Supabase Auth is the proposed baseline; public sign-up disabled | Provisioning and deactivation test passes |
| Data retention | Retention periods for profiles, webhook deliveries, commits, logbooks, audit records, and backups | Owner approval recorded before real data is loaded |

## 5. Permission model

Every protected operation must be authorised at the API boundary and by PostgreSQL Row-Level Security (RLS) or an equivalent database-enforced policy. Service-role credentials are restricted to trusted server paths and never sent to browsers.

| Capability | Administrator | Standard User |
|---|---:|---:|
| View profiles | All | Own only |
| Create/update/deactivate profiles and accounts | Yes | No |
| Assign roles and Git email mappings | Yes | No |
| Create/view/edit/delete leave | All | Own only |
| View matched commits | All | Own only |
| Review unmatched commits and remap authors | Yes | No |
| Create/edit/delete assignments | Yes | No |
| View assignments | All | Involving the user as trainee or Senior Researcher |
| Create/edit/delete logbook entries | Review only | Own only |
| View logbooks | All | Own only |

Assignment as Senior Researcher does not grant access to another employee's profile, leave, commits, or logbook.

## 6. Functional requirements

### 6.1 Identity and profiles

- **FR-ID-001:** Administrators shall provision a profile with unique employee ID, unique primary email, name, application role, status, and one linked authentication account.
- **FR-ID-002:** Public self-registration shall be disabled.
- **FR-ID-003:** Administrators may update and deactivate profiles but may not permanently delete them through the MVP interface.
- **FR-ID-004:** Deactivation shall deny new and existing protected sessions on their next server request while retaining historical records.
- **FR-ID-005:** A Standard User shall be unable to assign or change their own role.
- **FR-ID-006:** Role changes and deactivation shall create immutable audit events containing actor, target, action, and server timestamp.

### 6.2 Leave

- **FR-LV-001:** A leave record shall contain employee, inclusive start date, inclusive end date, calculated working days, category, and holiday-calendar version.
- **FR-LV-002:** Calculation shall count Monday–Friday and exclude configured holidays. A weekend holiday shall not be subtracted twice. A same working-day range counts as one.
- **FR-LV-003:** The system shall reject malformed, reversed, zero-working-day, unsupported-year, and same-employee overlapping ranges. Edit overlap checks shall exclude the edited record.
- **FR-LV-004:** Date edits shall recalculate days and category atomically. Calendar updates shall not silently rewrite historical records.
- **FR-LV-005:** The interface shall display a category label in addition to colour and shall not infer leave reason or health status.

| Working days | Label | Colour |
|---:|---|---|
| 1–3 | 1–3 working days | Green `#22C55E` |
| 4–14 | 4–14 working days | Blue `#3B82F6` |
| 15–30 | 15–30 working days | Yellow `#EAB308` |
| 31–90 | 31–90 working days | Orange `#F97316` |
| 91+ | 91+ working days | Purple `#A855F7` |

### 6.3 GitHub activity

- **FR-GH-001:** The public webhook endpoint shall accept GitHub requests over HTTPS and verify `X-Hub-Signature-256` against the exact raw body before parsing or persistence.
- **FR-GH-002:** Missing/invalid signatures and unconfigured repository IDs shall be rejected. Authenticated unsupported event types shall be acknowledged without commit creation.
- **FR-GH-003:** Accepted push events shall store provider, repository ID/name, commit SHA, author email, authored timestamp, optional matched employee, delivery ID, receipt time, and processing outcome.
- **FR-GH-004:** The system shall not retain source code, commit messages, or raw webhook payloads.
- **FR-GH-005:** Email matching shall trim whitespace and compare case-insensitively. An address maps to at most one employee. Unmatched records are administrator-only.
- **FR-GH-006:** Uniqueness on provider, repository ID, and commit SHA shall make delivery replay and commits repeated across branches idempotent.
- **FR-GH-007:** A delivery is successful only after durable atomic storage. Malformed deliveries shall create no partial commit set; transient failures shall return an error eligible for GitHub redelivery.
- **FR-GH-008:** Mapping corrections shall reprocess relevant unmatched commits without duplicates.
- **FR-GH-009:** Counts shall be labelled "recorded activity" and never "total work" or a productivity score.

### 6.4 Assignments and logbooks

- **FR-AS-001:** Administrators shall manage assignments containing trainee, Senior Researcher, workspace/project name, inclusive start date, and inclusive end date.
- **FR-AS-002:** Trainee and Senior Researcher shall be different active employee profiles. Reversed dates are invalid; concurrent assignments are allowed.
- **FR-LB-001:** Standard Users shall create, view, edit, and delete their own plain-text entries containing entry date and at least one non-empty section: blockers, solutions tried, or milestones.
- **FR-LB-002:** There shall be at most one entry per employee per entry date. Backdating is allowed; future dates are rejected in the configured organisation timezone.
- **FR-LB-003:** Entries shall record creation and last-update timestamps and display newest first.
- **FR-LB-004:** Administrators may review but shall not rewrite employee logbooks.

## 7. API behaviour

The exact URL version may change during implementation; these behavioural contracts may not.

| Operation | Success | Required failures |
|---|---|---|
| Protected browser/API request | Requested record or mutation result | `401` unauthenticated; `403` authenticated but forbidden |
| Create/update leave | `201`/`200` with calculated fields | `400` malformed/rule violation; `409` overlap |
| GitHub webhook | `202` accepted or authenticated event ignored | `400` malformed; `401` bad signature; `404` repository not configured; `500` transient persistence failure |
| Duplicate webhook/commit | Idempotent success; no duplicate records | No partial writes |

Errors returned to clients shall use a stable machine-readable code, a safe user-facing message, and a correlation ID. They shall not disclose credentials, SQL, stack traces, or employee records.

## 8. Data and integrity rules

- Dates are ISO `YYYY-MM-DD` date-only values; event timestamps are stored in UTC.
- Primary email and Git aliases are compared using canonical lowercase trimmed values while retaining display values where required.
- Employee IDs, primary emails, authentication account IDs, Git aliases, daily logbooks, and commit identities have database uniqueness constraints.
- Business mutations and their audit event use one transaction where applicable.
- Database constraints protect invariants even if application validation is bypassed.
- Synthetic data is mandatory until the system owner approves retention, deletion, and operator access.

## 9. Non-functional requirements

### 9.1 Security and privacy

- **NFR-SEC-001:** Deployed traffic uses HTTPS/TLS; database and backups use encrypted storage.
- **NFR-SEC-002:** Secrets live only in protected deployment configuration and are excluded from source control, browser bundles, tables, ordinary logs, and error responses.
- **NFR-SEC-003:** All input is server-validated. Logbooks render as text, not executable HTML. Public endpoints have body-size and rate limits.
- **NFR-SEC-004:** Operational logs exclude raw webhook bodies, credentials, logbook bodies, and unnecessary personal data.
- **NFR-SEC-005:** Dependency and secret scanning run in CI; critical findings block release.

### 9.2 Reliability and operations

- **NFR-OPS-001:** Setup, migrations, administrator bootstrap, timezone/calendar configuration, webhook setup, tests, deployment, and rollback are reproducible from repository documentation.
- **NFR-OPS-002:** The demonstration database receives daily encrypted backups. One restore into a separate environment is demonstrated and recorded before handover.
- **NFR-OPS-003:** Schema changes are forward migrations reviewed in source control; production schema changes are not performed manually.
- **NFR-OPS-004:** Webhook processing is idempotent and observable by delivery/correlation ID.

### 9.3 Accessibility and usability

- **NFR-UX-001:** Core workflows are keyboard operable and use visible labels, focus indicators, and actionable validation messages.
- **NFR-UX-002:** Meaning is never encoded by colour alone; pages target WCAG 2.2 AA for the MVP.
- **NFR-UX-003:** Dates display unambiguously and identify the organisation timezone where time affects behaviour.

## 10. Verification matrix

| Requirement area | Minimum automated evidence |
|---|---|
| Leave calculation | Inclusive dates, same day, weekends, weekday/weekend holidays, month/year/leap boundaries, invalid/reversed/zero ranges, unsupported years, overlap, and boundaries 1/3/4/14/15/30/31/90/91 |
| Access control | Unauthenticated denial, own-record success, cross-user denial, role-escalation denial, post-deactivation denial, and direct database-policy tests |
| GitHub webhook | Valid push, missing/invalid signature, malformed event, unconfigured repository, unsupported event, unmatched author, duplicate delivery/commit, and retry after simulated storage failure |
| Profiles/assignments/logbooks | Administration, assignment visibility, distinct participants, ownership, daily uniqueness, future-date rejection, review-only administration, edit, and delete |

Coverage reports support the scenario evidence but do not replace it.

## 11. Milestones and acceptance

### Working day 15

Demonstrate the leave calculator, agreed calendar source and versioning, category labels, overlap enforcement, authenticated own-record UI, and passing domain/policy tests.

### Working day 30

- [ ] Administrator creates/updates a profile and trainee assignment.
- [ ] Standard User signs in and sees only permitted records.
- [ ] Leave create/edit produces correct totals and labels; invalid and overlapping ranges are rejected.
- [ ] Trainee creates, edits, and deletes an own logbook; administrator can review but not rewrite it.
- [ ] Valid GitHub push records and maps commits; replay creates no duplicates.
- [ ] Invalid signatures are rejected; unmatched authors can be mapped by an administrator.
- [ ] Agreed domain, access-control, database-policy, logbook, and webhook tests pass.
- [ ] Deactivation blocks protected access while preserving history.
- [ ] Setup and operating instructions are reproducible; a backup restore is evidenced.
- [ ] Supervisor feedback and remaining non-blocking limitations are documented.

## 12. Traceable user stories

- **US-01:** As an administrator, I can provision and deactivate employees so access follows employment status. Covers FR-ID-001–006.
- **US-02:** As an employee, I can record full-day leave and see the correct working-day label. Covers FR-LV-001–005.
- **US-03:** As an administrator, I can configure GitHub author aliases and investigate unmatched activity. Covers FR-GH-001–009.
- **US-04:** As an administrator, I can record trainee supervision relationships. Covers FR-AS-001–002.
- **US-05:** As a trainee, I can maintain one plain-text engineering logbook entry per day. Covers FR-LB-001–004.

## 13. Post-MVP candidates

- Scoped Senior Researcher access to assigned trainee logbooks
- Partial-day leave, individual schedules, balances, and approval routing
- Additional Git providers, backfill, and missed-event reconciliation
- Repository-access provisioning and history
- Competency, training, and career-history workflows
- Rich-text logbooks, attachments, and opt-in summaries
