# Brain Station 23 · People & Development

An L&D manager workspace for exploring employees, employment history, training, skills, current work, external job interviews, attendance and leave.

## Run the site

Prerequisites: Node.js 22+ and npm 10+.

```bash
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and fill in the Supabase values (see [Deploy the demonstration](docs/DEPLOYMENT.md)). Open http://localhost:3000 and sign in:

- **Administrator:** your named Supabase account. There is no sign-up; the first Administrator is created once with `npm run db:seed-admin` (set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` first; see [DEPLOYMENT.md](docs/DEPLOYMENT.md#administrator-accounts-story-12)). The old shared `manager@example.com` credentials no longer work.
- **Staff:** a named Supabase account an Administrator created for that employee (profile → Overview → Sign-in account), signing in with the employee's email and the initial password the Administrator passed on. A demo Staff account can be seeded with `npm run db:seed-demo-staff` (see [DEPLOYMENT.md](docs/DEPLOYMENT.md#staff-accounts-story-13)). The old shared staff password no longer works.

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

## What works now
Staff attendance: Staff sign in with their own provisioned account. Staff clock in and out in Dhaka time, record breaks and work mode, write a daily log of tasks, hours and links, and see recent days. Staff sessions cannot open the manager portal. Records are held in server memory (src/server/attendance-store.ts), reset on restart, and are not persisted on Vercel.


- Administrator sign-in with a named Supabase Auth account (8-hour session, no self-registration), and sign-out.
- Administrators create a Staff account for an existing employee from the employee's profile, setting an initial password (no invite emails). Staff sign in through Supabase Auth (12-hour session) and see only their own portal. Every employee read, Administrator or Staff, is enforced by Row-Level Security.
- Dashboard showing workforce, training, availability and interview summaries.
- Employee directory searchable by name, ID and skill, with team/status filters and CSV export.
- Employee profiles covering employment, training, assessed skills, current assignments, external interviews, attendance and leave.
- Organisation-wide training, interview and attendance views.
- Responsive layouts and synthetic records for eight fictional employees.
- Unit, component, and end-to-end test coverage (leave calculation, session/auth, directory, profiles), plus automated accessibility scans and CI on every push/PR — see [Verification](#verification).

## Demo boundaries

This is a prototype for reviewing the L&D workflow. Employee basic details live in a Supabase `employees` table protected by Row-Level Security (seeded with fictional employees); nested profile data (skills, history, training, interviews, attendance summary, review) still comes from the fixture in `src/data/employees.ts`. The only write path is Administrator provisioning of Staff accounts. Git activity and attendance are sample records; external systems are not connected. Job titles are separate from application permissions, and external job interviews are distinct from internal assignments.

The displayed manager identity is fictional. Every account is named and provisioned by an Administrator; no demo credentials are shown on the sign-in page or kept in the repository.

Supabase Auth (named Administrator and Staff accounts), Administrator-only Staff provisioning, the `employees` table with forward-only migrations and RLS are in place. Production delivery still requires account archiving, persisted attendance, the remaining profile data in the database, scoped manager permissions, persistent record editing, integration configuration, a separate production Supabase project and operational controls. Do not load real employee records into this prototype.

## Verification

For hosting setup, see [Deploy the demonstration](docs/DEPLOYMENT.md). Vercel configuration is included; hosted sign-in needs the Supabase variables in the deployment environment.

```bash
npm run check
npm run test:e2e
```

The browser tests use installed Microsoft Edge by default and start an isolated development server on port 3100. They need the Supabase variables: global setup creates a throwaway Administrator, throwaway employees (`BS-98nn`) and throwaway Staff accounts for the run and deletes them afterwards. Set `PLAYWRIGHT_CHANNEL=chromium` and install Chromium with `npx playwright install chromium` on systems without Edge (this is what `.github/workflows/ci.yml` does, since GitHub's runners don't have Edge).

`npm run test:e2e` includes an automated accessibility scan (`tests/e2e/accessibility.spec.ts`, via axe) of the sign-in page, dashboard, and an employee profile, covering every WCAG 2.2 AA rule except colour contrast — the current palette has known, pre-existing contrast gaps tracked in [SRS.md](docs/SRS.md) Section 11.7 pending a deliberate design pass.

## Requirements direction

The owner is Brain Station 23's L&D manager. The primary workflow is reviewing employees' background, development, present assignments and readiness for jobs at other employers. Attendance records establish days worked; Git commits do not. Skill assessments use explicit evidence and human review.

The [SRS](docs/SRS.md) and [architecture](docs/ARCHITECTURE.md) documents now describe this implemented prototype directly, plus a separate, clearly-marked roadmap section for what production requires (Supabase auth, persistence, RBAC, editable records). See [contribution guidance](CONTRIBUTING.md) for the repository workflow.
