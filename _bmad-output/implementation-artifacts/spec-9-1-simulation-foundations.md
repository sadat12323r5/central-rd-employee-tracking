---
title: 'Story 9.1: Simulation foundations: cohort, personas, clock and timeline'
type: 'feature'
created: '2026-10-18'
status: 'in-progress'
baseline_revision: '349fe26bb82a6f809caaf4fdb39e9923f798b91a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Epic 9 needs a safe skeleton before any LLM agent exists. That skeleton must provision a fresh cohort through the app's own paths, step a simulated calendar, give time-dependent writes a simulated clock and record a narrated timeline. Today none of this exists, and attendance writes hard-code `new Date()`.

**Approach:** Add a developer-only `sim/` package that runs under `tsx`, plus two CLIs, `npm run sim:run -- --dry-run` and `npm run sim:retire`. They provision a cohort with the existing accounts-store, departments-store and employees-store under the personas' own sessions. They step the Mon 2026-08-03 to Fri 2026-09-25 working days against the active live holiday calendar, and drive a scripted dry-run driver. That driver clocks staff in and out through a new shared attendance-commands module, which takes an injected `now`. Each event is written to `sim-output/<run>/timeline.jsonl` and `timeline.md`.

## Boundaries & Constraints

**Always:**
- **Service role, only two uses.**
  - Provisioning accounts goes through `createAccountsStore(() => service).create(...)` (admin form, and staff form after the employee row exists). Archiving goes through `createAccountsStore(...).archive(...)`.
  - Departments are created and managers set through `createDepartmentsStore` with the sim Administrator's own signed-in client.
  - Employees are created through `createEmployeesStore(...).create` with that same client.
  - Attendance is written through `createAttendanceStore` with each staff persona's own signed-in client.
- **Sign-ins.** Each persona signs in at most once per run. Passwords are random per run, held in memory only, and never written or printed.
- **Cohort identity.**
  - Cohort run id: `c<NN><4 hex>`, where NN is the block number.
  - Employee ids: a fresh block of 10 in the cohort range, `BS-2000`–`BS-2999` by default, with block NN = `BS-2<NN>0`–`BS-2<NN>9`. The next block is the one after the highest block in use.
  - Emails: `sim-<run>-<persona key>@example.com`.
  - Department: "Simulation Cohort <run>", with Central R&D (`CENTRAL_RD_DEPARTMENT_ID`) as its parent.
  - Summary: every employee's summary starts with the cohort label `Simulation cohort <run>.`
- **Dry run.** It never reads `ANTHROPIC_API_KEY`, imports no Anthropic SDK and makes no model call.
- **Refusals.** A refused action (a store error) becomes a `refusal` timeline event. It never crashes the run and is never retried around the app.
- **Retire scope.** Retire touches only non-archived employees whose id is in the cohort range AND whose summary starts with the cohort label.

**Never:** no LLM agents, tool layer or report (Stories 9.2–9.4). Also never:
- write tables directly with the service role (outside the two uses above);
- accept a client-supplied time in any HTTP route or server action;
- add a migration;
- import `sim/` from `src/app` or `src/components`;
- touch `BS-1xxx` or test-range employees from the CLI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Working days | Active BD-2026 policy | 40 weekdays from 2026-08-03 to 2026-09-25. Holidays 08-05, 08-26 and 09-04 are skipped, each recorded as a `holiday` event. 37 days are stepped | Year not covered: the run stops before provisioning with the calendar message |
| No active calendar | `active()` returns null | Exit non-zero with "No active holiday calendar…" and provision nothing | — |
| Block allocation | Ids in use in the range: none / `BS-2003`, `BS-2017` | Block 00 / block 02 | Range full: error, provision nothing |
| Real run requested | `sim:run` without `--dry-run` | Exit non-zero: real simulation arrives in Story 9.3 | — |
| Refused action | Driver clocks in twice on the same day | `refusal` event carrying the app's message; the run continues | — |
| Retire | Cohorts c00 and c01 exist, plus a range employee without the label | Default: c00 archived, c01 (newest) kept, the unlabelled employee untouched. `--all`: c00 and c01 archived | Cohort admin not found: skip that cohort with a warning |
| Forged time | A form posted to the clock-in/out/save-log actions with `now`, `date`, `workDate` or `clockIn` fields | The entry uses the server time | — |

</intent-contract>

## Code Map

- `src/server/attendance-actions.ts:27-81` -- `run()` passes `new Date()`. The three actions' bodies move into attendance-commands; the actions stay `(prev, form)`.
- `src/domain/timesheet.ts:75-120` -- `clockIn`, `clockOut`, `todaysEntry` and `buildLog` already take `now`. Reuse them.
- `src/server/attendance-store.ts:87` -- `createAttendanceStore({userClient, scope?})`. Its `listForEmployee` and `save` are the methods the commands use.
- `src/server/employees-store.ts:87,534-560` -- `create(session, input)`. Add an optional third argument `{ summary? }`, forwarded to the insert in place of `derived.summary`. Trim it and cap it at 500 characters; longer is an `EmployeeValidationError(["summary"])`. `employee-actions.ts` never passes it.
- `src/domain/employee-input.ts:19-27,110` -- `NewEmployeeInput`. Required fields: employeeId, name, title, team, email, departmentId, manager, office, employmentType (`Permanent|Trainee|Intern`), and optional joinedOn.
- `src/server/departments-store.ts:45,53,169` -- `create(session,{name,parentId})` and `setManager(session, deptId, employeeId)`. Admin only. The manager needs a linked account first.
- `src/server/accounts-store.ts:28-44,151,257` -- `create` (admin `{role,email,password}` / staff `{role,employeeId,password}`, password 12–72 characters) and `archive({employeeId, actorId})`. The actor is only audited (`cannot_archive_self` aside).
- `src/server/holiday-calendar-store.ts:52,113` -- `active(session)` returns `{version, policy}` or null. `src/domain/leave.ts:84` `isWorkingDay(iso, policy)` throws for an unsupported year.
- `src/data/departments.ts:9` -- `CENTRAL_RD_DEPARTMENT_ID`.
- `tests/leave-rls.test.ts:104-119,113-131` -- sign-in-once `Map` and service-role teardown patterns for the live test.
- `tests/attendance-actions.test.ts:78-88` -- forged-field and fake-timer pattern.
- `scripts/seed-admin.ts` -- `.env.local` loading (`process.loadEnvFile`) and service client options.
- `tsx` is installed as a devDependency (4.20.6). It resolves the `@/` paths, and the stores load under it (probed).

## Tasks & Acceptance

**Execution:**
- `src/server/attendance-commands.ts` -- new. `createAttendanceCommands(store)` returns `clockIn(employeeId, {workMode}, now)`, `clockOut(employeeId, {breakMinutes}, now)` and `saveLog(employeeId, {summary, blockers, tasks}, now)`, moved verbatim from the actions. `randomUUID` ids. Each returns the message.
- `src/server/attendance-actions.ts` -- delegate to the commands with `new Date()` from `run()`. Behaviour is unchanged.
- `src/server/employees-store.ts` -- optional `{ summary }` create option, as in the Code Map.
- `sim/calendar.ts` -- `SIM_START`, `SIM_END`, `simulatedCalendar(policy)` (returns `{workingDays, holidays:[{date,name?}], weekdays}`), and `dhakaInstant(isoDate, "HH:MM")` (Asia/Dhaka, +06:00).
- `sim/personas.ts` -- `PERSONAS`: 1 admin, 1 manager and 8 staff. Each has `key, name, role, seniority, title, employmentType, personality, goals[], traits[], joinedOn`. Traits cover `trainee`, `senior`, `job-hunting`, `client-project`, `holiday-leave` and `transfer`. Also exports `missingCoverage(personas)`.
- `sim/timeline.ts` -- `createTimeline(dir)` returns `record(event)` (appends one JSON line plus one narrated markdown line) and `close()`. `narrate(event)` is a pure function. Event fields: `seq, day, at, actor, kind (provisioned|day|holiday|action|refusal|end), text, detail?`.
- `sim/cohort.ts` -- `allocateBlock(usedIds, range)` and `provisionCohort(deps, {range, personas})`. Provisioning order:
  1. admin account;
  2. admin sign-in;
  3. department;
  4. for each manager and staff persona: employee (with summary label), then staff account;
  5. `setManager`;
  6. persona sign-ins.

  Also `retireCohorts(deps, {range, all})`, which uses the cohort's own admin (found by email through `service.auth.admin.listUsers`) as the actor. Deps are injected (stores, `signIn`, `listUsers`, `usedIds`).
- `sim/dry-run-driver.ts` -- scripted fake. Each staff persona clocks in (09:00–09:40 by persona index), saves a short log and clocks out at 18:00, all at simulated instants through attendance-commands. Managers and the admin record one `action` event a day ("reviewed the team"). Errors become refusals.
- `sim/runner.ts` -- `runSimulation({cohort, driver, calendar, timeline, maxDays?})`. It records `provisioned`, then `holiday` events and one `day` event per working day; it calls staff first, then managers, then the admin; it records `end`.
- `sim/env.ts` -- loads `.env.local`, checks that the 3 Supabase vars are non-empty (names only), and builds the service client plus the real deps.
- `scripts/sim/run.ts`, `scripts/sim/retire.ts` -- CLIs (`--dry-run`, `--days N`; `--all`). They print the run id and the output path, never passwords.
- `package.json` -- `sim:run` and `sim:retire` scripts (`tsx`). `.gitignore` -- `sim-output/`.
- Tests:
  - `tests/attendance-commands.test.ts`, `tests/sim-calendar.test.ts`, `tests/sim-personas.test.ts`, `tests/sim-timeline.test.ts`, `tests/sim-cohort.test.ts` and `tests/sim-runner.test.ts`: unit tests with fakes and the memory attendance store. They cover every matrix row and assert that no `@anthropic-ai` import or key read happens.
  - Additions to `tests/attendance-actions.test.ts` (forged time fields) and `tests/employees-store.test.ts` (summary option).
  - `tests/sim-live.test.ts`: live and gated. Range `BS-7000`–`BS-7099`, 2 staff and 2 days. It checks the department's parent, the summary label and that the attendance `work_date` equals the simulated dates, then retires with `--all` semantics and checks that an unlabelled range employee is untouched. Teardown uses the service role to delete attendance, employees, the department and auth users.

**Acceptance Criteria:**
- Given `npm run sim:run -- --dry-run`, when it runs against the shared project, then:
  - it provisions the cohort as above;
  - it steps 37 working days, recording the 3 holidays;
  - it writes `sim-output/<run>/timeline.jsonl` and `timeline.md` with one narrated line per event;
  - it makes no model call.
- Given the persona definitions, when loaded, then `missingCoverage(PERSONAS)` is empty and every persona has a role, seniority, personality and goals.
- Given `npm run sim:retire`, when it runs, then earlier cohorts' employees are archived through `accountsStore.archive` and nothing else is touched.
- Given the simulator clocks in with a simulated instant, when the entry is saved, then its date and clock-in time are that instant's. Given an HTTP form with forged time fields, then the server time is used.

## Spec Change Log

## Review Triage Log

## Design Notes

- **37 days, not 40.** The fixed period (8 weeks, Mon 2026-08-03 to Fri 2026-09-25) and "skip holidays" both come from the System Owner's architecture rules. Together they give 40 weekdays minus 3 Bangladesh holidays. The AC's "40 working days" is read as the 40 weekdays of the period. Extending past 2026-09-25 would contradict the fixed period.
- **Admin persona.** The Administrator persona is an account only, with no employee row: the admin form of `accounts-store` takes no employee. So retire archives cohort employees. The sim admin account itself stays, with a forgotten random password (deferred: disabling bot admin accounts).
- **`tsx`.** The stores use `@/` aliases and extensionless imports, which `node --experimental-strip-types` cannot resolve. Use `tsx`, which reads the tsconfig paths. Refactoring every store was rejected.
- **Summary option.** The `summary` column is displayed on the profile but set by no app path. A server-only create option keeps provisioning inside employees-store, under RLS.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass. The live tests run when the env vars are set
- `npm run build` -- expected: success
- `npm run test:e2e` -- expected: pass
- `npm run sim:run -- --dry-run --days 2` then `npm run sim:retire -- --all` -- expected: the timeline files are written, and the cohort is archived
