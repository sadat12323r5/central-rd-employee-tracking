---
title: 'Story 9.2: Persona tool layer'
type: 'feature'
created: '2026-10-19'
status: 'draft'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-9-1-simulation-foundations.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 9.3's persona agents need tools that match exactly what their role can do in the app. Every call must run through the app's own stores under the persona's own Supabase session and the simulated clock. Story 9.1 only gave the simulator attendance commands.

**Approach:** Add an SDK-agnostic tool catalogue (`sim/tools/`). Each tool is a zod-validated (strict object) input plus a `run` that calls one app store method with the persona's session, stores and clock. A role filter returns only that role's tools. One adapter file turns them into `strict: true` `betaZodTool`s for the SDK Tool Runner, rethrowing refusals as `ToolError` so they reach the model with `is_error: true`. Every call is recorded in the timeline as an `action` or a `refusal`.

## Boundaries & Constraints

**Always:**
- **Tool sets.**
  - Staff tools: `clock_in`, `clock_out`, `save_work_log`, `record_leave`, `edit_leave`, `cancel_leave`, `add_interview`, `update_interview`, `withdraw_interview`, `backfill_project`, `add_employment_history`, `edit_employment_history`, `remove_employment_history`, `read_my_record`.
  - Manager tools: `read_team`, `create_assignment`, `update_assignment_note`, `close_assignment`, `evaluate_assignment`, `rate_skill`, `save_evaluation`, `record_team_leave`, `transfer_employee`, `export_department_activity`.
  - Administrator: every manager tool (the stores scope it org-wide) plus `create_department`, `update_department`, `set_department_manager`, `export_all_activity`.
- **Input schemas.** Each one is a `z.object({...}).strict()` with every property required; optional values are `.nullable()`. Limits and formats mirror the app's (see Code Map). An input that fails zod is a refusal and the store is never called.
- **Session and stores.** A tool runs under the persona's `member.session`. Staff-form tools (attendance, interviews, backfill, own record) use `ownRecordIdentity(session)`. It calls only that persona's stores (its own JWT client). The single exception is the export audit store, which uses the service-role `createAuditStore`, as `activity-actions.ts` does.
- **Time.** Every "now"/"today" comes from the injected `SimClock` (`now(): Date`, `today(): ISO date`): attendance instants, export `now`, the backfill store's `now`, and the default assignment start and close dates.
- **Refusals.** Any store or domain error, or a zod failure, gives `{ ok: false, error: <class name>, message: <the error's message> }`. That is recorded as a `refusal` (with the tool name). It is never retried and never worked around.
- **Results.** A success gives `{ ok: true, text }`, with `text` at most 4000 characters. Reads return compact JSON. Exports return the filename and row count, never the CSV.
- **SDK boundary.** `@anthropic-ai/sdk` is imported only by `sim/tools/anthropic.ts`. Nothing reads `ANTHROPIC_API_KEY`, and the dry-run modules never import the adapter.

**Never:**
- add tools beyond the lists above, or let a role see another role's tools;
- call `"use server"` actions (they need Next request cookies);
- write with the service role, except the export audit row;
- make a model call in tests;
- add a migration;
- build the agents or orchestrator (Story 9.3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Role filter | `toolsFor("staff" / "manager" / "admin")` | Exactly the 14 / 10 / 14 tools named above. Staff and manager names are disjoint | — |
| Happy path | `record_leave {startDate:"2026-08-24", endDate:"2026-08-25"}` as staff | `leave.record(staffSession, ownId, {...})` is called; the result is `ok`; an `action` event is recorded | — |
| Clocked call | `clock_in {workMode:"Office"}` on 2026-08-10 | The commands get `clock.now()`. The entry is dated 2026-08-10 | — |
| Default date | `close_assignment {assignmentId, completionDate:null}` | `assignments.close(session, id, clock.today())` | — |
| Invalid input | Unknown key, wrong enum or over-length text | `ok:false`, error `InvalidToolInput`, the zod issue paths in the message; the store is not called | refusal event |
| App refusal | The store throws `LeaveOverlapError` / `TransferOpenAssignmentError` / an RLS-wrapped unavailable error | `ok:false` carrying that class name and its message (plus the cause code when present) | refusal event; no throw |
| SDK adapter | A tool converted by `toRunnableTools` | `strict: true`, `input_schema.additionalProperties === false`; a refused run throws the SDK `ToolError` carrying the message | — |

</intent-contract>

## Code Map

- `sim/env.ts:413-428` -- `storesFor(client)`. Extend it, or add `personaStoresFor(client, service, clock)` beside it, building every store below on the persona's client with `scope: createManagerScope({userClient})`:
  - **Always pass `calendar: createHolidayCalendarStore({userClient})`** to `createLeaveStore`, and pass `leave` to `createEmployeesStore`. The defaults use the Next request client.
- `sim/cohort.ts` (`CohortMember`: `session`, `employeeId`, `userId`, `attendance`; `PersonaStores`) -- widen `PersonaStores`, or add a tool-stores type, so the members carry the stores. Keep 9.1's provisioning behaviour unchanged.
- `src/server/attendance-commands.ts` -- clock_in / clock_out / save_work_log (`TimesheetValidationError`, `AttendanceUnavailableError`).
- `src/server/leave-store.ts` -- `record(session, employeeId, {startDate,endDate})`, `update(session, id, …)`, `cancel(session, id)`. Staff pass their raw session and own id; managers use it for `record_team_leave`.
- `src/server/interviews-store.ts` -- `add(staffSession, {company, role, date, stage, outcome})`, `update(…, id, {stage, outcome, feedback})`, `withdraw`. Limits: company/role/stage 1–200, outcome 0–200, feedback 0–2000, date `YYYY-MM-DD`, id uuid. These are the action's zod rules, which the tool must replicate.
- `src/server/backfilled-project-store.ts:186-189` -- `add(ownIdentity, {departmentId(uuid), client, projectName, completionDate, outcome})`, with `now` injectable. Limits 200/200/2000.
- `src/server/employment-history-store.ts` -- `add(session, employeeId, {role, employer, period, detail})`, `update(session, id, …)`, `remove(session, id)`. Limits 200/200/60 (a period must contain a year)/2000.
- `src/server/employees-store.ts` -- `getFor(own, own.employeeId)`, `listFor(session)` (the team), and `transfer(session, employeeId, toDepartmentId)`.
- `src/server/assignments-store.ts` -- `create(session, employeeId, {client, projectName, role, allocation(0–100 int), startDate})`, `updateNote(session, id, note≤2000)`, `close(session, id, completionDate)`.
- `src/server/assignment-evaluations-store.ts` -- `create(session, assignmentId, {evaluation 1–4000, clientFeedback 0–2000})`.
- `src/server/assessments-store.ts` + `src/domain/assessment-input.ts` -- `rateSkill(session, employeeId, {name 1–80, level 1–5, evidence 1–300})` and `saveEvaluation(session, employeeId, {strengths, developmentPriorities 1–1000, readiness 1–120})`.
- `src/server/departments-store.ts` -- `create(session, {name≤100, parentId|null})`, `update(session, id, {name, parentId})`, `setManager(session, id, employeeId|null)`.
- `src/server/activity-export.ts` + `src/server/activity-actions.ts` (dependency assembly) -- the export functions:
  - `exportActivity(deps, session, actorId, input, now)` and `exportAllActivity(deps, session, actorId, input, now)`.
  - Period values: `this-week|last-week|month|year|custom|all`, with `month`/`year`/`from`/`to` as strings. `includeArchived` is `"on"` or `""`.
  - The audit store is `createAuditStore(() => service)`.
- `src/server/session.ts` -- `SessionIdentity` and `ownRecordIdentity`.
- `tests/sim-runner.test.ts:274-290` -- the 9.1 boundary test. Narrow it: only `sim/tools/anthropic.ts` may match `@anthropic-ai`; no `sim/` file reads `ANTHROPIC_API_KEY`; `sim/cli.ts`, `runner.ts`, `dry-run-driver.ts`, `cohort.ts` and `env.ts` never import `tools/anthropic`.
- SDK (`@anthropic-ai/sdk@0.131.0`, already a devDependency):
  - `betaZodTool({name, description, inputSchema, run})` from `@anthropic-ai/sdk/helpers/beta/zod` (zod v4).
  - `ToolError` from `@anthropic-ai/sdk/lib/tools/ToolError`; the runner maps a thrown error to `is_error: true`.
  - Add `strict: true` by spreading `{ ...betaZodTool(...), strict: true }`.

## Tasks & Acceptance

**Execution:**
- `sim/tools/types.ts` -- defines:
  - `SimClock`;
  - `ToolContext {member, stores, clock, timeline, serviceAudit}`;
  - `SimTool {name, description, roles, input: ZodObject, run(ctx, input) => Promise<string>}`;
  - `ToolOutcome`.
- `sim/tools/catalog.ts` -- every tool listed above, plus `toolsFor(role)`.
- `sim/tools/run.ts` -- `runTool(tool, ctx, rawInput)`: zod `safeParse`, then run, catching errors into a `ToolOutcome`, records the timeline event and caps the text. `describeError` reuses the cause formatting of `attempt()` in `sim/dry-run-driver.ts`; extract it into a shared helper.
- `sim/tools/anthropic.ts` -- `toRunnableTools(tools, ctx)`: for each tool, `{...betaZodTool({name, description, inputSchema: tool.input, run: async i => { const r = await runTool(...); if (!r.ok) throw new ToolError(`${r.error}: ${r.message}`); return r.text; }}), strict: true}`.
- `sim/tools/clock.ts` -- `createSimClock(date, time?)`, returning a clock fixed at that Dhaka instant. `advance(minutes)` is optional.
- `sim/env.ts` / `sim/cohort.ts` -- persona tool stores, as in the Code Map.
- `tests/sim-tools-catalog.test.ts` -- covers:
  - the role sets;
  - one mapping test per tool (fake stores record the call, and assert the arguments, the session and the clock);
  - the zod refusals;
  - the app-refusal mapping;
  - the timeline events.
- `tests/sim-tools-anthropic.test.ts` -- covers:
  - `strict: true` and `additionalProperties: false` on every tool;
  - success returns the text;
  - a refusal throws a `ToolError` whose message carries the class name and message;
  - no network is used (`run` is called directly).
- `tests/sim-runner.test.ts` -- narrow the boundary test as in the Code Map.

**Acceptance Criteria:**
- Given a persona of each role, when its tool set is built, then it exposes only that role's tools, each a strict JSON-schema tool with zod-validated input.
- Given an action the app refuses, when a tool runs it, then the result is an error carrying the app's message, the timeline records the refusal, and nothing throws to the caller (the adapter throws `ToolError` only so the SDK marks `is_error`).
- Given the unit tests with a fake model and fake stores, when they run, then each tool maps its input to the right store call under the persona's session and simulated clock.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Stores, not actions.** The server actions read the Next request cookie (`getSession`), so a script cannot call them. The tools call the same stores the actions call, and replicate the action-level zod checks where a store relies on them (interviews, backfill `departmentId`).
- **Messages.** "The app's message" is the store error's own `message` (plus the database cause code for unavailable errors, as in 9.1). The per-action friendly wording is UI text.
- **Server-stamped dates are not simulated.** `created_at`, cancel and withdraw stamps, the evaluation review date and the backfill trigger's "not in the future" check all use the database's `now()`. Only the dates the app takes as input or computes in Node follow the simulated clock.
- **Attendance.** Against the shared project, attendance writes for past simulated dates are refused by RLS, a decision deferred in Story 9.1. Those calls surface as refusals, which is the intended behaviour.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npx vitest run tests/sim-tools-catalog.test.ts tests/sim-tools-anthropic.test.ts tests/sim-runner.test.ts` -- expected: all pass
- `npm run check` -- expected: all pass
