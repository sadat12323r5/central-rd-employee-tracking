# Epic 9 Context: Agentic Workplace Simulation

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

LLM agents role-play a small workplace: one L&D manager (Administrator), one Central R&D department manager and eight staff, across eight simulated working weeks. They act only through the app's own server-side logic, each under its own permissions, to produce realistic demo data and a readable narrated timeline covering attendance, leave, interviews, assignments, evaluations, transfers and exports. This gives the System Owner a believable "two months of a real team" to demo, and it doubles as exploratory testing: if a bot cannot do something, a real user cannot either. The simulator is a developer tool run from a laptop (`npm run sim:*`) and is never part of the deployed web app.

## Stories

- Story 9.1: Simulation foundations: cohort, personas, clock and timeline
- Story 9.2: Persona tool layer
- Story 9.3: Persona agents and the eight-week orchestration
- Story 9.4: Run report, demo and documentation

## Requirements & Constraints

- **Scale:** 8 simulated working weeks (Mon 2026-08-03 to Fri 2026-09-25, 40 working days) and 8 staff personas plus the 2 managers. Working days are Mon–Fri, skipping holidays in the active live holiday calendar (Bangladesh 2026).
- **Persona coverage:** each persona has a role, seniority, personality and goals. Together the cohort must include a trainee, a senior engineer, a job-hunter who reports external interviews, someone on a client project, someone who takes leave around a holiday, and someone transferred mid-run.
- **Scripted events** over the run must include: a client project kickoff with assignments, a mid-run deadline crunch, leave clustered around a public holiday, an interview round, assignment closure followed by evaluations (some with client feedback), one transfer, and a skills review.
- **Refusals are findings.** An action the app refuses (validation, RLS, overlap, calendar, authority) goes back to the agent as a tool error carrying the app's message and is logged in the timeline. It is never forced through.
- **Cost and safety:** a hard budget `SIM_MAX_USD` (default 15). Cost is computed from each response's `usage` at the configured models' prices, and the run stops cleanly at a day boundary, with consistent data, before the budget would be exceeded. There are per-persona caps on actions per day, and prompt caching on the stable prefix (tool definitions plus persona system prompt).
- **Dry run:** a scripted fake model with no API key and no API calls, used for tests and CI. CI never runs a real (paid) simulation.
- **Secrets:** `ANTHROPIC_API_KEY` lives in `.env.local`. It is never committed and never printed. The report lists cohort login emails but never passwords.
- **Outputs:** `sim-output/<run>/timeline.jsonl`, `timeline.md` (one narrated line per event), `report.md` plus an HTML version, and `docs/SIMULATION.md`. The doc must cover the cost guardrails and the shared-database caveat.
- Existing Definition of Done still applies: zod validation, session-owned identity, no hard deletes, one test file per new `src/server`/`src/domain` module, `npm run check` and `npm run test:e2e` green.

## Technical Decisions

- **Through the app, never around it.** Every persona action calls the same server-side stores and actions the web app uses, with that persona's own Supabase session (its own JWT), so RLS, zod validation and role scoping all apply. The service role is used only to provision the cohort's accounts and employees, and only through the existing accounts-store create path and employee-create path (the single account-creation path rule).
- **Roles:** sessions are `admin` (org-wide; wins precedence even when also managing a department), `manager` (derived fresh per request from managing at least one Department; scoped to its subtree; never sees interviews), and `staff`. Tool sets must mirror these exactly:
  - Staff: clock in/out with work log; record/edit/cancel leave; add/update/withdraw an interview; backfill a past project; edit own employment history; read own record.
  - Manager: read team; create/update/close assignments; evaluate closed assignments; rate skills and write evaluations; record team leave; transfer within authority; department activity export.
  - Administrator: everything a manager can do, org-wide, plus department/manager administration and the all-employee export.
- **Tools:** `strict` JSON-schema tools with zod-validated input. Results follow the app's `{ error, message }` action shape.
- **Simulated clock:** time-dependent logic (clock-in/out timestamps, "today", leave dates, assignment dates) takes an injectable clock, used only by the simulator from server-side code. No HTTP route or server action may accept a client-supplied time, and a test must prove this. Org timezone is `Asia/Dhaka`. Dates are stored as ISO 8601.
- **Cohorts instead of resets:** leave, assignments and audit records are append-only, so each run creates a new cohort: employee ids `BS-2xxx` (a fresh range per run, still matching `^BS-\d{4}$`), accounts `sim-<run>-<persona>@example.com`, a cohort label in each employee's summary, and a new sub-department "Simulation Cohort <run>" under Central R&D with its own manager. `npm run sim:retire` archives earlier cohorts' employees and accounts through the app's archive path (reversible, audited, hides them from the default directory). It never touches `BS-1xxx` real/seeded employees or test ranges.
- **Domain rules agents will hit:** a transfer needs authority over both departments and is blocked while the employee has an open assignment. An assignment's department is frozen at creation. Interview company/role/date lock after creation. Evaluations apply only to closed assignments and record `authoredBy`. Leave overlap is rejected and cancelled leave is kept.
- **Models / SDK:** Anthropic TypeScript SDK `@anthropic-ai/sdk`. Managers use `claude-opus-5-5` and staff use `claude-haiku-5-5`, overridable via `SIM_MANAGER_MODEL` / `SIM_STAFF_MODEL`. Load the `claude-api` skill before writing SDK code and do not guess SDK APIs. On Opus 5.5 a forced `tool_choice` returns a 400, so use `auto` with `strict: true` tools. Use the SDK Tool Runner with a small per-persona action cap. `max_tokens` is bounded, and `refusal` / `max_tokens` stop reasons must be handled without crashing the run.
- **Agent state:** each day a persona gets a short brief (date, recent timeline, open items, scripted events affecting it), then acts: staff first, then managers. State persists as compact per-persona notes, not an ever-growing transcript.
- **Shared database:** there is one shared Supabase project. Tests use the fake model plus the existing live-test conventions: their own id range, sign in once per file, serial files.

## Cross-Story Dependencies

- Depends on Epics 1–8, all done: accounts/archive, persistence, interviews, training, departments/assignments/evaluations/transfers, leave and holiday calendar, editable records, and activity export.
- 9.1 (cohort provisioning, injectable clock, timeline writer, dry-run runner) is the base for everything else. 9.2's tools run under 9.1's persona sessions and clock. 9.3's agents and orchestrator drive 9.2's tools. 9.4 reports on the timeline and cost data from 9.3, and its demo criterion needs a real run so the deployed directory shows the cohort's data.
