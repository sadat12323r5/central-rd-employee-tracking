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
| `DEMO_SESSION_SECRET` | Vercel | A cryptographically random secret of at least 32 bytes, generated once and kept stable across instances. Signs the demo **staff** sessions (until Story 1.3). |
| `DEMO_STAFF_PASSWORD` | Vercel, optional | Private demo staff password. When unset, the public demo staff password is shown on the sign-in page. |
| `SEED_ADMIN_EMAIL` | `.env.local` only, one-time | Email of the first Administrator, read by `npm run db:seed-admin`. |
| `SEED_ADMIN_PASSWORD` | `.env.local` only, one-time | Its password (at least 12 characters). Never printed; remove it from `.env.local` after seeding. |

`DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` are retired (Story 1.2): delete them from Vercel and `.env.local`. The old `manager@example.com` credentials are rejected.

Store these in Vercel's environment settings and `.env.local` (git-ignored), never in repository files or `vercel.json`. In GitHub, set the three Supabase values as repository secrets (`gh secret set NAME < value-file`, or the repository settings page); CI passes them to both jobs. Pull requests from forks do not receive secrets, so their RLS and live accounts tests are skipped, and their whole e2e job fails: e2e global setup throws without `SUPABASE_SERVICE_ROLE_KEY` because it cannot create the throwaway Administrator.

Without `DEMO_STAFF_PASSWORD`, the login screen displays the public demo staff credentials. Never use them with real employee records. Rotating the session secret invalidates all demo staff sessions.

## Administrator accounts (Story 1.2)

Administrators sign in with a named Supabase Auth account (email + password). The session is the Supabase auth cookie, refreshed by `src/middleware.ts`, and lasts at most 8 hours from sign-in. The `admin` role comes from the user's `app_metadata.role`, which only the service role can set. Administrator employee reads use a per-request client carrying the user's JWT, so the RLS policies are the enforced rule. Demo staff still sign in with HMAC sessions, so staff reads and the staff sign-in lookup keep the service-role client until Story 1.3.

There is no self-registration. One-time setup for the shared project:

1. **Disable sign-ups (manual).** In the Supabase dashboard, open Authentication → Sign In / Providers and turn off **Allow new users to sign up**. (`supabase/config.toml` sets `enable_signup = false` to document this, but the hosted project setting is changed by hand.)
2. **Seed the first Administrator.** Put `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (at least 12 characters) in `.env.local` and run `npm run db:seed-admin`. It creates the account through `accounts-store.create()`, prints only the email, and refuses to run (exit code 1, nothing created) if any Administrator already exists. Remove both variables from `.env.local` afterwards.

Further accounts are provisioned by an Administrator in the app (Story 1.3). Tests and e2e create and delete their own throwaway Administrators (`e2e-admin-*@example.test`, `accounts-test-*@example.test`), so they never need a real Administrator's password.

## Database migrations and seed

Migrations are forward-only SQL files in `supabase/migrations/`, applied with the Supabase CLI pinned in `devDependencies`.

```sh
npm run db:push   # applies pending migrations to the database in SUPABASE_DB_URL
npm run db:seed   # idempotently upserts the 8 fictional employees' basic details
npm run db:seed-admin   # one-time: creates the first Administrator (see above)
```

- `db:push` reads `SUPABASE_DB_URL` from the environment or `.env.local` and never prints it.
- `db:seed` reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the same way and upserts by Employee ID, so it is safe to rerun. Migrations never seed data. Nested profile data (skills, history, training, interviews, attendance summary, review) still comes from `src/data/employees.ts` through `employees-store`.
- The `db:seed` script runs TypeScript directly and needs Node 24 (or Node 22 with `--experimental-strip-types`, which the script passes).

If the database is unreachable, the app shows an "Employee records are unavailable" alert instead of an empty or partial directory, and staff sign-in reports that it is temporarily unavailable.

## Publish and verify

1. Apply any pending migrations (`npm run db:push`) and seed if the table is new (`npm run db:seed`). On a fresh project, disable sign-ups and run `npm run db:seed-admin` once.
2. Run `npm run check` (includes the RLS integration test when Supabase variables are set) and `npm run test:e2e` before publishing changed application code.
3. Deploy the current source through the connected Vercel account. A CLI alternative is `npx vercel` after `npx vercel login`; use `--prod` for a production deployment.
4. Wait for successful deployment and capture the returned HTTPS URL.
5. Confirm unauthenticated visits show sign-in, an incorrect password and the retired `manager@example.com` credentials are rejected, and the Administrator's named account opens the employee directory.
6. Refresh after sign-in to check session persistence, open an employee profile, verify filtering and sign out.

This is a demonstration with fictional records. Administrators have named accounts; demo staff authentication, Staff accounts and archiving (Stories 1.3–1.4), persisted attendance (Story 1.5) and external integrations remain separate implementation work.

References: [Vercel CLI](https://vercel.com/docs/cli), [environment variables](https://vercel.com/docs/environment-variables) and [Supabase CLI](https://supabase.com/docs/reference/cli).
