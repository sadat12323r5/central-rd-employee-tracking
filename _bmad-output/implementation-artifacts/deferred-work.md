# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-sign-in-contrast-and-palette.md`
  summary: Update docs/SRS.md so NFR-UX-004, the Section 8 verification table, and the Section 11.7 colour-contrast notes reflect that the sign-in page now enforces `color-contrast` (Story 6.1), with the rest tracked as Epic 6.
  evidence: SRS.md lines ~129/140/195 still describe colour contrast as an unscheduled gap and say the sign-in scan excludes the rule. It's a spec document, so changing it goes through the planning flow, not a story review.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-sign-in-contrast-and-palette.md`
  summary: Input borders fail WCAG 1.4.11 non-text contrast app-wide (`--field-border` #dfe3ec on white is 1.29:1, needs 3:1 to identify a form control).
  evidence: Already true before Story 6.1 and outside its text-contrast scope. It affects every form (sign-in, staff portal, future admin forms), and axe doesn't check it. Needs a decision on whether Epic 6 covers non-text contrast, probably a new story or a scope addition to 6.2/6.3.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-sign-in-contrast-and-palette.md`
  summary: Add an automated guard (stylelint `color-no-hex` outside `:root`, or a grep-based test) so no hard-coded colours return to `src/app/styles.css`.
  evidence: The epic's end state is that no hard-coded colours remain, but nothing enforces it. The guard can't be added before Story 6.3, because the Administrator workspace and staff portal still use about 80 literal colours until then. Belongs in 6.3's acceptance.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-employee-records-persist.md`
  summary: Make email uniqueness case-insensitive (`check (email = lower(email))` or a unique index on `lower(email)`).
  evidence: Only the seed lowercases emails today. Epic 7's write paths would allow case-variant duplicates and unfindable sign-ins. The fix is a constraint-changing migration, so it needs PR approval.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-employee-records-persist.md`
  summary: Story 1.2 must link Supabase auth users to employee rows (`auth_user_id`) before switching the store to the per-request JWT client.
  evidence: Every seeded row has `auth_user_id` NULL, so `employees_select_own` matches no one yet.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-admin-named-account.md`
  summary: Turn off sign-ups in the hosted Supabase project (Authentication → Providers → Email / "Allow new users to sign up"), then add a live test asserting `anon.auth.signUp` fails.
  evidence: `supabase/config.toml` only covers a local stack. Until the setting is off, anyone with the public anon key can create an Auth user. That user gets no admin session and no RLS rows, but it breaks AD-6. This is a human dashboard step.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-admin-named-account.md`
  summary: In e2e global setup, sweep stale `e2e-admin-*@example.test` / `accounts-test-*@example.test` users left behind by interrupted runs.
  evidence: Leftover admin-role test users make `db:seed-admin` refuse to run, and they pile up in the shared project.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-admin-named-account.md`
  summary: Test the seed script's "Administrator already exists" exit at the process level.
  evidence: Only `seedFirstAdministrator` is unit-tested. A spawned test would need a stubbed Auth endpoint.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-admin-named-account.md`
  summary: Story 1.3 carries over the `auth_user_id` linking (from Story 1.1's deferral) and the switch of staff reads from the service-role client to the JWT client.
  evidence: Story 1.2 moved only Administrators to Supabase Auth, per the staged cutover. Staff have no Supabase accounts until 1.3.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-admin-provisions-staff-account.md`
  summary: "BLOCKED: Story 1.3 needs two System Owner decisions: (1) how new Staff get credentials (an Administrator-set initial password, possibly with a forced change, or a Supabase invite email, which needs SMTP); (2) what replaces the public demo's shared staff password (published demo staff accounts, private ones, or another option)."
  evidence: No planning artifact settles either point, and the auto loop must not invent stakeholder decisions.
