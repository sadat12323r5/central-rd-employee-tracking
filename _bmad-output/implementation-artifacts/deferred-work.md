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
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-admin-archives-restores-account.md`
  summary: Archiving ends access in the app (getSession and sign-in) but not at the database. An archived Staff member holding a still-valid access/refresh token can call PostgREST with the anon key and read their own employee row, and (with Story 1.5) write today's attendance.
  evidence: The auth user is not banned or signed out, and the staff RLS policies do not test `archived_at is null`. Fix options are a DESTRUCTIVE policy change (add `archived_at is null` to the staff own-row policies) or banning/unbanning the auth user in archive()/restore(). Both need a decision; the exposure is the person's own data only.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-admin-archives-restores-account.md`
  summary: The audit log has no read path (no function, script or UI, no index on target/occurred_at), and test runs leave audit rows for reused BS-98nn/BS-99nn ids in the shared project.
  evidence: audit_events is service-role only by design; reviewing it today means the SQL editor.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-admin-archives-restores-account.md`
  summary: An archived employee without an account can still be provisioned (StaffAccountPanel renders and provisionStaffAccountAction does not check archived_at), creating an account that can never sign in.
  evidence: accounts-store.create() does not read archived_at.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-staff-attendance-survives-restarts.md`
  summary: Attendance lists (`listForEmployee`, `listAll`) have no limit or paging; PostgREST max-rows (default 1000) would silently truncate them.
  evidence: Needs ~4 years of one employee's entries, and `listAll` has no app caller yet. Story 5.4 (attendance views use real data) should add a date window or paging.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-staff-adds-external-interview.md`
  summary: Staff sign-in, the staff page and the Administrator directory fail as a whole when the interviews read fails (employees-store merges interviews).
  evidence: Both tables share one database, so in practice only an unapplied migration splits them; DEPLOYMENT.md documents the deploy order. Decoupling the sign-in check from the interviews read needs a new store method.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-staff-adds-external-interview.md`
  summary: Overview "Upcoming interviews" stat (outcome === "Scheduled") and the hard-coded "On your radar" interview row ignore staff-added interviews.
  evidence: Staff outcome is optional free text; the radar row is pre-existing demo content. Neither view is in Story 2.1's acceptance criteria.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-staff-adds-external-interview.md`
  summary: Story 2.2 should decide whether `db:seed` keeps overwriting seeded interview rows once edits are possible (upsert on id rewrites all columns).
  evidence: Seed ids derive from fixture list position; stale rows are never removed.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-staff-adds-external-interview.md`
  summary: Add-interview form (like the attendance forms) resets after a failed save in React 19; admin interviews list has no paging (max-rows 1000); no test asserts the empty-feedback callout is hidden.
  evidence: Low-severity items recorded in the spec's deferred list.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-admin-workspace-contrast.md`
  summary: The directory search box's only focus indicator (`--accent-focus-soft` #8891df) is 2.93:1 on white, below the 3:1 non-text minimum.
  evidence: The colour was carried over unchanged in Story 6.2 because the spec keeps focus rings as they are. It belongs with the existing non-text contrast item (input borders).
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-staff-views-completed-training-history.md`
  summary: The `db:seed` writes (completed training, interviews) are never executed by a test.
  evidence: Only the pure `trainingSeedRows` / `interviewSeedRows` helpers are tested. Covering the writes needs a testable seed function or a CI seed run.
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-staff-views-completed-training-history.md`
  summary: A failed training read (like the interviews read) makes the whole employee record unavailable. Story 3.2's per-section states should decouple this.
  evidence: employees-store maps TrainingUnavailableError to EmployeesUnavailableError (the "never a profile with missing data" rule from 2.1).
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-staff-views-completed-training-history.md`
  summary: Story 4.3 must update the staff copy "Only you and the L&D Administrator can see them" in the Completed training section when it adds manager-scoped training RLS.
  evidence: Epic 3 context lists manager-scoped training RLS under 4.3.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-1-admin-downloads-activity-timeline.md`
  summary: The activity export reads attendance, interviews and training in one PostgREST request each, so an employee with more than 1000 rows in one source (max_rows) would get a silently truncated export.
  evidence: Pre-existing single-request store reads (no .range() paging). Story 8.2 (bulk export) must page through the stores per the epic; fix the stores there.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-2-admin-bulk-exports-activity.md`
  summary: Store paging (src/server/paging.ts) is offset-based without a snapshot, so a row written or deleted between page requests can be duplicated or skipped in an export larger than 1000 rows per source.
  evidence: Separate .range() requests; attendance orders by work_date desc, so a clock-in during a multi-page read shifts later pages. Keyset paging on the total order (or a snapshot RPC) would remove it.

## Blocked: Stories 5.2, 5.3, 5.4 (recorded 2026-10-14 by the unattended story loop)

Story 5.2 counts working days "against the calendar (weekends and holidays excluded)" and rejects "a year outside the calendar". That calendar is Story 5.1, which is blocked on the System Owner-approved holiday calendar (sprint-status action item). Stories 5.3 and 5.4 build on 5.2's leave records. All three stay `backlog` with a `# blocked` note until 5.1 is unblocked.

## Story 7.3 (recorded 2026-10-16)

- source_spec: `_bmad-output/implementation-artifacts/spec-7-3-employment-history.md`
  summary: Employment-history edits are last-write-wins (no optimistic concurrency), like interviews; archived employees and archived subjects can still have history written (no archived_at check in RLS or store, as with interviews); the db:seed history write is untested; no e2e drives Staff self-service or a manager.
  evidence: Recorded in the spec's deferred list with locations.
