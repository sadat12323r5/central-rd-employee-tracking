---
title: 'Story 5.1: Administrator loads the approved holiday calendar'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_revision: '0a1482ab2d0dd708858e266a749e7211079ddc24'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/docs/holiday-calendars/README.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The service role can still delete dates from a stored calendar version.
    evidence: |-
      No delete guard on holiday_calendar_dates; kept so live tests can clean up. Only the seed and tests hold the service role.
    location: >-
      supabase/migrations/20261017000000_holiday_calendars.sql
    severity: low
  - summary: >-
      The Holiday calendar panel lists versions but not the dates inside each one, and has no preview before a load becomes active.
    evidence: |-
      Not required by Story 5.1 ACs; useful when Islamic holidays move after moon sighting.
    location: >-
      src/components/holiday-calendar-panel.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/domain/leave.ts` counts working days against a `CalendarPolicy`, but nothing stores one: there is no holiday calendar in the database, so Stories 5.2–5.4 cannot count real leave. The System Owner adopted `docs/holiday-calendars/bangladesh-2026.csv` (2026-10-17) as the provisional calendar, and it must stay adjustable.

**Approach:** Add versioned holiday-calendar storage (Supabase, additive migration, RLS), a pure CSV parser, a store that loads a calendar (Administrator only) and returns the active version as a `CalendarPolicy`, an Administrator-only server action and a small "Holiday calendar" panel in the Administrator's Attendance & leave section, plus an idempotent seed of the provisional 2026 calendar.

## Boundaries & Constraints

**Always:**
- A load is one or more CSV files (header exactly `date,name,kind`; `kind` ∈ `general` / `executive order` / `special`) plus a jurisdiction (form text, 1–100 chars, default `Bangladesh`). Timezone is always the org timezone `Asia/Dhaka`. Supported years = the years the dates fall in, which must be contiguous; a year with no dates between two that have dates is rejected ("add that year's file too").
- Every load creates a NEW immutable version (version number increments); the active calendar is the highest version. Versions and their dates are never updated or deleted (no UPDATE/DELETE policy). Each version records who loaded it, when, and the source file name(s).
- The version row and its dates are written atomically (one Postgres function called via RPC, `security invoker`, so RLS applies; it also refuses any caller that is not an Administrator or the service role).
- Store returns `CalendarPolicy` (`holidays` as ISO date strings, `supportedYearStart/End`) usable unchanged by `countWorkingDays`; a date outside the supported years throws the existing `LeaveValidationError` `UNSUPPORTED_YEAR`.
- Administrator check in the action AND the store before any query; RLS insert admin-only; every signed-in role may SELECT (5.2 counts staff leave through the user's JWT). Uses `getUserClient` at runtime, never the service role (seed only).
- zod validation in the action; `{ error, message }` results; dates shown `D MMM YYYY`; an unavailable store is reported, never shown as "no calendar".
- Migration is ADDITIVE only.

**Never:** No leave records, leave UI or attendance changes (5.2–5.4). No editing of a stored version in place. No guessing of dates outside supported years. No hard-coded holidays in code. No approvals workflow.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Load provisional file | Admin, `bangladesh-2026.csv`, jurisdiction Bangladesh | Version N+1 stored with all 28+ holidays, years 2026–2026, Asia/Dhaka; it becomes active | "Holiday calendar version N+1 loaded (… holidays, 2026)." |
| Reload corrected file | Admin loads a changed 2026 file | New version; previous version still stored unchanged | — |
| Two years | 2026 + 2027 files in one load | One version, supported 2026–2027 | — |
| Gap in years | 2026 + 2028 files | Nothing saved | "The calendar must cover consecutive years: add 2027 too." |
| Bad header / kind / date / duplicate date / empty file / no files / too large (>200 KB total or >1000 rows) | malformed CSV | Nothing saved | Specific message naming the line number where applicable |
| Non-admin | staff or manager session calls the action or store load | Nothing saved | "Only an Administrator can load the holiday calendar." / `HolidayCalendarForbiddenError` |
| Count inside years | active policy, `2026-02-01..2026-02-28` | `countWorkingDays` excludes weekends and Feb holidays | — |
| Count outside years | active policy, a 2027 date | `LeaveValidationError` `UNSUPPORTED_YEAR` | — |
| No calendar loaded | empty tables | `active()` returns null; panel says none loaded yet | — |
| DB down | query error | `HolidayCalendarUnavailableError`; action says nothing saved | panel says unavailable |

</intent-contract>

## Code Map

- `src/domain/leave.ts` -- READ-ONLY. `CalendarPolicy`, `countWorkingDays`, `LeaveValidationError("UNSUPPORTED_YEAR")`. Reuse, do not change.
- `src/domain/dates.ts` -- `isCalendarDate`, `formatDisplayDate`, `formatDisplayDateTime` for validation/display.
- `src/domain/csv.ts` -- existing CSV writer only; the parser is new.
- `src/server/departments-store.ts` -- golden store pattern: `createXStore({ userClient })`, `run`/`runMaybe`, `refusal()` mapping DB codes to typed errors, `requireAdmin`, typed `*UnavailableError`/`*ForbiddenError`, exported singleton.
- `src/server/department-actions.ts` -- golden action pattern: `"use server"`, `getSession()`, admin check first, zod `safeParse`, `refusal()` to `ActionState`, `revalidatePath("/")`.
- `src/server/attendance-actions.ts` -- exports `ActionState`.
- `src/components/departments-panel.tsx` -- panel/form markup and classes (`staff-log`, `staff-field`, `Feedback`, `useActionState`).
- `src/components/portal.tsx:217` -- "Attendance & leave" section; add the panel for `role === "admin"` only. Portal props at ~line 115.
- `src/app/page.tsx` -- admin branch: read calendar versions alongside employees/departments; an error becomes `null` (logged), not a page failure.
- `supabase/migrations/20261014000000_departments.sql` -- migration/RLS style (`auth.jwt() -> 'app_metadata' ->> 'role'`).
- `tests/departments-rls.test.ts` -- live-DB test pattern: skipIf unconfigured, throwaway users, one sign-in per user per file, service-role cleanup.
- `tests/departments-store.test.ts`, `tests/components/departments-panel.test.tsx`, `tests/e2e/departments.spec.ts` -- unit/component/e2e patterns.
- `scripts/seed-employees.ts` -- idempotent insert-only seed; add the calendar seed here.
- `docs/holiday-calendars/bangladesh-2026.csv` -- the provisional calendar (fixture for tests and seed).

## Tasks & Acceptance

**Execution:**
- `supabase/migrations/20261017000000_holiday_calendars.sql` -- ADDITIVE: tables `holiday_calendar_versions` (uuid id, `version` int identity unique, jurisdiction, timezone check = 'Asia/Dhaka', supported_year_start/end with end ≥ start, source text, loaded_by uuid default auth.uid(), loaded_at timestamptz) and `holiday_calendar_dates` (version_id FK on delete restrict, holiday_date date, name 1–200, kind check, PK(version_id, holiday_date)); RLS select for authenticated, insert admin-only, no update/delete; function `load_holiday_calendar(p_jurisdiction, p_timezone, p_year_start, p_year_end, p_source, p_holidays jsonb)` security invoker, `set search_path = ''`, refuses non-admin non-service-role callers (raise 42501), checks each date within years (raise check_violation), inserts version + dates, returns the version row; execute granted to authenticated and service_role only.
- `src/domain/holiday-calendar.ts` -- pure: `parseHolidayCsv(text, fileName)` (quoted fields, CRLF/LF, BOM, blank trailing lines) and `buildCalendar(files)` → `{ supportedYearStart, supportedYearEnd, holidays: {date,name,kind}[] }` sorted by date, with `HolidayCalendarInputError(message)` for every rule in the matrix; `toCalendarPolicy(...)`.
- `src/server/holiday-calendar-store.ts` -- `load(session, input)`, `active(session)` → `{ version: CalendarVersion; policy: CalendarPolicy } | null`, `versions(session)` (admin, newest first, with holiday counts). Typed errors as in the matrix.
- `src/server/holiday-calendar-actions.ts` -- `loadHolidayCalendarAction(prev, form)`: admin check, zod on jurisdiction, files from `form.getAll("files")` (File, `.csv`, size limits), parse, store.load, revalidate.
- `src/components/holiday-calendar-panel.tsx` -- shows the active version (version, jurisdiction, timezone, years, holiday count, loaded at, source) and earlier versions, the load form (file input `multiple accept=".csv"`, jurisdiction), feedback; `null` versions → "unavailable" alert.
- `src/components/portal.tsx`, `src/app/page.tsx` -- wire the panel for Administrators only.
- `scripts/seed-employees.ts` -- if no calendar version exists, load `docs/holiday-calendars/bangladesh-2026.csv` through the RPC with the service role (insert-only, idempotent).
- Tests: `tests/holiday-calendar.test.ts` (parser/build matrix rows + policy with `countWorkingDays`, incl. UNSUPPORTED_YEAR), `tests/holiday-calendar-store.test.ts` (fake client: admin-only, mapping, active null, policy), `tests/holiday-calendar-actions.test.ts`, `tests/components/holiday-calendar-panel.test.tsx`, `tests/holiday-calendar-rls.test.ts` (live: admin loads, staff refused at RLS/RPC, staff can read, no update/delete, store `active()` policy + UNSUPPORTED_YEAR), `tests/e2e/holiday-calendar.spec.ts` (admin uploads the CSV, sees new version).

**Acceptance Criteria:**
- Given an Administrator and the provisional CSV, when they load it from the Attendance & leave section, then a new version is stored and shown as active, and `holidayCalendarStore.active()` returns a `CalendarPolicy` that `countWorkingDays` accepts.
- Given the stored calendar and a date outside its supported years, when `countWorkingDays` is called with the returned policy, then it throws `UNSUPPORTED_YEAR`.
- Given a Staff or manager session, when it calls the load action, the store load, or the RPC/table insert directly, then it is rejected at the server and nothing is stored.

## Spec Change Log

- 2026-10-17 -- **Calendar purpose (bug fix).** "Active = the highest version in the database" let throwaway test calendars (RLS Calendar / E2E Calendar, one with 0 holidays) become the live site's active calendar in the shared project. New migration `20261018010000_holiday_calendar_purpose.sql` (DESTRUCTIVE: redefines `load_holiday_calendar` and `leave_records_guard`; the column is additive) adds `holiday_calendar_versions.purpose` (`live` default / `test`) and an optional `p_purpose` to `load_holiday_calendar`. Active = the highest **live** version; `holidayCalendarStore.active()` and `versions()` read live versions only; the app's Administrator load always passes `live`. Tests load `test` calendars; the two deliberate live-load checks restore the provisional Bangladesh calendar as a new live version afterwards. Every other 5.1 rule (Asia/Dhaka, supported years, append-only, insert only through the RPC, grants) is unchanged.

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 32 findings — high 0, medium 2, low 16, false 3, maybe-false 2 (plus 9 descriptive/design rows rejected as out of scope or settled by the spec)
- findings:
  - `[medium]` `[patch]` (blind) Admin could insert directly into holiday_calendar_versions, creating an empty active version — insert policies now also require the `app.holiday_calendar_loading` setting that only load_holiday_calendar turns on; live test added for admin direct inserts.
  - `[low]` `[defer]` (blind) Service role can still delete dates from a stored version — only the seed/tests hold the service role; deferred (a delete guard would block test cleanup).
  - `[low]` `[patch]` (blind) Live test's "corrected" version dropped a Friday holiday, briefly changing counts in the shared project — now drops 2026-05-30 (Saturday).
  - `[maybe-false]` `[reject]` (blind) active() assertions flaky if two runs overlap — test files run serially; only concurrent CI runs could collide; would need evidence of overlapping runs.
  - `[false]` `[reject]` (blind) Jurisdiction does not separate calendars — by design a version is the single org calendar (spec Design Notes); jurisdiction is a label.
  - `[low]` `[defer]` (blind) Admin cannot see the dates inside a version — no AC requires it; deferred as UX follow-up.
  - `[low]` `[defer]` (blind) No preview/confirm/rollback — reloading the earlier file restores it; deferred.
  - `[low]` `[reject]` (blind) Panel does not show who loaded a version — it is recorded (spec requires recording, not display); adding a name lookup is new surface.
  - `[low]` `[patch]` (blind+edge) Non-UTF-8 files decoded silently — fatal TextDecoder with a clear "save as CSV UTF-8" message.
  - `[low]` `[patch]` (blind+edge) Parser accepted years the DB rejects (1900–2999) — per-line year bound added.
  - `[low]` `[patch]` (blind+edge) 23502/22P02 reported as "unavailable" — mapped to the input error.
  - `[low]` `[patch]` (blind) Invisible BOM literal — written as "\uFEFF".
  - `[low]` `[patch]` (blind) Seed: uncaught HolidayCalendarInputError — caught, logged, exit 1.
  - `[low]` `[reject]` (blind+edge) Seed check-then-insert race — the seed is run once by a human; an advisory lock is more code than it buys.
  - `[low]` `[reject]` (blind) versions() unbounded / embedded count reliance — a handful of versions per year; count path is covered by the live test once the migration is applied.
  - `[medium]` `[patch]` (edge+gap) >1000 holidays silently truncated by active()'s range — RPC raises check_violation over 1000 and the store's checked() enforces the same cap.
  - `[low]` `[patch]` (edge) Store/action did not bound source length (DB 2000) — checked() rejects >2000 with its own message.
  - `[low]` `[patch]` (edge) Quoted two-field header accepted — header must have exactly 3 fields.
  - `[low]` `[patch]` (edge) Non-File form entry shows zod's default message — custom message on z.instanceof.
  - `[maybe-false]` `[reject]` (edge) Concurrent loads may commit out of identity order — needs two admins loading in the same instant; would only be low.
  - `[false]` `[reject]` (edge) Missing embedded count shows 0 — PostgREST always returns the aggregate for an embedded count; an absent key means a broken API, already surfaced by other reads.
  - `[low]` `[patch]` (gap) Nothing checks the domain module loads under node --experimental-strip-types for the seed — tests/holiday-calendar-strip-types.test.ts added.
  - `[false]` `[reject]` (intent) Manager not tested against RLS — RLS/RPC key on role = 'admin' only, so a manager JWT (role staff) is the Staff case, which is tested.
  - `[low]` `[reject]` (intent) Supported years derived from dates instead of declared — settled by the spec Boundaries; an empty supported year is not a real calendar.
  - `[low]` `[reject]` (intent) "Add a year" requires reloading all years — settled by the spec Design Notes (a version is a complete calendar).
  - remaining 7 intent-audit rows (UI beyond ACs, timezone fixed, replace = new version, staff read access, CSV format rules, Mon–Fri not stored, version pointer untested until 5.2) — descriptive, consistent with the spec; no action.

## Design Notes

A version is a complete calendar (all its years), so "add a year" = load the existing year's file together with the new one; the active policy is never assembled from several versions. This keeps `CalendarPolicy`'s contiguous year range honest and makes "which calendar counted this leave" a single version id for 5.2.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass; live-DB holiday-calendar tests may fail only with schema-missing errors (42P01, PGRST205, PGRST202) until the migration is applied
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass except the holiday-calendar spec, which may fail only on schema-missing errors until the migration is applied

## Auto Run Result

Status: done (needs migration `supabase/migrations/20261017000000_holiday_calendars.sql`, ADDITIVE, and `npm run db:seed` to load the provisional calendar)

**Summary:** Versioned, immutable holiday calendars in Supabase; a pure CSV parser/builder; `holidayCalendarStore` (`load` admin-only via the atomic `load_holiday_calendar` RPC, `active()` → `CalendarPolicy` for any signed-in role, `versions()` admin-only); `loadHolidayCalendarAction`; a "Holiday calendar" panel in the Administrator's Attendance & leave section; idempotent seed of `docs/holiday-calendars/bangladesh-2026.csv`.

**Files:**
- `supabase/migrations/20261017000000_holiday_calendars.sql` -- tables, guards, RLS (insert only through the RPC), RPC.
- `src/domain/holiday-calendar.ts` -- CSV parse, multi-file build, policy conversion.
- `src/server/holiday-calendar-store.ts` / `holiday-calendar-actions.ts` -- store and server action.
- `src/components/holiday-calendar-panel.tsx`, `src/components/portal.tsx`, `src/app/page.tsx` -- UI and wiring (Administrator only).
- `scripts/seed-employees.ts` -- provisional calendar seed.
- Tests: `tests/holiday-calendar{,-store,-actions,-rls,-strip-types}.test.ts`, `tests/components/holiday-calendar-panel.test.tsx`, `tests/e2e/holiday-calendar.spec.ts`, wiring cases in `tests/components/portal.test.tsx` and `tests/page.test.tsx`.

**Review:** 13 patches applied (2 medium, 11 low), 3 deferred (low), the rest rejected with reasons in the triage log.

**Follow-up review recommended:** true -- two medium findings were patched (direct-insert bypass, >1000-row truncation) and none of the SQL has run against a database yet; the RLS test file is the check once the migration is applied.

**Verification:** `npm run typecheck` clean; `npx vitest run` 1994 passed, 7 failed -- all in `tests/holiday-calendar-rls.test.ts`, schema-missing (PGRST205 table / PGRST202 function); `npm run build` succeeds; e2e 36 passed, 3 failed: `holiday-calendar.spec.ts` (PGRST202 on the RPC), and `portal.spec.ts` + `provision-staff.spec.ts` because the Next dev error indicator raised by the logged PGRST205 versions read covers the Sign out button. With the versions read stubbed to succeed, those two pass (3 passed); both pass on origin/main.

**Residual risks:** SQL untested against Postgres (`current_user = 'service_role'` check, transaction-scoped `app.holiday_calendar_loading` setting, same-transaction dates guard, embedded count). Live tests briefly make a throwaway version active in the shared project.
