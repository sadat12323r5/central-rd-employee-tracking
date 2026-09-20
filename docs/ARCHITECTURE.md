# Architecture and data model

## Design goals

The MVP uses a small modular monolith. One deployable web application owns browser rendering, authenticated server operations, and the GitHub webhook boundary. PostgreSQL owns relational integrity and row-level access rules. This is deliberately less glamorous than microservices and considerably more suitable for a 30-day build.

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
| `employees` | UUID PK, unique employee ID, unique canonical primary email, name, role enum, status enum, unique auth user ID, timestamps |
| `employee_git_emails` | UUID PK, employee FK, display email, unique canonical email, verified flag, timestamps |
| `holiday_calendars` | UUID PK, unique version, jurisdiction, timezone, supported year range, immutable publication timestamp |
| `holidays` | Calendar FK + date composite unique key, name |
| `leave_records` | UUID PK, employee FK, date range, working days > 0, category enum, calendar-version FK, timestamps |
| `repository_configs` | GitHub repository ID unique, display name, active flag, secret reference (never secret value) |
| `webhook_deliveries` | Provider + delivery ID unique, repository ID, received/processed timestamps, outcome, safe error code |
| `commits` | Provider + repository ID + SHA unique, repository name, author email, authored time, nullable employee FK, delivery FK |
| `assignments` | Trainee FK, Senior Researcher FK, name, date range, distinct-participant check, timestamps |
| `logbook_entries` | Employee FK + entry date unique, three nullable text sections with non-empty aggregate check, timestamps |
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

The initial commit implements the pure leave calculator and category boundaries. The next slice will add:

1. holiday calendar and leave tables;
2. database constraints and RLS;
3. authenticated create/list/edit/delete services;
4. an accessible leave form and list;
5. integration and browser tests.

## Open decisions

- Organisation IANA timezone
- Holiday jurisdiction, source, supported years, and initial version
- Supabase organisation/project ownership and environments
- GitHub repository IDs included in the MVP
- Retention periods and authorised production operators
- Whether deployment remains Vercel/Supabase after the demonstration
