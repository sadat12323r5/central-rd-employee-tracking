---
title: 'Story 1.1 — Employee records persist with role-scoped access'
type: 'feature'
created: '2026-10-02'
status: 'in-progress'
baseline_revision: '4418a094bc9399e98984d9f4e49157ddb7cbac56'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Employee records exist only as compiled TypeScript in `src/data/employees.ts`. Nobody can change them without a deploy, they can't safely hold real data, and `auth.ts` imports the fixture directly, which AD-1 forbids.

**Approach:** Move each employee's basic details into a Supabase `employees` table. The table has database-enforced uniqueness and Row-Level Security policies for `admin` (read all) and `staff` (read own row). Add an `employees-store` that is the only way the app reads employees. Nested profile data stays in the fixture behind the store, so the UI doesn't change. Demo sign-in keeps working (staged cutover).

## Boundaries & Constraints

**Always:**
- The store applies role scoping: admin sees all, staff sees only their session's `employeeId`.
- A not-found read returns `null`.
- Database or network failure throws a typed `EmployeesUnavailableError`.
- The page renders a clear error message on that failure, never an empty or partial list.
- The service-role key is read only in `src/server/` and never reaches the client.

**Never:**
- Change the components or the `Employee` type.
- Add write paths or delete paths for employees (that's Epic 7).
- Add Supabase Auth sign-in (that's Story 1.2).
- Seed through the migration file.

**Decisions (2026-10-02):**
- **Migration timing:** the migration is applied to the shared project once this spec is approved, before the PR. It's purely additive: a new table the live site doesn't read until merge. The user supplies `SUPABASE_DB_URL` in `.env.local`, and the push and seed run without printing it. The rule going forward: additive migrations may apply during development; changing or destructive migrations apply only on PR approval.
- **CI secrets:** the agent sets the three Supabase values as GitHub repository secrets with `gh secret set`, reading them straight from `.env.local` and never printing them.
- **Spec size:** kept whole at about 1,900 tokens. It's one goal, and splitting CI out would leave CI broken between stories.

</frozen-after-approval>

## Code Map

- `src/data/employees.ts` — the fixture; exports `Employee` and `employees`. Stays the seed source and the nested-data source. Untouched.
- `src/app/page.tsx` — imports the fixture directly. Switch it to the store and add the unavailable state.
- `src/server/auth.ts:6,36` — finds staff by email from the fixture. Switch to `employeesStore.findByEmail`.
- `src/server/attendance-store.ts` — the interface shape to mirror.
- Components and their tests import only the `Employee` type or the fixture as test data. Leave them as they are.
- `.github/workflows/ci.yml` — both jobs need the Supabase env vars.
- Node is v24 locally, so `node scripts/x.ts` runs TypeScript natively. CI uses Node 22, but it never runs the seed script.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` — add dev dependency `supabase@2.119.0` (the CLI) and scripts `db:push` (`node scripts/db-push.mjs`) and `db:seed` (`node --experimental-strip-types scripts/seed-employees.ts`). If npm's allow-scripts holds back the CLI's install script, approve it with `npm approve-scripts supabase`.
- [ ] `supabase/config.toml` (via `supabase init`) and `supabase/migrations/<timestamp>_employees.sql`:
  - **Columns:** `employee_id` (primary key, `check ~ '^BS-\d{4}$'`), name, title, team, `employment_type`, `email` (unique), `joined_on` (date), manager, office, status (check: On project / In training / Available), initials, `avatar_color`, summary, `auth_user_id` (uuid, unique, nullable, references `auth.users`), `created_at`.
  - **RLS:** enabled. A select policy for `(auth.jwt()->'app_metadata'->>'role') = 'admin'`. A select policy for `auth_user_id = auth.uid()`. No insert, update or delete policies.
- [ ] `scripts/db-push.mjs` — loads `SUPABASE_DB_URL` from `.env.local` and runs `supabase db push --db-url`. It never echoes the URL.
- [ ] `scripts/seed-employees.ts` — idempotent upsert of the fixture's basic fields with the service-role client.
- [ ] `src/server/supabase.ts` — creates the server-only service-role client and throws if its env vars are missing.
- [ ] `src/server/employees-store.ts` — `EmployeesStore` with `listFor(session)`, `getFor(session, id)` and `findByEmail(email)`. Each row is merged with the fixture's nested data by id. Throws `EmployeesUnavailableError` on a database error.
- [ ] `src/server/auth.ts`, `src/app/page.tsx` — use the store. The page catches `EmployeesUnavailableError` and renders an unavailable message with `role="alert"`.
- [ ] `tests/employees-store.test.ts` — uses a fake client to test admin vs staff scoping, the nested-data merge, `null` for not found, and the unavailable error.
- [ ] `tests/employees-rls.test.ts` — skipped without Supabase env vars. Creates throwaway auth users (admin, staff) and a test employee `BS-99xx`, signs in through the anon client, and asserts:
  - admin reads every row
  - staff reads only its own row
  - anonymous reads nothing
  - a duplicate ID or email is rejected

  Cleans up its own data in `afterAll`.
- [ ] `.github/workflows/ci.yml` — pass the three Supabase secrets as env to both jobs.
- [ ] `docs/DEPLOYMENT.md` — document the env vars, `db:push`, `db:seed`, and the one-shared-project caveat.

**Acceptance Criteria:**
- Given the seeded table, when an Administrator opens the directory and profiles, then they render as before, and the existing component and e2e tests pass.
- Given a staff Supabase identity, when it queries `employees`, then RLS returns only its own row.
- Given a duplicate Employee ID or email, when it is inserted, then the database rejects it.
- Given any app code path, when it reads employees, then it goes through `employees-store`, and `src/` no longer imports the `employees` value outside the store and the fixture itself.
- Given the database is unreachable, when the page loads, then the unavailable message shows instead of an empty or partial list.

## Design Notes

**Why the service-role key is used at runtime for now.** Until Story 1.2, app requests still carry HMAC demo sessions, not Supabase JWTs, so RLS can't identify the caller. For Story 1.1 only, `employees-store` reads with the service-role client and enforces role scoping in the app layer. Story 1.2 swaps the store to a per-request client carrying the user's JWT, so the RLS policies written and tested here become the enforced rule. This temporarily stretches the spine's "service role only for seed and admin actions" rule; record that as an amendment in the spine memlog.

**Roles live in `app_metadata`.** Only the service role can set `app_metadata`, so users can't grant themselves `admin`. `manager` is added to the policies in Epic 4.

## Verification

**Commands:**
- `npm run db:push && npm run db:seed` — expected: the migration applies, and 8 employees are upserted.
- `npm run check` — expected: typecheck, all unit tests including the RLS integration test, and the build pass.
- `npm run test:e2e` — expected: 7/7 pass against persisted data.
