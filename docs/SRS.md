# Software Requirements Specification

## Brain Station 23 Resource Development and Management Platform

**Status:** discovery baseline requiring L&D validation  
**Version:** 0.3  
**Last updated:** 20 September 2026

## 1. Product purpose

The platform gives Brain Station 23's Learning & Development and resource-management teams a reliable view of each person's organisational journey: employment history, skills, completed training, assessments, availability, project experience, client interview history, attendance, leave, and current work signals.

Its purpose is to help people develop and help managers find suitable opportunities and teams. It is not merely a leave tracker, a Git activity dashboard, an applicant-tracking system, or an automated employee-ranking system.

Brain Station 23 publicly presents staff augmentation as a core collaboration model, describes an in-house L&D path from trainees to leads, and markets talent across many technical disciplines. The platform must therefore model both **career development** and **resource readiness for internal or client work**.

## 2. Discovery decisions required

Public sources are not authoritative for internal titles or policy. The L&D owner must validate:

- official designations, promotion levels, business units, reporting relationships and status terms;
- sources of truth for employee, attendance, leave, project, training and recruiting data;
- the internal meanings of “resource,” “available,” “bench,” “allocated,” and “client-ready”;
- visibility of assessment, client, interview, compensation and performance information;
- evaluation criteria and whether any aggregate score is permitted;
- applicable privacy, retention, employee-notice and correction requirements;
- integration access for existing HRMS, LMS, attendance, Git, project and recruitment systems.

Until validated, job families and levels are configurable reference data, not hard-coded enums.

## 3. Actors

| Actor | Primary goals |
|---|---|
| L&D Administrator | Manage skills, learning paths, training, assessments and development plans |
| Resource Manager | Find available people, assess job fit, and manage allocation readiness |
| HR Administrator | Maintain employment facts, organisation and attendance/leave imports |
| Employee/Resource | View and maintain permitted profile and development evidence |
| Line Manager/Reviewer | Validate skills and provide structured feedback |
| Interview Coordinator | Track client opportunities, interviews, outcomes and follow-up |
| System Administrator | Configure permissions, catalogues, integrations, retention and audit |
| Integration Service | Import approved source facts without interactive user access |

One person may hold several application roles. Organisational designation is separate from application permission.

## 4. Resource lifecycle

1. **Join:** identity, employment record, designation, team, manager, location and calendar.
2. **Profile:** skills, evidence, certifications, languages, interests and prior experience.
3. **Develop:** training, assessments, mentoring and development goals.
4. **Prepare:** availability and readiness for a role, technology, domain and engagement.
5. **Interview:** client opportunity, rounds, feedback, outcome and skill gaps.
6. **Allocate:** internal/client assignment, delivery role, capacity, dates and status.
7. **Perform and grow:** delivery feedback, competency updates and next actions.
8. **Transition:** promotion, transfer, extended leave, exit or rehire without lost history.

## 5. Configurable role taxonomy

### 5.1 Career stage and level seeds

- Intern; Trainee; Associate/Junior
- Engineer or Specialist I and II
- Senior Engineer or Senior Specialist I and II
- Lead; Architect/Principal/Expert; Manager/Head/Director

### 5.2 Job-family seeds suggested by public offerings

- Backend, frontend, full-stack and mobile engineering
- QA and test automation
- DevOps, cloud, infrastructure and platform engineering
- Data engineering, analytics and business intelligence
- AI and machine-learning engineering
- UI/UX and product design
- Project/program management, agile delivery and product management
- Business analysis and technology consulting
- Cybersecurity
- ERP/Odoo, CRM and enterprise applications
- CMS, AEM, SharePoint, LMS and Moodle engineering
- E-commerce engineering
- Game, XR, 3D and creative technology
- Technical support and managed services
- L&D, HR, recruitment, finance, sales, marketing and operations

These are seeds for an administrator-managed catalogue, not claims about exact official titles. A person may have one current designation, one primary family, multiple capabilities, and effective-dated prior roles.

## 6. MVP priorities

### Must have

- Employee profiles with effective-dated employment and organisational history
- Configurable designation, level, family, skill, domain, technology, location and status catalogues
- Skills inventory with declared and validated proficiency and evidence
- Training catalogue, enrolment, completion, assessment, certification and development goals
- Project/client allocation history plus current allocation and availability
- Client opportunity/interview pipeline with structured outcomes and follow-up
- Workday/attendance summaries and leave, imported when another system is authoritative
- Multi-dimensional, evidence-backed evaluation with history and reviewer identity
- Resource search/filter and job-fit shortlisting
- Field-level access, audit history and authorised exports

### Should have if discovery validates feasibility

- GitHub/GitLab activity metadata as an optional work signal
- CV/profile snapshots and appropriate notifications
- Aggregates for skills coverage, training, availability, allocation and interview funnel

### Out of scope

- Payroll, compensation, benefits, pre-employment applicant tracking and HR case management
- Automated promotion, dismissal, compensation or hiring decisions
- Secret ranking or a universal “goodness” score
- Keystroke, screen, message or source-code surveillance
- Treating Git activity, attendance, hours or interview outcomes alone as quality
- Replacing authoritative enterprise systems without an approved migration plan

## 7. Functional requirements

### Employee record and history

- **FR-EMP-001:** Create/import a unique employee with employee ID, authorised identity/contact fields, location, timezone, calendar, lifecycle status and authentication identity.
- **FR-EMP-002:** Store effective-dated join, internship/traineeship, confirmation, designation, promotion, transfer, manager, extended-leave, exit and rehire events.
- **FR-EMP-003:** Derive current designation, level, team, manager and status without destroying history.
- **FR-EMP-004:** Manage reference catalogues without deployment; retire in-use values without deleting history.
- **FR-EMP-005:** Employees can view their permitted history and request correction; sensitive fields receive field-level protection.

### Skills and evidence

- **FR-SKL-001:** Record skills against configurable technology, discipline, domain, language and professional-skill taxonomies.
- **FR-SKL-002:** Each proficiency records level, source (`self-declared`, `assessed`, `manager-validated`, `project-evidenced`, or `certified`), assessor, evidence date and optional expiry.
- **FR-SKL-003:** Retain proficiency history and distinguish claims from validated evidence.
- **FR-SKL-004:** Search by validated skill level, family, experience, domain, location/timezone, language, availability and capacity.
- **FR-SKL-005:** Job-fit results expose their evidence and uncertainty; a percentage is not an objective judgement of a person.

### Training and development

- **FR-LND-001:** Manage training with provider, type, skills, prerequisites, dates, duration, mode, capacity and status.
- **FR-LND-002:** Enrol people/cohorts and track assigned, enrolled, in-progress, completed, failed, withdrawn and waived states.
- **FR-LND-003:** Completion may include attendance, score/scale, pass rule, certificate, evidence, date, expiry and verifier.
- **FR-LND-004:** Development goals tie target skills/roles to actions, owner, target date, progress and review notes.
- **FR-LND-005:** Course completion does not automatically assert proficiency without an approved validation rule.

### Projects, allocation and availability

- **FR-RES-001:** Maintain client/internal projects with confidentiality, technologies, domains, engagement model and dates.
- **FR-RES-002:** Assignments contain resource, project, role, allocation percentage, dates, status and reporting lead; over-allocation warns or blocks per policy.
- **FR-RES-003:** Derive availability from assignments, calendar and approved absence, with reasoned expiring manual exceptions.
- **FR-RES-004:** Configurable states may include onboarding, training, available, partially allocated, allocated, reserved, unavailable, extended leave and exited.
- **FR-RES-005:** Show current work and effective-dated project history subject to client confidentiality.

### Client opportunities and interviews

- **FR-INT-001:** Track client alias/name per confidentiality rules, target role, required skills, work model, timezone, stage, owner and dates.
- **FR-INT-002:** Resource submissions record date, stage, rounds, permitted interviewer details, structured feedback, outcome, reason and next action.
- **FR-INT-003:** Configurable stages may include identified, shortlisted, submitted, screening, technical interview, client interview, offered, selected, rejected, withdrawn and on hold.
- **FR-INT-004:** Feedback separates observable evidence, competency ratings, development gaps and notes; discriminatory or health inferences are prohibited.
- **FR-INT-005:** Rejection never reduces an evaluation automatically; reviewed evidence may inform a development plan.

### Workdays, attendance and leave

- **FR-TIM-001:** Identify authoritative attendance/timesheet/leave sources; imports retain source and external ID.
- **FR-TIM-002:** Period summaries may include scheduled, worked/present, approved leave, holiday, weekend and missing/unreported days.
- **FR-TIM-003:** Leave uses inclusive dates, configured calendars and versioned holidays. Partial days/shifts need explicit configuration.
- **FR-TIM-004:** Attendance and leave shall not be interpreted as commitment, productivity, health or quality.
- **FR-TIM-005:** Employees can view imported totals and flag discrepancies without overwriting the source.

### Work activity integrations

- **FR-ACT-001:** Approved GitHub/GitLab repositories may supply signed push metadata: repository, SHA, mapped author and timestamp; never source or raw payloads.
- **FR-ACT-002:** Mapping is explicit, ingestion idempotent and unmatched activity administrator-only.
- **FR-ACT-003:** Commit count is an incomplete activity signal and cannot directly alter evaluation, job fit, attendance or worked-day totals.

### Evaluation

- **FR-EVL-001:** Configure role-specific templates and scales. Candidate dimensions: technical capability, delivery reliability, quality, communication, collaboration, ownership, learning, domain knowledge and client readiness.
- **FR-EVL-002:** Each rating identifies criterion, scale version, reviewer, period, evidence, status/confidence and timestamp.
- **FR-EVL-003:** Employees can view applicable final reviews, acknowledge, comment or request correction without rewriting them.
- **FR-EVL-004:** Any aggregate formula, inputs, weights, missing-data handling and version are visible; consequential use requires human review.
- **FR-EVL-005:** Expose stale, missing, self-declared and conflicting evidence instead of inventing precision.
- **FR-EVL-006:** Attendance, leave, hours and commit volume are excluded from quality ratings absent an approved lawful policy.

### Reporting

- **FR-RPT-001:** L&D reports cover training status, assessments, certification expiry, skill coverage, goals and cohort progress.
- **FR-RPT-002:** Resource reports cover availability/capacity, allocations, upcoming releases, capability demand and interview funnel.
- **FR-RPT-003:** Reports show denominator/time range, drill down to authorised evidence and audit exports.
- **FR-RPT-004:** Apply small-group suppression or equivalent controls against sensitive inference.

## 8. Security and quality

- Application permission is separate from job title; least privilege applies at API, database and field levels.
- Sensitive reads/exports, permission changes, final reviews and lifecycle changes are audited.
- Integration credentials stay server-only. Retention is defined per record class.
- Employees receive notice of collected signals, purpose, audience, retention and correction routes.
- Effective dates, allocation totals, training states and review versions have database constraints and transactional changes.
- Imports are idempotent, source-attributed, retryable and visibly report failures.
- Interfaces target WCAG 2.2 AA. Timestamps store UTC and display in the configured context.
- Setup, migration, test, backup, restore, deployment and rollback are reproducible.

## 9. Revised 30-day delivery

The whole platform cannot be responsibly completed in 30 working days. The MVP should prove its employee-development and resource-readiness core.

| Days | Deliverable |
|---|---|
| 1–5 | L&D interviews, terminology and system inventory; official catalogues, process, permissions, reports and signed MVP/privacy boundary |
| 6–15 | Employee/history, configurable catalogues, skill evidence, training, authentication, audit and synthetic seed data |
| 16–24 | Projects, allocation, availability, interview history, resource search and basic structured evaluation |
| 25–30 | L&D/resource dashboards, attendance/leave demonstration, security tests, backup restore and handover |

Git integration remains optional unless the product owner ranks it above a core workflow.

## 10. Acceptance scenarios

- [ ] L&D creates/imports an employee and views effective-dated employment history.
- [ ] An administrator configures a designation/job family without deployment.
- [ ] An employee claims a skill and a reviewer validates it with dated evidence.
- [ ] L&D assigns training, records completion/assessment and links a development goal.
- [ ] A resource manager finds people by validated skills, availability and capacity.
- [ ] A project assignment updates available capacity correctly.
- [ ] A coordinator records multiple interview rounds, evidence, outcome and next action.
- [ ] A reviewer completes a versioned evidence-backed review without commit/leave volume becoming a quality score.
- [ ] Employees see only authorised records; sensitive client and feedback data remain restricted.
- [ ] Audit, import retry, automated test, backup and restore evidence is complete.
