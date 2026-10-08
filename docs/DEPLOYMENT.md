# Deploy the L&D demonstration

Target: Vercel, using the Next.js preset and Node.js 24.x. The repository includes `vercel.json` for reproducible install/build commands. Employee records are read from a Supabase Postgres `employees` table (Story 1.1), so every environment needs the Supabase variables below.

## One shared Supabase project

Local development, Vercel Previews, the demo and CI all use **one shared hosted Supabase project** (free-plan limit). That is acceptable only while all data is fictional:

- Anything written to it (a migration, a seed, a test row) is immediately visible to every environment, including the live demo.
- Additive migrations (for example a new table the deployed code does not read yet) may be applied during development. Changing or destructive migrations are applied only after their PR is approved.
- The RLS integration tests create and delete their own throwaway auth users and `BS-99xx` rows; they never touch the seeded demo employees.
- **Before any real employee data is loaded, production must move to its own Supabase project.**

## Environment variables

| Variable | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (Preview + Production), `.env.local`, GitHub secret | The project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (Preview + Production), `.env.local`, GitHub secret | The anon (public) key. Subject to Row-Level Security. |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (Preview + Production), `.env.local`, GitHub secret | **Server-only.** Bypasses RLS. Read only under `src/server/` and by `scripts/`; never prefix it with `NEXT_PUBLIC_`. |
| `SUPABASE_DB_URL` | `.env.local` only | Postgres connection string (percent-encoded), used by `npm run db:push`. Not needed at runtime or in CI. |
| `DEMO_SESSION_SECRET` | Vercel | A cryptographically random secret of at least 32 bytes, generated once and kept stable across instances. Required for reliable hosted sessions. |
| `DEMO_ADMIN_EMAIL` | Vercel, optional | Private demo manager email; set together with the password. |
| `DEMO_ADMIN_PASSWORD` | Vercel, optional | Private demo password; set together with the email. |

Store these in Vercel's environment settings and `.env.local` (git-ignored), never in repository files or `vercel.json`. In GitHub, set the three Supabase values as repository secrets (`gh secret set NAME < value-file`, or the repository settings page); CI passes them to both jobs. Pull requests from forks do not receive secrets, so their RLS test is skipped and their e2e run cannot read employees.

Without custom demo credentials, the login screen displays the public synthetic-demo credentials. Never use them with real employee records. Rotating the session secret invalidates all demo sessions.

Story 1.1 still signs people in with demo HMAC sessions, which Supabase cannot see, so `employees-store` reads with the service-role key and applies role scoping (admin: everyone; staff: own record) in the app. Story 1.2 moves reads to a per-request client carrying the user's Supabase JWT, at which point the RLS policies become the enforced rule.

## Database migrations and seed

Migrations are forward-only SQL files in `supabase/migrations/`, applied with the Supabase CLI pinned in `devDependencies`.

```sh
npm run db:push   # applies pending migrations to the database in SUPABASE_DB_URL
npm run db:seed   # idempotently upserts the 8 fictional employees' basic details
```

- `db:push` reads `SUPABASE_DB_URL` from the environment or `.env.local` and never prints it.
- `db:seed` reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the same way and upserts by Employee ID, so it is safe to rerun. Migrations never seed data. Nested profile data (skills, history, training, interviews, attendance summary, review) still comes from `src/data/employees.ts` through `employees-store`.
- The `db:seed` script runs TypeScript directly and needs Node 24 (or Node 22 with `--experimental-strip-types`, which the script passes).

If the database is unreachable, the app shows an "Employee records are unavailable" alert instead of an empty or partial directory, and staff sign-in reports that it is temporarily unavailable.

## Publish and verify

1. Apply any pending migrations (`npm run db:push`) and seed if the table is new (`npm run db:seed`).
2. Run `npm run check` (includes the RLS integration test when Supabase variables are set) and `npm run test:e2e` before publishing changed application code.
3. Deploy the current source through the connected Vercel account. A CLI alternative is `npx vercel` after `npx vercel login`; use `--prod` for a production deployment.
4. Wait for successful deployment and capture the returned HTTPS URL.
5. Confirm unauthenticated visits show sign-in, an incorrect password is rejected, and valid credentials open the employee directory.
6. Refresh after sign-in to check session persistence, open an employee profile, verify filtering and sign out.

This is a demonstration with fictional records and demo authentication. Named accounts (Stories 1.2–1.4), persisted attendance (Story 1.5) and external integrations remain separate implementation work.

References: [Vercel CLI](https://vercel.com/docs/cli), [environment variables](https://vercel.com/docs/environment-variables) and [Supabase CLI](https://supabase.com/docs/reference/cli).
