---
title: 'Story 1.1 — Employee records persist with role-scoped access'
type: 'feature'
created: '2026-10-02'
status: 'done'
followup_review_recommended: true
deferred:
  - summary: >-
      Email uniqueness is case-sensitive; only the seed script lowercases emails.
    evidence: |-
      The migration declares a plain unique on email and findByEmail lowercases its input. Fix with check (email = lower(email)) or a unique index on lower(email) when Epic 7 adds write paths; that is a changing migration, so it needs PR approval.
    location: >-
      supabase/migrations/20261006000000_employees.sql
    severity: medium
  - summary: >-
      Seeded employees have auth_user_id NULL, so the own-row RLS policy matches nobody yet.
    evidence: |-
      Story 1.2 must link Supabase auth users to employee rows before swapping employees-store to the per-request JWT client, or staff lose access to their own record.
    location: >-
      scripts/seed-employees.ts
    severity: medium
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

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 30 findings — high 0, medium 7, low 15, false 8, maybe-false 0
- findings:
  - Verification gap
    - `[medium]` `patch` The page's unavailable branch is untested. Added `tests/page.test.tsx` covering the admin and staff paths.
    - `[medium]` `defer` Email `unique` is case-sensitive, and only the seed lowercases emails. No write path exists until Epic 7, and the fix is a constraint-changing migration, which needs PR approval. Deferred to Epic 7.
  - Intent alignment
    - `[false]` `reject` RLS is bypassed at runtime. Design Notes settle this: demo sessions carry no JWT, and Story 1.2 swaps the client. The memlog amendment records it.
    - `[false]` `reject` Sign-in is not tested against the real store. The e2e staff spec signs in against the seeded database and passed 7/7.
    - `[false]` `reject` The fake query builder may differ from the real supabase-js. The e2e directory, profile and filter tests read through the real client and passed.
    - `[low]` `reject` There is no build-time server-only guard. A grep of `.next/static` finds no key or store code, and the fix adds a dependency.
    - `[low]` `reject` An out-of-scope staff read returns `null` rather than a typed authorisation error. The page only requests the session's own ID. Revisit in Epic 4.
    - `[low]` `reject` The 6-1 `done` status is bundled into this change. It's intentional housekeeping: 6.1 is merged and deployed.
    - `[false]` `reject` The memlog amendment changes a project-wide rule. It's time-boxed to Story 1.2 and required by Design Notes.
  - Blind hunter
    - `[medium]` `defer` Email case-sensitivity. Duplicate of the verification-gap row above.
    - `[low]` `reject` `listFor` truncates past 1,000 rows. There are 8 demo rows and the department is far smaller; pagination adds complexity for an unlikely case.
    - `[false]` `reject` Non-admin sessions are treated as staff. `SessionIdentity` is a closed union, and `readSession` rejects anything else.
    - `[medium]` `patch` The RLS admin test uses a racy exact count, and the write test ignores the error. The admin test now compares like-for-like rows, and the write test asserts an error.
    - `[medium]` `patch` Concurrent runs collide on IDs. IDs now come from one per-run slot, and CI has a `concurrency` group.
    - `[medium]` `patch` The service-role key was exposed to every CI step. It's now scoped to the check and e2e steps.
    - `[low]` `reject` Fork PRs would fail e2e. This is a two-person team in one repo.
    - `[low]` `reject` CI never migrates or seeds. That's the spec's design: migrations follow the additive/destructive rule.
    - `[false]` `reject` The `joined_on` round-trip may change the format. Fixture dates are already ISO (`2024-03-04`).
    - `[low]` `reject` `db-push.mjs` masks per chunk, passes the URL in argv, and has no spawn error handler. The CLI doesn't echo the URL, argv is local only, and the CLI entry is verified to exist.
    - `[low]` `patch` Staff sign-in hit the database before checking the password. The password is now checked first, with a test that the store is never called on a wrong password.
    - `[low]` `patch` `config.toml` seeds from a missing `seed.sql`. Set `[db.seed] enabled = false`.
    - `[low]` `patch` Spec and sprint statuses were inconsistent. Both were aligned at finalisation.
    - `[medium]` `defer` Seeded rows have `auth_user_id` NULL, so the own-row policy matches no one. Story 1.2 must link auth users before swapping to JWT.
  - Edge case hunter
    - `[low]` `reject` `max_rows` truncation. Duplicate of the blind-hunter row.
    - `[medium]` `defer` Email case-sensitivity. Duplicate of the verification-gap row.
    - `[low]` `reject` Chunk-split masking. Duplicate of the blind-hunter `db-push` row.
    - `[low]` `reject` Missing spawn error handler. Duplicate of the blind-hunter `db-push` row.
    - `[false]` `reject` Running from another cwd skips `.env.local`. npm scripts always run from the package root.
    - `[low]` `reject` Fixture `history[0]` may contradict the database's title and date. Both come from the same source today; nested data moves to the database in Epic 7.
    - `[medium]` `patch` RLS ID collisions between concurrent runs. Same fix as the blind-hunter row.
    - `[low]` `patch` The duplicate-email test could pass on a primary-key conflict. It now confirms `spareId` is unused and asserts `/email/` in the error.
    - `[low]` `patch` Racy admin count. Same fix as the blind-hunter row.
    - `[low]` `patch` `config.toml` seed. Same fix as the blind-hunter row.
    - `[medium]` `patch` A missing-config error is wrapped as "unavailable" with no log. The page and sign-in now `console.error` the error and its cause, without logging values.

## Auto Run Result

Status: done

**Summary:** Employee basic details now live in the Supabase `employees` table, with unique ID and email and RLS select policies for admin (all rows) and staff (own row). `employees-store` is the only reader. It merges nested profile data from the fixture, and it scopes by role in the app until Story 1.2. A database failure renders an explicit "unavailable" alert.

**Files changed:**
- `supabase/migrations/20261006000000_employees.sql`: the table, checks and RLS. Applied to the shared project on 2026-10-06.
- `supabase/config.toml`: CLI config, with seeding disabled.
- `scripts/db-push.mjs`, `scripts/seed-employees.ts`: masked migration push, and an idempotent upsert of 8 employees.
- `src/server/supabase.ts`: lazy service-role client.
- `src/server/employees-store.ts`: the store and `EmployeesUnavailableError`.
- `src/server/auth.ts`: staff lookup through the store, with the password checked before the database.
- `src/app/page.tsx`: reads through the store, shows the unavailable alert, and logs the cause.
- Tests:
  - New: `tests/employees-store.test.ts`, `tests/employees-rls.test.ts` (live), `tests/page.test.tsx`.
  - Updated: `tests/auth.test.ts`, `tests/attendance-actions.test.ts`.
- `vitest.config.ts`: loads the Supabase env vars.
- `.github/workflows/ci.yml`: secrets scoped to the steps that need them, plus a concurrency group.
- `docs/DEPLOYMENT.md`, `.env.example`: setup and the shared-project caveat.
- Architecture memlog: the time-boxed service-role amendment.

**Review:** 30 findings:
- 12 patch rows. Duplicates collapse them to 9 fixes: 4 at medium and 5 at low by entry verdict.
- 4 defer rows, covering 2 unique items.
- 14 rejected, with reasons above.

**Follow-up review recommended:** true. Four medium entries were patched. The specific unverified risk is that the CI concurrency group and the step-scoped secrets haven't run on GitHub Actions yet. The PR's CI run settles it.

**Verification:**
- `npm run db:push` applied the migration.
- `npm run db:seed` upserted 8 employees.
- GitHub secrets were set with `gh secret set`.
- `npm run check` passed: 14 files and 133 tests, including the live RLS test, plus the build.
- `npm run test:e2e` passed 7/7.

**Residual risks:**
- Runtime reads bypass RLS until Story 1.2.
- A crashed RLS run can leave throwaway auth users behind.
- Email case-sensitivity (deferred).
