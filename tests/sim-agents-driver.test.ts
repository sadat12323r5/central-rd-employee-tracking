import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCalendar, toCalendarPolicy } from "@/domain/holiday-calendar";
import { budgetHooks, createCostTracker } from "../sim/agents/cost";
import { createAgentDriver } from "../sim/agents/driver";
import { parseAgentSettings } from "../sim/agents/settings";
import { dhakaClock, simulatedCalendar } from "../sim/calendar";
import { provisionCohort } from "../sim/cohort";
import { PERSONAS } from "../sim/personas";
import { runSimulation } from "../sim/runner";
import { createTimeline, type TimelineEvent } from "../sim/timeline";
import { createSimClock } from "../sim/tools/clock";
import { fakeModel, text, toolUse, type FakeReply } from "./support/sim-agent-fakes";
import { fakeProvisionDeps } from "./support/sim-fakes";
import { fakeToolContext } from "./support/sim-tool-fakes";

// Story 9.3: the agent driver under runSimulation with a scripted fake model and fake stores: the clock per
// persona, staff first, notes and briefs across days, the budget stop at a day boundary, the mid-day guard
// and the run files. No database, no real model call.

const csv = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const calendar = simulatedCalendar(toCalendarPolicy(buildCalendar([{ name: "bangladesh-2026.csv", text: csv }])));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const personaOf = (body: Record<string, any>) => PERSONAS.find(p => (body.system[0].text as string).startsWith(`You are ${p.name},`))!;

async function setup(script: (body: Record<string, any>, n: number) => FakeReply, env: Record<string, string> = {}) {
  const { deps, attendance } = fakeProvisionDeps();
  const fake = fakeToolContext("staff");
  const signedIn = { ...deps, signIn: async (email: string, password: string) => ({ ...await deps.signIn(email, password), tools: fake.stores }) };
  const cohort = await provisionCohort(signedIn, { personas: PERSONAS });
  const clock = createSimClock("2026-08-03");
  const seen: { persona: string; at: string; model: string; brief: string }[] = [];
  const model = fakeModel((body, n) => {
    seen.push({ persona: personaOf(body).key, at: clock.now().toISOString(), model: body.model, brief: body.messages[0].content });
    return script(body, n);
  });
  const dir = mkdtempSync(join(tmpdir(), "sim-agents-"));
  dirs.push(dir);
  const timeline = createTimeline(dir);
  const settings = parseAgentSettings(env);
  const cost = createCostTracker({ dayEstimateUsd: settings.dayEstimateUsd, warn: vi.fn() });
  const driver = createAgentDriver({
    client: model.client, deps: { clock, serviceAudit: fake.serviceAudit }, cohort, settings, cost, timeline, totalDays: calendar.workingDays.length,
  });
  const run = (maxDays?: number) => runSimulation({ cohort, driver, calendar, timeline, maxDays, budget: budgetHooks(cost, settings.maxUsd) });
  return { cohort, clock, model, seen, dir, timeline, driver, cost, settings, run, attendance };
}

const readJsonl = (dir: string): TimelineEvent[] => readFileSync(join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const ends = (notes: string) => ({ content: [text(`Done.\nNOTES: ${notes}`)], stop_reason: "end_turn" });
/** A reply costing `usd` on Opus (output tokens only) or nothing on Haiku. */
const priced = (body: Record<string, any>, opusUsd: number, notes = "ok"): FakeReply => ({
  ...ends(notes),
  usage: body.model === "claude-opus-5-5" ? { input_tokens: 0, output_tokens: Math.round(opusUsd * 1e6 / 20) } : { input_tokens: 0, output_tokens: 0 },
});

describe("createAgentDriver (Story 9.3)", () => {
  it("acts staff first, then the manager, then the Administrator, each at its own start time and model", async () => {
    const { seen, run } = await setup(() => ends("ok"));
    await run(1);
    expect(seen.map(s => s.persona)).toEqual([...PERSONAS.filter(p => p.role === "staff").map(p => p.key), "manager", "admin"]);
    expect(seen.map(s => dhakaClock(s.at))).toEqual(["09:00", "09:05", "09:10", "09:15", "09:20", "09:25", "09:30", "09:35", "16:30", "17:00"]);
    expect(seen.every(s => s.at.startsWith("2026-08-0"))).toBe(true);
    expect(seen.map(s => s.model)).toEqual([...Array(8).fill("claude-haiku-5-5"), "claude-opus-5-5", "claude-opus-5-5"]);
  });

  it("runs tools at the persona's simulated time and records them once", async () => {
    const { run, dir, attendance, cohort } = await setup((body, n) => personaOf(body).key === "trainee" && n === 1
      ? { content: [toolUse("toolu_1", "clock_in", { workMode: "Office" })], stop_reason: "tool_use" }
      : ends("ok"));
    const result = await run(1);
    // Through the trainee's own attendance commands, at 09:00 Dhaka on the simulated day.
    const entries = await attendance.listForEmployee(cohort.members.find(m => m.persona.key === "trainee")!.employeeId!);
    expect(entries).toEqual([expect.objectContaining({ date: "2026-08-03", clockIn: "2026-08-03T03:00:00.000Z" })]);
    const actions = readJsonl(dir).filter(e => e.kind === "action");
    expect(actions).toEqual([expect.objectContaining({ actor: PERSONAS.find(p => p.key === "trainee")!.name, day: "2026-08-03", detail: expect.objectContaining({ tool: "clock_in" }) })]);
    expect(result.actions).toBe(1);
  });

  it("carries compact notes and the persona's recent events into the next day's brief, never a transcript", async () => {
    const { seen, run, driver } = await setup((body, n) => {
      const key = personaOf(body).key;
      if (key === "trainee" && n === 1) return { content: [toolUse("toolu_1", "clock_in", { workMode: "Office" })], stop_reason: "tool_use" };
      return ends(`notes of ${key} on request ${n}`);
    });
    await run(2);
    const [monday, tuesday] = [seen.filter(s => s.persona === "trainee")[0], seen.filter(s => s.persona === "trainee").at(-1)!];
    expect(monday.brief).toContain("2026-08-03");
    expect(monday.brief).toContain("(none yet)");
    expect(tuesday.brief).toContain("2026-08-04");
    expect(tuesday.brief).toContain("notes of trainee on request 2");
    expect(tuesday.brief).toMatch(/2026-08-03 09:00 /);
    const managerMonday = seen.find(s => s.persona === "manager")!;
    expect(managerMonday.brief).toContain("Client project kickoff");
    expect(driver.notes().manager).toMatch(/^notes of manager/);
  });

  it("records a model refusal and carries on with the next persona", async () => {
    const { run, dir, seen } = await setup(body => personaOf(body).key === "senior"
      ? { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }
      : ends("ok"));
    const result = await run(1);
    expect(seen).toHaveLength(10);
    const refusals = readJsonl(dir).filter(e => e.kind === "refusal");
    expect(refusals).toEqual([expect.objectContaining({ actor: PERSONAS.find(p => p.key === "senior")!.name, detail: expect.objectContaining({ source: "model", stop_reason: "refusal" }) })]);
    expect(result.refusals).toBe(1);
  });

  it("stops at a day boundary when spent + the projected day would exceed SIM_MAX_USD, and writes cost.json and notes.json", async () => {
    // Each day costs $0.35 (the manager and the Administrator $0.175 each); the budget is $1.00.
    const { run, dir, seen, driver, cost } = await setup(body => priced(body, 0.175, `${personaOf(body).key} notes`), { SIM_MAX_USD: "1", SIM_DAY_ESTIMATE_USD: "0.4" });
    const result = await run();
    expect(result.days).toEqual(["2026-08-03", "2026-08-04"]);
    expect(seen).toHaveLength(20);
    expect(result.stopReason.kind).toBe("budget");
    expect(result.stopReason.message).toMatch(/^Stopped before 2026-08-06: spent \$0\.70 plus a projected \$0\.35 for one more day would exceed SIM_MAX_USD \(\$1\.00\)\.$/);
    const events = readJsonl(dir);
    expect(events.filter(e => e.kind === "day")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: "end", detail: { stopReason: "budget" } });
    expect(events.at(-1)!.text).toMatch(/exceed SIM_MAX_USD/);

    driver.writeRunFiles(dir, result);
    const costFile = JSON.parse(readFileSync(join(dir, "cost.json"), "utf8"));
    expect(costFile).toMatchObject({ run: result.run, maxUsd: 1, days: 2, stopReason: { kind: "budget" } });
    expect(costFile.spentUsd).toBeCloseTo(0.7, 6);
    expect(costFile.dayCostsUsd).toEqual([expect.closeTo(0.35, 6), expect.closeTo(0.35, 6)]);
    expect(costFile.perModel["claude-opus-5-5"]).toMatchObject({ requests: 4, inputTokens: 0, outputTokens: 4 * 8750, usd: expect.closeTo(0.7, 6) });
    expect(costFile.perModel["claude-haiku-5-5"]).toMatchObject({ requests: 16, usd: 0 });
    expect(cost.spent()).toBeCloseTo(0.7, 6);
    const notesFile = JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"));
    expect(notesFile.run).toBe(result.run);
    expect(notesFile.personas.manager).toEqual({ name: PERSONAS[1].name, role: "manager", notes: "manager notes" });
    expect(Object.keys(notesFile.personas).sort()).toEqual(PERSONAS.map(p => p.key).sort());
  });

  it("skips the rest of the day once spend reaches the budget mid-day (the hard guard)", async () => {
    const { run, dir, seen } = await setup(body => priced(body, 0.25), { SIM_MAX_USD: "0.2", SIM_DAY_ESTIMATE_USD: "0.01" });
    const result = await run();
    expect(seen.map(s => s.persona)).toEqual([...PERSONAS.filter(p => p.role === "staff").map(p => p.key), "manager"]);
    expect(result.days).toEqual(["2026-08-03"]);
    expect(result.stopReason).toEqual({ kind: "budget", message: expect.stringMatching(/^Stopped during 2026-08-03: spent \$0\.25 reached SIM_MAX_USD \(\$0\.20\)/) });
    const end = readJsonl(dir).at(-1)!;
    expect(end.kind).toBe("end");
    expect(end.text).toMatch(/Stopped during 2026-08-03/);
  });
});
