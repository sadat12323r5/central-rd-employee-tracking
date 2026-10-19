import { join } from "node:path";
import type { CalendarPolicy } from "@/domain/leave";
import { calendarFromActive, SimSetupError } from "./calendar";
import { CohortError, DEFAULT_RANGE, provisionCohort, retireCohorts, type IdRange, type ProvisionDeps, type RetireDeps } from "./cohort";
import { createDryRunDriver } from "./dry-run-driver";
import { PERSONAS, type Persona } from "./personas";
import { runSimulation } from "./runner";
import { createTimeline } from "./timeline";

// Story 9.1: what `npm run sim:run` and `npm run sim:retire` do, as functions returning an exit code so the
// tests drive them with fake dependencies. They print the run id, the output path and what was archived,
// never a password or key.

export type Output = { log: (line: string) => void; error: (line: string) => void };
const console_: Output = { log: line => console.log(line), error: line => console.error(line) };

export const REAL_RUN_UNAVAILABLE =
  "A real (model-driven) simulation arrives in Story 9.3. Run `npm run sim:run -- --dry-run` for the scripted dry run.";

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

export type RunDeps = ProvisionDeps & { activeCalendar(): Promise<{ policy: CalendarPolicy } | null> };

/** `sim:run`. Exit code 0 on success. */
export async function simRun(argv: readonly string[], {
  loadDeps, outputRoot = "sim-output", personas = PERSONAS, range = DEFAULT_RANGE, out = console_,
}: { loadDeps: () => RunDeps; outputRoot?: string; personas?: readonly Persona[]; range?: IdRange; out?: Output }): Promise<number> {
  let args: RunArgs;
  try {
    args = parseRunArgs(argv);
  } catch (error) {
    out.error((error as Error).message);
    return 2;
  }
  if (!args.dryRun) {
    out.error(REAL_RUN_UNAVAILABLE);
    return 1;
  }
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
