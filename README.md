# Brain Station 23 · People & Development

An L&D manager workspace for exploring employees, employment history, training, skills, current work, external job interviews, attendance and leave.

## Run the site

Prerequisites: Node.js 22+ and npm 10+.

```bash
npm ci
npm run dev
```

Open http://localhost:3000 and sign in to the synthetic demonstration:

- **Email:** `manager@example.com`
- **Password:** `Brain23Demo!`

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

## What works now

- Server-checked demo admin sign-in with signed, expiring, HTTP-only session cookies and sign-out.
- Dashboard showing workforce, training, availability and interview summaries.
- Employee directory searchable by name, ID and skill, with team/status filters and CSV export.
- Employee profiles covering employment, training, assessed skills, current assignments, external interviews, attendance and leave.
- Organisation-wide training, interview and attendance views.
- Responsive layouts and synthetic records for eight fictional employees.
- Existing leave calculation module and tests, plus session and browser workflow tests.

## Demo boundaries

This is a read-only prototype for reviewing the L&D workflow. Employee records are fictional fixtures in `src/data/employees.ts`, not a database. Git activity and attendance are sample records; external systems are not connected. Job titles are separate from application permissions, and external job interviews are distinct from internal assignments.

The displayed manager identity is fictional. The default demonstration credentials are intentionally public and must not protect real employee data. Set all three optional `DEMO_*` environment variables in `.env.local` to use private demo credentials and a stable signing secret. Without a configured secret, restarting the server invalidates demo sessions. Changing credentials should also rotate the secret to invalidate existing sessions.

Production delivery still requires Supabase authentication, account provisioning/deactivation, database migrations and RLS, scoped permissions, persistent record editing, integration configuration and operational controls. Do not load real employee records into this prototype.

## Verification

For hosting setup, see [Deploy the demonstration](docs/DEPLOYMENT.md). Vercel configuration is included; hosted sessions require a stable `DEMO_SESSION_SECRET` in the deployment environment.

```bash
npm run check
npm run test:e2e
```

The browser tests use installed Microsoft Edge by default and start an isolated development server on port 3100. Set `PLAYWRIGHT_CHANNEL=chromium` and install Chromium with `npx playwright install chromium` on systems without Edge.

## Requirements direction

The owner is Brain Station 23's L&D manager. The primary workflow is reviewing employees' background, development, present assignments and readiness for jobs at other employers. Attendance records establish days worked; Git commits do not. Skill assessments use explicit evidence and human review.

The older [SRS](docs/SRS.md) and [architecture](docs/ARCHITECTURE.md) describe the earlier, narrower MVP and require revision before production implementation. Their exclusions of training/employment history and two-role access model are superseded by this clarified product direction. See [contribution guidance](CONTRIBUTING.md) for the repository workflow.
