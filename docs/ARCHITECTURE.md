# Architecture and data model

## Design goals

The MVP uses a small modular monolith. One deployable web application owns browser rendering, authenticated operations, imports, and optional webhook boundaries. PostgreSQL owns relational integrity, effective-dated history and row/field access rules. This is deliberately less glamorous than microservices and considerably more suitable for a 30-day build.

## Proposed runtime

| Layer | Choice | Responsibility |
|---|---|---|
| Web | Next.js App Router + TypeScript | Pages, server actions/route handlers, session checks |
| Identity | Supabase Auth | Administrator-provisioned identities and sessions |
| Data | Supabase PostgreSQL | Records, constraints, transactions, RLS, migrations |
| Domain | Framework-independent TypeScript | Leave calculation, validation, categories, webhook normalization |
| Verification | Vitest + Playwright + SQL policy tests | Domain, integration, RLS, and browser scenarios |
| Hosting | Vercel + Supabase | Demonstration deployment and managed encrypted storage |

## Trust boundaries

1. Browsers are untrusted. Every mutation validates input and derives employee identity from the authenticated session.
2. PostgreSQL RLS is the final user-data boundary; hiding a button is not authorisation.
3. GitHub requests are untrusted until the HMAC signature is checked against the exact raw bytes.
4. Service-role database access is limited to server-only administration and webhook modules.
5. Operators and backups are governed separately from application roles.

## Initial entities

| Entity | Important fields and constraints |
|---|---|
| `employees` | Stable identity, unique employee ID/auth identity, authorised contact fields and lifecycle state |
| `employment_events` | Effective-dated join, confirmation, designation, promotion, transfer, manager, leave, exit and rehire history |
| `catalogue_items` | Versioned/configurable designations, levels, families, skills, domains, locations and statuses |
| `employee_skills` | Skill, proficiency, evidence source/status, assessor, evidence date and expiry; history retained |
| `training_items` | Provider, type, capabilities, prerequisites, schedule, mode and status |
| `training_enrolments` | Person/cohort assignment, workflow state, attendance, assessment, certificate and verification |
| `development_goals` | Target role/skill, actions, owner, target date, progress and reviews |
| `employee_git_emails` | UUID PK, employee FK, display email, unique canonical email, verified flag, timestamps |
| `holiday_calendars` | UUID PK, unique version, jurisdiction, timezone, supported year range, immutable publication timestamp |
| `holidays` | Calendar FK + date composite unique key, name |
| `leave_records` | UUID PK, employee FK, date range, working days > 0, category enum, calendar-version FK, timestamps |
| `repository_configs` | GitHub repository ID unique, display name, active flag, secret reference (never secret value) |
| `webhook_deliveries` | Provider + delivery ID unique, repository ID, received/processed timestamps, outcome, safe error code |
| `commits` | Provider + repository ID + SHA unique, repository name, author email, authored time, nullable employee FK, delivery FK |
| `projects` | Internal/client project, confidentiality, technologies/domains, engagement model and dates |
| `assignments` | Resource, project, delivery role, allocation percentage, date range, status and reporting lead |
| `opportunities` | Confidential client/role demand, required capabilities, work model, stage, owner and dates |
| `resource_submissions` | Resource/opportunity pipeline, interview rounds, structured evidence, outcome and next action |
| `evaluations` | Template/scale version, period, reviewer, state and employee acknowledgement |
| `evaluation_ratings` | Criterion, rating, evidence, confidence and immutable finalisation history |
| `workday_summaries` | Source-attributed scheduled/worked/leave/holiday/missing totals by period |
| `audit_events` | Append-only UUID PK, actor, target, action, safe metadata, server timestamp |

PostgreSQL exclusion constraints should enforce same-employee leave-range non-overlap, avoiding race conditions that an application-only pre-check cannot prevent.

## Module boundaries

```text
src/domain       Pure rules and value objects; no database or framework imports
src/server       Authentication, repositories, services, audit, webhook ingestion
src/app          Routes, pages, layouts, and server actions
supabase         Forward-only schema migrations, RLS policies, and seed data
tests            Domain, integration, policy, and end-to-end scenarios
```

## First vertical slice

The initial commit implements the pure leave calculator and category boundaries. Following corrected discovery, the next slice will add:

1. effective-dated employee and configurable catalogue tables;
2. skill evidence and training/development records;
3. database constraints, field-aware services and RLS;
4. authenticated employee/resource profile and search;
5. integration and browser access-control tests.

## Open decisions

- Official designation/level/family taxonomy and internal resource terminology
- Authoritative HRMS, LMS, attendance/leave, project and recruitment sources
- Evaluation criteria, scale, evidence rules and employee visibility
- Organisation timezones, calendars and holiday authorities
- Supabase organisation/project ownership and environments
- Whether Git activity belongs in the MVP at all
- Retention periods and authorised production operators
- Whether deployment remains Vercel/Supabase after the demonstration
