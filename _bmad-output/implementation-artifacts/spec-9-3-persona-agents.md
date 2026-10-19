---
title: 'Story 9.3: Persona agents and the eight-week orchestration'
type: 'feature'
created: '2026-10-19'
status: 'draft'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-9-2-persona-tool-layer.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 9.1 and 9.2 provide a cohort, a simulated calendar, a timeline and role-scoped tools. Nothing yet decides, day by day and in character, what each persona does, keeps spend within a hard budget, or scripts the eight weeks' events.

**Approach:** Add persona agents (`sim/agents/`). Each working day, each persona gets a short brief and acts through the SDK Tool Runner with a small action cap: staff first, then the manager, then the Administrator. Each persona carries compact notes from day to day. A deterministic event script covers the epic's seven events. A cost tracker prices every response's `usage` and stops the run at a day boundary before `SIM_MAX_USD` would be exceeded. `npm run sim:run` without `--dry-run` now runs the real simulation.

## Boundaries & Constraints

**Always:**
- **Models.** Managers and the Administrator use `SIM_MANAGER_MODEL` (default `claude-opus-5-5`); staff use `SIM_STAFF_MODEL` (default `claude-haiku-5-5`).
- **Request shape.** `tool_choice` stays `auto` (never forced). The tools are 9.2's `toRunnableTools(toolsFor(role), ctx)` (`strict: true`). Adaptive thinking is left as the model default. `output_config.effort` comes from `SIM_EFFORT` (default `medium`). `max_tokens` comes from `SIM_MAX_TOKENS` (default 4000, capped at 16000).
- **Fallbacks.** Only for an Opus or Fable model id: `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. Haiku has no server-side fallback.
- **Prompt caching.** The stable prefix is cached: a deterministic tool order and a persona system prompt that contains no date, run id or other per-day text, with `cache_control: {type:"ephemeral"}` on the last system block. All per-day content goes in the user message.
- **Action cap.** `SIM_MAX_ACTIONS_PER_DAY` (default 6) tool calls per persona per day, enforced in the tool wrapper. A call over the cap returns a `DailyActionCapReached` refusal and is recorded. `max_iterations` is the cap + 2.
- **Stop reasons.** `refusal` and `max_tokens` end that persona's day with a timeline `refusal` event (`detail.source: "model"`, `stop_reason`, plus `stop_details` when present). The run continues.
- **SDK errors.** An SDK/API error after the SDK's own retries ends that persona's day with a recorded refusal. It never crashes the run.
- **Notes.** The brief asks the persona to end its reply with a line starting `NOTES:`. That text, capped at 1200 characters, replaces the persona's notes. A missing `NOTES:` keeps the old notes. Notes are never an ever-growing transcript: each day is a fresh one-message conversation.
- **Daily brief** (at most about 2500 characters). It holds:
  - the date and day number;
  - the persona's own timeline events from the last 3 working days (capped);
  - the scripted events affecting it today;
  - its notes;
  - a reminder that it acts only through the tools and stays in character.
- **Clock.** Before each persona acts, the driver sets the shared `deps.clock` to that day at the persona's start time: staff 09:00–09:40 by position, the manager 16:30, the Administrator 17:00.
- **Budget.**
  - `SIM_MAX_USD` (default 15; must be a positive number, otherwise exit 2 with a message).
  - Cost is summed from each response's `usage` (input, output, cache read, cache write) at per-model prices.
  - Before each day starts, if spent + the projected cost of one day (the mean of the completed days, or the configured per-day estimate before any day completes) > the budget, stop at that day boundary and record an `end` event that says why.
  - Hard guard: if spent reaches the budget mid-day, the remaining personas that day are skipped and the stop is recorded.
- **Run files.** The run writes `sim-output/<run>/cost.json` (tokens and USD per model, plus the stop reason) and `notes.json` (final notes per persona) for Story 9.4.
- **SDK boundary.** The SDK is imported only in `sim/tools/anthropic.ts` and `sim/agents/*`. The CLI loads `sim/agents` with a dynamic `import()` only on a real run, so the dry-run import graph never reaches the SDK. `ANTHROPIC_API_KEY` is never read, printed or logged by our code; the SDK client resolves its own credentials.

**Never:**
- make a real (paid) model call in tests or CI;
- force `tool_choice`;
- put per-day text before the cache breakpoint;
- grow a transcript across days;
- write anything outside the app's stores, `sim-output/` and the timeline;
- add the report (Story 9.4);
- add a migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal day | Scripted fake model: one `tool_use`, then `end_turn` with `NOTES: x` | The tool runs through `runTool` (an action event), the notes become `x`, and the usage is costed | — |
| Model per role | Staff, manager and admin personas | Requests use Haiku / Opus / Opus. Only Opus requests carry `fallbacks`. Env overrides are honoured | — |
| Action cap | The fake asks for 8 calls with cap 6 | Calls 7 and 8 return a `DailyActionCapReached` refusal and the store is called only 6 times | refusal events |
| Model refusal | The response has `stop_reason: "refusal"` | One `refusal` event with source `model`. The day continues with the next persona | no throw |
| max_tokens | The response has `stop_reason: "max_tokens"` | Same as a model refusal, with stop_reason `max_tokens` | no throw |
| API error | The fake fetch returns 500 (retries off in tests) | A refusal event with source `model` and the error class; the run continues | no throw |
| Budget projection | Budget 1.00, spent 0.70, day mean 0.40 | No new day starts; an `end` event says the projected spend exceeds `SIM_MAX_USD`; `cost.json` records the stop | — |
| Bad budget | `SIM_MAX_USD=abc` or `0` | Exit 2 with a message; nothing is provisioned | — |
| Event script | `EVENT_SCRIPT` over the 37 working days | Contains all 7 kinds: kickoff, crunch, holiday-leave (dates touching 2026-08-26), interview round, closure + evaluations with client feedback, transfer, skills review. Every target persona key exists | — |
| Caching | Any request | The system's last block has `cache_control`; the system text is identical across days for a persona; the tool list order is identical | — |

</intent-contract>

## Code Map

- `sim/runner.ts:20-90` -- `runSimulation({cohort, driver, calendar, timeline, maxDays})`. It already orders staff, then managers, then the admin, and records the `day`, `holiday` and `end` events.
  - Extend it with an optional `budget` hook: a pre-day check returning a stop reason, and a mid-day check.
  - Add the optional `SimDriver.beginDay?(day)`.
  - Add `DriverStep.recorded?: boolean`. Those steps are counted but not re-recorded, because `runTool` already recorded them.
  - Return `stopReason`.
- `sim/dry-run-driver.ts` -- the `SimDriver` and `DriverStep` types and `attempt()`. The dry-run behaviour stays unchanged.
- `sim/tools/anthropic.ts` -- `toRunnableTools(tools, ctx)`. Wrap it, or add an `onCall` hook, to enforce the daily cap and collect outcomes.
- `sim/tools/run.ts` -- `runTool` records the timeline events. `TOOL_NOT_ALLOWED` shows the refusal shape to copy.
- `sim/tools/catalog.ts` -- `toolsFor(role)`, in a deterministic order.
- `sim/tools/clock.ts` -- `MovableSimClock.set(date, time)`.
- `sim/env.ts:97-171` -- `SimDeps` (clock, serviceAudit, and `signIn`, which returns `tools`). `CohortMember.tools` comes from `sim/cohort.ts`.
- `sim/cli.ts` -- `simRun`. `REAL_RUN_UNAVAILABLE` is replaced by the real path. Keep the dry run unchanged.
- `sim/personas.ts` -- each persona's `traits`, `personality` and `goals` feed the system prompt.
- `sim/calendar.ts` -- `SIM_START`, `simulatedCalendar` and `dhakaInstant`. The BD-2026 holidays in the period are 08-05, 08-26 and 09-04.
- `tests/sim-tools-anthropic.test.ts` -- the fake-fetch Tool Runner pattern (`new Anthropic({apiKey:"test", fetch, maxRetries:0})`). Reuse it.
- `tests/sim-runner.test.ts:274-290` -- the boundary test. Allow `sim/agents/*` to import the SDK, and assert that `sim/cli.ts` has no static import of `./agents`.
- SDK facts (`@anthropic-ai/sdk@0.131.0`):
  - `client.beta.messages.toolRunner({...params, max_iterations})` is async-iterable over each `BetaMessage`; `await runner.done()` returns the final message.
  - `BetaFallbacksParam = 'default' | [...]`.
  - Prices (USD per MTok):

    | Model | Input | Output | Cache read | Cache write |
    |---|---|---|---|---|
    | `claude-opus-5-5` | 4 | 20 | 0.20 | 5 |
    | `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 |

    An unknown model is priced at 10 / 50 / 1 / 12.5 (the highest known tier), with a warning.

## Tasks & Acceptance

**Execution:**
- `sim/agents/cost.ts` -- the price table, `costOf(model, usage)`, `createCostTracker()` (`add`, `spent`, `perModel`, `dayClosed`, `projectedDay`), `parseBudget(env)` and `shouldStopBeforeDay`.
- `sim/agents/events.ts` -- `EVENT_SCRIPT` (kind, working-day index range, target persona keys or traits, brief text), `eventsFor(personaKey, dayIndex, date)` and `eventKinds()`.
- `sim/agents/brief.ts` -- `systemPrompt(persona, role)` (stable, no dates) and `dailyBrief({date, index, total, events, recent, notes})` (capped). Both pure.
- `sim/agents/agent.ts` -- `runPersonaDay({client, model, settings, persona, ctx, brief, notes, onUsage})`. It returns the steps plus `{notes, stop}` and handles the cap, stop reasons, API errors and `NOTES:` parsing.
- `sim/agents/driver.ts` -- `createAgentDriver({client, deps, cohort, settings, cost, timeline})`, implementing `SimDriver` with `beginDay` (sets the clock), per-persona `act`, and notes kept in memory and written to `notes.json` at the end.
- `sim/agents/settings.ts` -- reads `SIM_MANAGER_MODEL`, `SIM_STAFF_MODEL`, `SIM_EFFORT`, `SIM_MAX_TOKENS`, `SIM_MAX_ACTIONS_PER_DAY`, `SIM_MAX_USD` and `SIM_DAY_ESTIMATE_USD` (default 1.50). It validates them and returns a message for bad values.
- `sim/runner.ts` -- the budget hooks, `beginDay`, `recorded` steps and `stopReason`.
- `sim/cli.ts` -- the real-run path: parse the settings (exit 2 on bad values), dynamic-import the agents, create `new Anthropic()` through an injectable `createClient` (tests pass a fake-fetch client), then provision, run, and write `cost.json` and `notes.json`. It prints the run id, days and spend, never a key.
- `scripts/sim/run.ts` -- unchanged unless the dependencies need it.
- Tests:
  - `tests/sim-agents-cost.test.ts`, `tests/sim-agents-events.test.ts` and `tests/sim-agents-brief.test.ts`;
  - `tests/sim-agents-agent.test.ts`, with a fake fetch, covering every matrix row about requests, the cap, stop reasons, errors and caching;
  - `tests/sim-agents-driver.test.ts`, covering the clock per persona, staff-first order, the budget stop at a day boundary, the mid-day hard guard and the `cost.json` / `notes.json` contents;
  - an update to the `tests/sim-runner.test.ts` boundary test and the real-run CLI cases (bad budget exits 2; a fake-client run writes the files).

**Acceptance Criteria:**
- Given a simulated working day, when the orchestrator runs it, then each persona gets its daily brief (date, recent timeline, notes, today's scripted events) and acts through the Tool Runner within the action cap, staff first and then the managers. Its state is carried as compact notes, not a growing transcript.
- Given the event script, when the run covers eight weeks, then the kickoff, crunch, holiday leave, interview round, closure + evaluations with client feedback, transfer and skills review all occur in the briefs of the targeted personas.
- Given the model settings, when agents run, then the configured models are used, the stable tools and system prefix are cached, `max_tokens` is bounded, and refusal or `max_tokens` stops do not crash the run.
- Given `SIM_MAX_USD`, when projected spend would exceed it, then the run stops at a day boundary, records why, and leaves consistent data.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Transfer target.** The transfer needs a second department. The script has the Administrator create "Simulation Cohort <run> Platform" under the cohort department in week 4. In week 5 the manager closes the transfer persona's open assignment, and the Administrator then transfers the persona: a transfer is blocked while an assignment is open (Story 4.8).
- **Effort default.** The default is `medium`, which is Opus 5.5's own default. Lowering it for cost is the System Owner's call through `SIM_EFFORT`.
- **Attendance.** Past-dated clock-ins are still refused by the attendance RLS policy (Story 9.1's open decision). Agents will see those refusals and can adapt. They are findings, not bugs.
- **Cost.** One day is about 10 personas × at most 8 requests. The default per-day estimate of 1.50 USD makes the first-day projection conservative.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npx vitest run tests/sim-agents-*.test.ts tests/sim-runner.test.ts` -- expected: all pass
- `npm run check` -- expected: all pass
