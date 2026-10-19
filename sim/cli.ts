import { join } from "node:path";
import type { CalendarPolicy } from "@/domain/leave";
import { calendarFromActive, SimSetupError } from "./calendar";
import { CohortError, DEFAULT_RANGE, provisionCohort, retireCohorts, type IdRange, type ProvisionDeps, type RetireDeps } from "./cohort";
import { createDryRunDriver } from "./dry-run-driver";
import { PERSONAS, type Persona } from "./personas";
import { runSimulation } from "./runner";
import { createTimeline } from "./timeline";
import type { MovableSimClock } from "./tools/clock";
import type { ServiceAudit } from "./tools/types";

// Story 9.1: what `npm run sim:run` and `npm run sim:retire` do, as functions returning an exit code so the
// tests drive them with fake dependencies. They print the run id, the output path and what was archived,
// never a password or key.

export type Output = { log: (line: string) => void; error: (line: string) => void };
const console_: Output = { log: line => console.log(line), error: line => console.error(line) };

// Story 9.3: a run without --dry-run is the real, model-driven simulation. Its agents (and the model SDK)
// are loaded with a dynamic import() only then, so the dry run never loads the SDK. The SDK client
// resolves its own credentials; nothing here reads or prints a key.

/** The persona agents module, loaded only on a real run. */
export type AgentsModule = typeof import("./agents/index");

export type RunArgs = { dryRun: boolean; days?: number };

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const args: RunArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? argv[++i] : arg.slice("--days=".length);
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1) throw new SimSetupError("--days needs a whole number of working days, 1 or more.");
      args.days = days;
    } else throw new SimSetupError(`Unknown option ${arg}. Use --dry-run and optionally --days N.`);
  }
  return args;
}

export type RunDeps = ProvisionDeps & {
  activeCalendar(): Promise<{ policy: CalendarPolicy } | null>;
  /** Story 9.3: the shared simulated clock and the export audit store (sim/env.ts); a real run needs both. */
  clock?: MovableSimClock;
  serviceAudit?: ServiceAudit;
};

export type RealRunOptions = {
  /** The SIM_* settings' source (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Loads the agents module (default: a dynamic import of ./agents/index). */
  loadAgents?: () => Promise<AgentsModule>;
  /** The model client (default: the agents module's real SDK client); tests pass a fake-fetch client. */
  createClient?: (agents: AgentsModule) => ReturnType<AgentsModule["createAnthropicClient"]>;
};

/** `sim:run`. Exit code 0 on success. */
export async function simRun(argv: readonly string[], {
  loadDeps, outputRoot = "sim-output", personas = PERSONAS, range = DEFAULT_RANGE, out = console_, ...real
}: { loadDeps: () => RunDeps; outputRoot?: string; personas?: readonly Persona[]; range?: IdRange; out?: Output } & RealRunOptions): Promise<number> {
  let args: RunArgs;
  try {
    args = parseRunArgs(argv);
  } catch (error) {
    out.error((error as Error).message);
    return 2;
  }
  if (!args.dryRun) return realRun(args, { loadDeps, outputRoot, personas, range, out, ...real });
  try {
    const deps = loadDeps();
    // The calendar is checked before anything is provisioned.
    const calendar = calendarFromActive(await deps.activeCalendar());
    const cohort = await provisionCohort(deps, { range, personas });
    const dir = join(outputRoot, cohort.run);
    out.log(`Cohort ${cohort.run}: ${cohort.departmentName}, employees ${cohort.ids[0]}-${cohort.ids[cohort.members.length - 2] ?? cohort.ids[0]}.`);
    const timeline = createTimeline(dir);
    const result = await runSimulation({ cohort, driver: createDryRunDriver(), calendar, timeline, maxDays: args.days });
    out.log(`Dry run ${cohort.run} done: ${result.days.length} working days, ${result.holidays.length} holidays, ${result.actions} actions, ${result.refusals} refusals.`);
    if (result.refusals > 0) {
      // Refusals are findings, not failures: the exit code stays 0.
      out.log(`The app refused ${result.refusals} step${result.refusals === 1 ? "" : "s"}; the reasons are in ${join(dir, "timeline.md")}.`);
    }
    out.log(`Timeline: ${join(dir, "timeline.md")} and ${join(dir, "timeline.jsonl")}`);
    return 0;
  } catch (error) {
    out.error(error instanceof SimSetupError || error instanceof CohortError
      ? error.message
      : `The simulation stopped: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return 1;
  }
}

/** The model-driven run: settings (exit 2 when invalid), then provisioning, the agents and the run files. */
async function realRun(args: RunArgs, {
  loadDeps, outputRoot, personas, range, out, env = process.env, loadAgents = () => import("./agents/index"), createClient,
}: { loadDeps: () => RunDeps; outputRoot: string; personas: readonly Persona[]; range: IdRange; out: Output } & RealRunOptions): Promise<number> {
  let agents: AgentsModule;
  let settings;
  try {
    agents = await loadAgents();
  } catch (error) {
    out.error(`Could not load the persona agents: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    settings = agents.parseAgentSettings(env);
  } catch (error) {
    if (error instanceof agents.SimSettingsError) {
      out.error(error.message);
      return 2;
    }
    throw error;
  }
  try {
    const deps = loadDeps();
    if (!deps.clock || !deps.serviceAudit) throw new SimSetupError("A real run needs the simulated clock and the export audit store (sim/env.ts createSimDeps).");
    const { clock, serviceAudit } = deps;
    const calendar = calendarFromActive(await deps.activeCalendar());
    const client = createClient ? createClient(agents) : agents.createAnthropicClient();
    const cohort = await provisionCohort(deps, { range, personas });
    const dir = join(outputRoot, cohort.run);
    out.log(`Cohort ${cohort.run}: ${cohort.departmentName}, employees ${cohort.ids[0]}-${cohort.ids[cohort.members.length - 2] ?? cohort.ids[0]}.`);
    out.log(`Models: ${settings.managerModel} (manager, Administrator) and ${settings.staffModel} (staff); budget SIM_MAX_USD $${settings.maxUsd.toFixed(2)}.`);
    const timeline = createTimeline(dir);
    const cost = agents.createCostTracker({ dayEstimateUsd: settings.dayEstimateUsd, warn: line => out.error(line) });
    const totalDays = Math.min(args.days ?? calendar.workingDays.length, calendar.workingDays.length);
    const driver = agents.createAgentDriver({ client, deps: { clock, serviceAudit }, cohort, settings, cost, timeline, totalDays });
    const result = await runSimulation({ cohort, driver, calendar, timeline, maxDays: args.days, budget: agents.budgetHooks(cost, settings.maxUsd) });
    driver.writeRunFiles(dir, result);
    out.log(`Run ${cohort.run} done: ${result.days.length} working days, ${result.holidays.length} holidays, ${result.actions} actions, ${result.refusals} refusals; spent $${cost.spent().toFixed(2)} of $${settings.maxUsd.toFixed(2)}.`);
    if (result.stopReason.kind === "budget") out.log(result.stopReason.message);
    out.log(`Timeline: ${join(dir, "timeline.md")} and ${join(dir, "timeline.jsonl")}; cost: ${join(dir, "cost.json")}; notes: ${join(dir, "notes.json")}`);
    return 0;
  } catch (error) {
    out.error(error instanceof SimSetupError || error instanceof CohortError
      ? error.message
      : `The simulation stopped: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return 1;
  }
}

/** `sim:retire`. Exit code 0 when nothing failed. */
export async function simRetire(argv: readonly string[], {
  loadDeps, range = DEFAULT_RANGE, out = console_,
}: { loadDeps: () => RetireDeps; range?: IdRange; out?: Output }): Promise<number> {
  const unknown = argv.filter(a => a !== "--all");
  if (unknown.length > 0) {
    out.error(`Unknown option ${unknown[0]}. Use --all to retire the newest cohort too.`);
    return 2;
  }
  try {
    const deps = loadDeps();
    const result = await retireCohorts({ ...deps, warn: line => out.error(line) }, { range, all: argv.includes("--all") });
    const runs = [...new Set(result.archived.map(a => a.run))];
    if (result.archived.length === 0 && result.skipped.length === 0 && result.failed.length === 0) out.log("No earlier cohort to retire.");
    if (runs.length > 0) out.log(`Archived ${result.archived.length} employees of cohorts ${runs.join(", ")}.`);
    if (result.skipped.length > 0) out.log(`Skipped ${result.skipped.length} cohort${result.skipped.length === 1 ? "" : "s"} whose Administrator account was not found.`);
    if (result.failed.length > 0) out.log(`Could not archive ${result.failed.length} employee${result.failed.length === 1 ? "" : "s"}; see the warnings above.`);
    if (result.kept.length > 0) out.log(`Kept the newest cohort ${result.kept.join(", ")} (use --all to retire it too).`);
    // A skipped cohort (its Administrator account is gone) is a warning, not a failure.
    return result.failed.length > 0 ? 1 : 0;
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
