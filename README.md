# Central R&D Employee Tracking

Internal employee operations portal for profiles, leave records, GitHub commit metadata, trainee assignments, and engineering logbooks.

The repository is being delivered as a 30-working-day MVP. The implementation is intentionally narrow: it records operational facts, enforces access boundaries, and avoids treating commit counts or leave duration as employee-performance signals.

## Current status

The project is in its first implementation slice:

- The requirements baseline is documented in [`docs/SRS.md`](docs/SRS.md).
- Architecture decisions and the proposed data model are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- A deterministic leave-duration and category module is implemented with boundary tests.
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

1. Confirm organisation timezone, holiday authority, supported years, and authentication owner.
2. Finish the leave vertical slice: schema, RLS, authenticated UI, overlap protection, and integration tests.
3. Add administrator-managed profiles and account deactivation.
4. Add assignments and trainee logbooks.
5. Add authenticated GitHub webhook ingestion and author mapping.
6. Complete audit logging, backup/restore rehearsal, end-to-end tests, and handover.

## Documentation

- [Software Requirements Specification](docs/SRS.md)
- [Architecture and data model](docs/ARCHITECTURE.md)
- [Contributing workflow](CONTRIBUTING.md)

## Security

Use synthetic data during development. Report suspected vulnerabilities privately to the project owner; do not open a public issue containing employee information, credentials, webhook secrets, or exploit details.
