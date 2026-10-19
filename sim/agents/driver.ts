import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { dhakaClock } from "../calendar";
import type { Cohort, CohortMember } from "../cohort";
import type { DriverStep, SimDay, SimDriver } from "../dry-run-driver";
import type { StopReason } from "../runner";
import type { Timeline } from "../timeline";
import type { MovableSimClock } from "../tools/clock";
import type { ServiceAudit } from "../tools/types";
import { runPersonaDay } from "./agent";
import { dailyBrief, RECENT_MAX_EVENTS } from "./brief";
import type { CostTracker } from "./cost";
import { eventsFor } from "./events";
import type { AgentSettings } from "./settings";

// Story 9.3: the model-driven SimDriver. `beginDay` moves the shared simulated clock to the day; before a
// persona acts its clock is set to the persona's start time (staff 09:00-09:40 by position, the manager
// 16:30, the Administrator 17:00). Each persona gets its daily brief (date, its own events from the last
// 3 working days, today's scripted events, its notes) and acts through runPersonaDay with its role's
// model. Notes live in memory between days, never a transcript, and `writeRunFiles` saves notes.json and
// cost.json for the report (Story 9.4).

export const RECENT_WORKING_DAYS = 3;

export function startTime(member: CohortMember, position: number): string {
  if (member.persona.role === "manager") return "16:30";
  if (member.persona.role === "admin") return "17:00";
  return `09:${String(Math.min(40, position * 5)).padStart(2, "0")}`;
}

export type AgentDriver = SimDriver & {
  notes(): Record<string, string>;
  /** Writes `notes.json` and `cost.json` into `dir`. */
  writeRunFiles(dir: string, result: { run: string; days: readonly string[]; stopReason: StopReason }): void;
};

export function createAgentDriver({ client, deps, cohort, settings, cost, timeline, totalDays }: {
  client: Anthropic;
  deps: { clock: MovableSimClock; serviceAudit: ServiceAudit };
  cohort: Cohort;
  settings: AgentSettings;
  cost: CostTracker;
  timeline: Pick<Timeline, "record" | "events">;
  /** Working days in this run (the brief's "day N of total"). */
  totalDays: number;
}): AgentDriver {
  const notes = new Map<string, string>(cohort.members.map(m => [m.persona.key, ""]));
  const pastDays: string[] = [];
  const vars = {
    run: cohort.run,
    cohortDepartment: cohort.departmentName,
    platformDepartment: `${cohort.departmentName} Platform`,
  };

  function recent(member: CohortMember, today: string): string[] {
    const days = new Set(pastDays.filter(d => d < today).slice(-RECENT_WORKING_DAYS));
    return timeline.events()
      .filter(e => e.actor === member.persona.name && e.day !== null && days.has(e.day) && (e.kind === "action" || e.kind === "refusal"))
      .slice(-RECENT_MAX_EVENTS)
      .map(e => `${e.day} ${dhakaClock(e.at)} ${e.kind === "refusal" ? "REFUSED " : ""}${e.text}`);
  }

  return {
    beginDay(day: SimDay) {
      deps.clock.set(day.date, "08:30");
    },

    async act(member, day, position): Promise<DriverStep[]> {
      if (!pastDays.includes(day.date)) pastDays.push(day.date);
      deps.clock.set(day.date, startTime(member, position));
      const { persona } = member;
      if (!member.tools) {
        return [{ at: deps.clock.now(), kind: "refusal", text: "This persona has no tool stores, so it cannot act.", detail: { source: "driver" } }];
      }
      const brief = dailyBrief({
        date: day.date, index: day.index, total: totalDays,
        events: eventsFor(persona.key, day.index, day.date, vars),
        recent: recent(member, day.date),
        notes: notes.get(persona.key) ?? "",
      });
      const model = persona.role === "staff" ? settings.staffModel : settings.managerModel;
      const result = await runPersonaDay({
        client, model, settings, persona, brief,
        notes: notes.get(persona.key) ?? "",
        ctx: { member, stores: member.tools, clock: deps.clock, timeline, serviceAudit: deps.serviceAudit },
        onUsage: (responseModel, usage) => cost.add(responseModel, usage),
      });
      notes.set(persona.key, result.notes);
      return result.steps;
    },

    notes: () => Object.fromEntries(notes),

    writeRunFiles(dir, result) {
      mkdirSync(dir, { recursive: true });
      const notesFile = Object.fromEntries(cohort.members.map(m => [m.persona.key, { name: m.persona.name, role: m.persona.role, notes: notes.get(m.persona.key) ?? "" }]));
      writeFileSync(join(dir, "notes.json"), `${JSON.stringify({ run: result.run, personas: notesFile }, null, 2)}\n`);
      const perModel = cost.perModel();
      const costFile = {
        run: result.run,
        maxUsd: settings.maxUsd,
        spentUsd: cost.spent(),
        days: result.days.length,
        dayCostsUsd: cost.days(),
        models: { manager: settings.managerModel, staff: settings.staffModel },
        perModel: Object.fromEntries(Object.entries(perModel).map(([model, s]) => [model, {
          requests: s.requests,
          inputTokens: s.tokens.input, outputTokens: s.tokens.output,
          cacheReadTokens: s.tokens.cacheRead, cacheWriteTokens: s.tokens.cacheWrite,
          usd: s.usd,
        }])),
        stopReason: result.stopReason,
      };
      writeFileSync(join(dir, "cost.json"), `${JSON.stringify(costFile, null, 2)}\n`);
    },
  };
}
