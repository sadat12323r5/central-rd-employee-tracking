# Central R&D Employee Tracking

Internal L&D and resource-management platform for employee history, skills, training, assessment, availability, project allocation, client interviews, attendance, leave, and supporting work evidence.

The repository is being delivered as a 30-working-day MVP. The implementation is intentionally narrow: it records operational facts, enforces access boundaries, and avoids treating commit counts or leave duration as employee-performance signals.

## Current status

The project is in its first implementation slice:

- The requirements baseline is documented in [`docs/SRS.md`](docs/SRS.md).
- Architecture decisions and the proposed data model are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- A deterministic leave-duration and category module is implemented with boundary tests as a supporting domain component.
- The web shell is ready for the authenticated workflows that follow.

## Proposed stack

- Next.js App Router and TypeScript
- PostgreSQL with Supabase Auth and Row-Level Security
- Vitest for domain and integration tests
- Playwright for end-to-end access-control tests
- Vercel and Supabase for the MVP demonstration deployment

The domain layer does not depend on Supabase or Next.js. Core rules can therefore be tested without a running database or browser.

## Local development

Prerequisites: Node.js 22+ and npm 10+.

```bash
npm install
npm test
npm run dev
```

Copy `.env.example` to `.env.local` before connecting a Supabase project. Do not commit the resulting file.

## Delivery sequence

1. Validate L&D terminology, official roles, data sources, evaluation policy and permissions.
2. Build effective-dated employee profiles and configurable role/skill catalogues.
3. Add training, assessment evidence, certifications and development goals.
4. Add projects, allocation, availability and client-interview history.
5. Add evidence-backed evaluation and L&D/resource dashboards.
6. Integrate attendance/leave and optional Git activity after confirming authoritative systems and purpose.

## Documentation

- [Software Requirements Specification](docs/SRS.md)
- [Company research and product implications](docs/COMPANY_RESEARCH.md)
- [Architecture and data model](docs/ARCHITECTURE.md)
- [Contributing workflow](CONTRIBUTING.md)

## Security

Use synthetic data during development. Report suspected vulnerabilities privately to the project owner; do not open a public issue containing employee information, credentials, webhook secrets, or exploit details.
