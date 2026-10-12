# Epic 2 Context: Staff-Reported External Interviews

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let employees tell the L&D manager about interviews with other companies as they happen (company, role, date, stage) through the staff portal, and update the stage, outcome and feedback once they hear back. This replaces side conversations and the current fixture-only, Administrator-read-only interview data with a durable, employee-authored record. The Administrator can then see an employee's job-search activity alongside the rest of their profile. Job-hunting is sensitive, so strict privacy is built into both stories from the start: only the reporting employee and the Administrator can ever see an interview.

## Stories

- Story 2.1: Staff adds an external interview
- Story 2.2: Staff updates or withdraws an interview

## Requirements & Constraints

- **Ownership from the session:** a new interview is always saved to the signed-in employee. Any employee ID in the submitted form is ignored. Only the entry's author (by session employee ID) can edit or withdraw it. Attempts on another employee's entry are rejected at the server.
- **Fields:** company, role, date and stage are set at creation. Outcome and feedback are added later. Stage and outcome are free text, matching existing data.
- **Field locking:** company, role and date lock after creation. Nobody can change them, including the author. Only stage, outcome and feedback stay editable.
- **Withdrawal, never deletion:** the author can withdraw their own entry. It then leaves the employee's and the Administrator's active views, but stays in history marked "withdrawn" and is still visible to the Administrator. A corrected entry can be added afterwards, and the withdrawn one stays unchanged. There is no hard-delete path.
- **Administrator is read-only:** the Administrator sees Staff-authored entries but cannot edit or delete them (interim default, deliberately deferred).
- **Visibility (privacy rule):** only the reporting employee and Administrator-role accounts can read interviews. No other Staff member, and no future Department Manager, sees them, even within their own department. The org-wide "Interviews & placements" view stays Administrator-only.
- **Admin visibility without extra steps:** a new entry appears immediately in the Administrator's profile Interviews tab for that employee and in the org-wide "Interviews & placements" view.
- **Single source:** the existing fixture interviews move into the new interviews table, so every view reads from one source.
- **Uniqueness:** interview identifiers are enforced by a database constraint.
- **Unavailable dependencies:** network-dependent reads show a clear error, stale or loading state. They never show partial data or present a failed save as saved.
- **Display:** dates use `D MMM YYYY` in the `Asia/Dhaka` org timezone. Status/stage always has a text label, not colour alone. Controls must be keyboard-operable.
- **Definition of Done:** zod validation in every new server action before any store call. Both a store-level check and an RLS policy on the new table. Every new `src/domain/*` or `src/server/*` module has a matching `tests/*.test.ts`. Every acceptance criterion is covered by an automated test. `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Placement:** `src/server/interviews-store.ts` is the repository, and `src/server/interviews-actions.ts` holds the server actions. The staff-portal UI is a new interview view inside the existing staff portal. Server actions and domain code never import fixtures or the DB directly.
- **Store contract:** follow the `AttendanceStore` shape. A "not found" read returns `null`. Validation and authorization failures throw a typed error. Server actions return `{ error, message }` (`ActionState`).
- **The one "is Administrator" exception:** interview reads authorize "is this the reporting employee, or an Administrator-role account". The check never walks the department or manager chain. This keeps future `manager` sessions excluded automatically. The RLS policy must use the same predicate, not a department lookup. Remember the `manager` role is derived per request, and an Administrator account always stays `admin`.
- **Enforcement layers:** the store enforces the locked-field and author-only rules as the load-bearing check. RLS is a separate, second layer, and neither replaces the other.
- **Data model:** `ExternalInterview` belongs to one `Employee` (the author and subject are the same person). Dates are stored as ISO 8601 strings. Employee IDs match `^BS-\d{4}$`. Withdrawal is a status/flag on the record, not a deletion.
- **Persistence:** Supabase Postgres with forward-only SQL migrations in `supabase/migrations/`. Migrations reach the single shared project (dev, previews and the live demo) only when the PR is approved. The service-role key is server-only and limited to the seed and Administrator-only actions. Staff reads and writes should go through the per-request user (JWT) client so RLS applies.
- **RLS tests:** Vitest integration tests sign in as each role against the shared project, using dedicated test accounts and test-created rows that are cleaned up afterwards, never the seeded demo employees. They run under `npm test` when Supabase credentials are present.

## UX & Interaction Patterns

- No UX design contract exists. Reuse the existing staff-portal and Administrator profile patterns.
- Staff: add an interview, then edit its stage, outcome or feedback, or withdraw it. Locked fields are not offered for editing after creation.
- Administrator: interviews appear read-only in the profile Interviews tab and in the org-wide view. Withdrawn entries are hidden from active views but stay reachable in history, labelled "withdrawn".

## Cross-Story Dependencies

- **Depends on Epic 1:** named Staff and Administrator accounts with Supabase Auth, employee rows linked to auth users (`auth_user_id`), and the persistence and RLS foundation. Stories 1.1–1.3 and 1.5 are in review. Story 1.4 (archive and restore) is still backlog. Archived accounts keep their interview history unchanged.
- **2.1 before 2.2:** 2.1 creates the table, store, RLS policy and fixture migration. 2.2 adds the update and withdraw paths on top of them.
- **Epic 4 (Story 4.4)** later hides the interview views from `manager` sessions and adds an explicit test that a manager's direct query returns zero rows. Epic 2's predicate must make that test pass without changes. **Story 4.10** relies on managers reporting their own interviews through "My record" under the same author-only rules.
- **Epic 7** leaves Administrator editing of interview outcomes deferred. Do not add it here.
