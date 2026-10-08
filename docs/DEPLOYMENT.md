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
| `SEED_ADMIN_EMAIL` | `.env.local` only, one-time | Email of the first Administrator, read by `npm run db:seed-admin`. |
| `SEED_ADMIN_PASSWORD` | `.env.local` only, one-time | Its password (at least 12 characters). Never printed; remove it from `.env.local` after seeding. |
| `SEED_DEMO_STAFF_EMAIL` | `.env.local` only | A seeded employee's primary email, read by `npm run db:seed-demo-staff`. |
| `SEED_DEMO_STAFF_PASSWORD` | `.env.local` only | That demo Staff account's password (at least 12 characters). Never printed or committed. |

`DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` (Story 1.2), and `DEMO_SESSION_SECRET` and `DEMO_STAFF_PASSWORD` (Story 1.3), are retired: delete them from Vercel and `.env.local`. The old `manager@example.com` credentials and the shared staff password are rejected.

Store these in Vercel's environment settings and `.env.local` (git-ignored), never in repository files or `vercel.json`. In GitHub, set the three Supabase values as repository secrets (`gh secret set NAME < value-file`, or the repository settings page); CI passes them to both jobs. Pull requests from forks do not receive secrets, so their RLS and live accounts tests are skipped, and their whole e2e job fails: e2e global setup throws without `SUPABASE_SERVICE_ROLE_KEY` because it cannot create the throwaway Administrator.

## Administrator accounts (Story 1.2)

Administrators sign in with a named Supabase Auth account (email + password). The session is the Supabase auth cookie, refreshed by `src/middleware.ts`, and lasts at most 8 hours from sign-in. The `admin` role comes from the user's `app_metadata.role`, which only the service role can set. Employee reads use a per-request client carrying the user's JWT, so the RLS policies are the enforced rule.

There is no self-registration. One-time setup for the shared project:

1. **Disable sign-ups (manual).** In the Supabase dashboard, open Authentication → Sign In / Providers and turn off **Allow new users to sign up**. (`supabase/config.toml` sets `enable_signup = false` to document this, but the hosted project setting is changed by hand.)
2. **Seed the first Administrator.** Put `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (at least 12 characters) in `.env.local` and run `npm run db:seed-admin`. It creates the account through `accounts-store.create()`, prints only the email, and refuses to run (exit code 1, nothing created) if any Administrator already exists. Remove both variables from `.env.local` afterwards.

Further accounts are provisioned by an Administrator in the app (Story 1.3). Tests and e2e create and delete their own throwaway Administrators (`e2e-admin-*@example.test`, `accounts-test-*@example.test`), so they never need a real Administrator's password.

## Staff accounts (Story 1.3)

An Administrator opens an employee's profile and, on the Overview tab's **Sign-in account** panel, types an initial password (12 to 72 characters, meeting the project's password policy) twice and selects **Create Staff account**. The server action checks the Administrator session first, then calls `accounts-store.create()` with the service-role client, which:

- creates a confirmed Supabase Auth user with the employee's own primary email (never typed into the form) and `app_metadata: { role: "staff", employee_id: "BS-nnnn" }`;
- links `employees.auth_user_id` only if the row is still unlinked, deleting the new user if that link fails or loses a race;
- refuses an employee who already has an account, before creating anything.

There is no invite or magic-link email (the shared project has no SMTP): the Administrator passes the initial password on outside the app. Staff sign in with their employee email; the session lasts at most 12 hours, and their own employee row is read through RLS (`employees_select_own`). At runtime the service-role key is used only by this Administrator-only provisioning action. There is no in-app password reset yet: to reset a Staff password (for example after a mistyped initial password), someone with access to the Supabase dashboard (service role) opens Authentication → Users → the user and resets or sets a new password.

**Demo Staff account.** Put `SEED_DEMO_STAFF_EMAIL` (a seeded employee's email, e.g. one from `npm run db:seed`) and `SEED_DEMO_STAFF_PASSWORD` (at least 12 characters) in `.env.local` and run `npm run db:seed-demo-staff`. It creates and links the account through `accounts-store.create()` and prints only the email. If that employee already has an account it exits 0 and creates nothing; missing or short variables exit non-zero naming the variable.

e2e global setup inserts throwaway employees (`BS-98nn`, team/title `E2E Throwaway`, emails `e2e-staff-<run>-<n>@example.test`), links two of them to throwaway Staff users through the service role, and leaves one unlinked for the provisioning spec. Teardown deletes them; setup first sweeps leftovers of an aborted run.

## Database migrations and seed

Migrations are forward-only SQL files in `supabase/migrations/`, applied with the Supabase CLI pinned in `devDependencies`.

```sh
npm run db:push   # applies pending migrations to the database in SUPABASE_DB_URL
npm run db:seed   # idempotently upserts the 8 fictional employees' basic details
npm run db:seed-admin   # one-time: creates the first Administrator (see above)
npm run db:seed-demo-staff   # optional: creates the demo Staff account (see above)
```

- `db:push` reads `SUPABASE_DB_URL` from the environment or `.env.local` and never prints it.
- `db:seed` reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the same way and upserts by Employee ID, so it is safe to rerun. Migrations never seed data. Nested profile data (skills, history, training, interviews, attendance summary, review) still comes from `src/data/employees.ts` through `employees-store`.
- The `db:seed` script runs TypeScript directly and needs Node 24 (or Node 22 with `--experimental-strip-types`, which the script passes).

If the database is unreachable, the app shows an "Employee records are unavailable" alert instead of an empty or partial directory, and Staff sign-in reports that it is temporarily unavailable.

## Publish and verify

1. Apply any pending migrations (`npm run db:push`) and seed if the table is new (`npm run db:seed`). On a fresh project, disable sign-ups and run `npm run db:seed-admin` once.
2. Run `npm run check` (includes the RLS integration test when Supabase variables are set) and `npm run test:e2e` before publishing changed application code.
3. Deploy the current source through the connected Vercel account. A CLI alternative is `npx vercel` after `npx vercel login`; use `--prod` for a production deployment.
4. Wait for successful deployment and capture the returned HTTPS URL.
5. Confirm unauthenticated visits show sign-in, an incorrect password, the retired `manager@example.com` credentials and the old shared staff password are rejected, the Administrator's named account opens the employee directory, and a provisioned Staff account opens only its own portal.
6. Refresh after sign-in to check session persistence, open an employee profile, verify filtering and sign out.

This is a demonstration with fictional records. Administrators and Staff have named accounts; archiving (Story 1.4), persisted attendance (Story 1.5) and external integrations remain separate implementation work.

References: [Vercel CLI](https://vercel.com/docs/cli), [environment variables](https://vercel.com/docs/environment-variables) and [Supabase CLI](https://supabase.com/docs/reference/cli).
