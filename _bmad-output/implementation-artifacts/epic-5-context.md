# Epic 5 Context: Leave Workflow

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn the already-built, already-tested pure leave logic in `src/domain/leave.ts` (working-day counting, the five length categories, overlap detection, validation errors) into a real, persisted leave-record workflow. The Administrator loads a versioned holiday calendar. Leave can be recorded, edited and cancelled by the right people. The attendance summary is then computed entirely from real records instead of fixture data. This gives the L&D manager accurate worked, leave and missing-record totals per employee and across the organisation.

## Stories

- Story 5.1: Administrator loads the approved holiday calendar
- Story 5.2: Record a leave period
- Story 5.3: Edit or cancel a leave period
- Story 5.4: Attendance views use real data

## Requirements & Constraints

- **Holiday calendar decision (System Owner, 2026-10-17): provisional calendar adopted.** Until Brain Station 23's own approved calendar is available, the working calendar is Bangladesh's 2026 government public holidays in `docs/holiday-calendars/bangladesh-2026.csv`. Jurisdiction Bangladesh, timezone `Asia/Dhaka`, supported year 2026, working week Monday to Friday (Saturday and Sunday are weekends, so weekend holidays change no counts). Columns are `date` (ISO Asia/Dhaka date), `name`, and `kind` (`general` / `executive order` / `special`). This satisfies the precondition that blocked Story 5.1 and, through it, 5.2–5.4 and 8.4.
  - Story 5.1 loads that file as the initial calendar version, and the seed may load it.
  - **It must stay adjustable.** The Administrator can load a corrected or replacement file, or add another year (for example `bangladesh-2027.csv`), at any time. Every load is a new version, and existing leave records keep pointing at the version they were counted with, so past counts stay explainable. Islamic holidays may move by a day after moon sighting. The calendar is data, not code.
  - Dates outside the supported years fail with the existing `UNSUPPORTED_YEAR` error and are never guessed.
- **Who can do what:** only the Administrator loads or replaces the calendar, and non-Administrator attempts are rejected at the server. Leave is recorded and edited by the employee for themselves, by Department Managers for anyone in their department subtree, and by the Administrator for anyone. Managers and employee-linked Administrators record their own leave through "My record", with the same rules as any employee. Out-of-scope attempts are rejected at the server.
- **Leave rules:** working days exclude weekends and calendar holidays. The category label and colour are assigned automatically from the length. A save is rejected for overlap with another active leave record of the same employee, an invalid date, a reversed range, a year outside the calendar, or zero working days, each with its own clear message. On edit, working days and category are recalculated, and the overlap check ignores the record being edited.
- **Cancel, never delete:** cancelled leave is marked cancelled, stays in history, is excluded from later overlap checks, and is not counted in any totals.
- **Attendance summary (5.4):** worked days come from attendance records, leave days from non-cancelled leave, scheduled days from the calendar, and missing-record days from the difference. Nothing in the summary may still be read from `src/data/employees.ts`. This applies to both the profile Attendance tab and the org-wide Attendance & leave view.
- **Out of scope:** approvals, leave reasons, leave balances or entitlements.
- **Definition of Done (every story):** zod validation in every server action; a store-level check and an RLS policy on every new table; own-record identity from the session; no hard deletes; a test file for each new domain/server module, with every acceptance criterion covered; DB uniqueness constraints; `npm run check` and `npm run test:e2e` pass.

## Technical Decisions

- **Layers:** `src/domain/leave.ts` stays pure, with no framework or DB imports, and is reused rather than reimplemented. New `src/server/leave-store.ts` / `leave-actions.ts` (and a calendar store) follow the existing `AttendanceStore` repository shape. No feature folders.
- **Calendar store contract:** it stores versioned calendars and returns the active one as the `CalendarPolicy` type that `leave.ts` already expects. Each leave record references the calendar version used to count it.
- **Store contract:** `null` for not-found reads; typed errors for validation and authorization failures. Cross-entity invariants such as overlap are enforced at the store, which is the load-bearing point.
- **Authority:** manager scope uses the department authority set (the department's manager, every ancestor department's manager, and every Administrator). It is computed fresh per request and never cached in the session, and it is never a plain "is Administrator" check. The subject `employeeId` comes from the target record. For own-record actions it comes from the session, never the form.
- **Formats:** org timezone is `Asia/Dhaka` for date validation and display; dates are ISO 8601 at rest; action results use the `{ error, message }` shape.
- **Persistence/RLS:** Supabase, with forward-only migrations in `supabase/migrations/`, applied to the shared project only once the PR is approved. RLS tests sign in as admin, manager and staff test accounts and use only rows the test creates. The service-role key is server-only.
- **Known gap for 5.4:** `attendanceStore.listAll()` has no date window or paging yet. 5.4 should add one when it becomes the first caller.

## UX & Interaction Patterns

- A leave category is always shown with a text label as well as its colour.
- Dates render as `D MMM YYYY`, and controls are keyboard-operable.
- The Administrator loads the calendar as a file, such as the CSV described above.

## Cross-Story Dependencies

- Build order is 5.1, then 5.2 (needs the stored calendar), then 5.3, then 5.4. 5.3's "excluded from totals" behaviour is realised by 5.4's totals.
- Depends on Epic 1 (persistence, accounts, 1.5 attendance records) and Epic 4 (departments, manager authority, 4.10 "My record").
- Story 8.4 (leave rows in activity exports: type, dates, working-day count, status) depends on 5.2–5.3.
