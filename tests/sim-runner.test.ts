import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCalendar, toCalendarPolicy } from "@/domain/holiday-calendar";
import { dhakaInstant, simulatedCalendar } from "../sim/calendar";
import { simRetire, simRun } from "../sim/cli";
import { provisionCohort } from "../sim/cohort";
import { AttendanceUnavailableError } from "@/server/attendance-store";
import { createDryRunDriver, type SimDriver } from "../sim/dry-run-driver";
import { loadSimEnv } from "../sim/env";
import { PERSONAS } from "../sim/personas";
import { runSimulation } from "../sim/runner";
import { createTimeline, type TimelineEvent } from "../sim/timeline";
import { createSimClock } from "../sim/tools/clock";
import { createMemoryAttendanceStore } from "./support/memory-attendance-store";
import { fakeProvisionDeps, fakeRetireDeps } from "./support/sim-fakes";
import { fakeToolContext } from "./support/sim-tool-fakes";

const root = join(import.meta.dirname, "..");
const csv = readFileSync(join(root, "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const policy = toCalendarPolicy(buildCalendar([{ name: "bangladesh-2026.csv", text: csv }]));
const calendar = simulatedCalendar(policy);

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-runner-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readJsonl = (dir: string): TimelineEvent[] =>
  readFileSync(join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

describe("runSimulation with the dry-run driver (Story 9.1)", () => {
  it("steps 37 working days, records the 3 holidays and writes one narrated line per event", async () => {
    const { deps, attendance } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const dir = join(tempDir(), cohort.run);
    const result = await runSimulation({ cohort, driver: createDryRunDriver(), calendar, timeline: createTimeline(dir) });

    expect(result.days).toEqual(calendar.workingDays);
    expect(result.days).toHaveLength(37);
    expect(result.holidays).toEqual(["2026-08-05", "2026-08-26", "2026-09-04"]);
    expect(result.refusals).toBe(0);

    const events = readJsonl(dir);
    expect(events[0].kind).toBe("provisioned");
    expect(events.at(-1)!.kind).toBe("end");
    expect(events.filter(e => e.kind === "day")).toHaveLength(37);
    expect(events.filter(e => e.kind === "holiday").map(e => e.day)).toEqual(["2026-08-05", "2026-08-26", "2026-09-04"]);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
    // 8 staff x 3 steps + manager + admin per day.
    expect(events.filter(e => e.kind === "action")).toHaveLength(37 * 26);
    expect(readFileSync(join(dir, "timeline.md"), "utf8").trim().split("\n")).toHaveLength(events.length);
    // No password or key in the timeline.
    expect(readFileSync(join(dir, "timeline.jsonl"), "utf8")).not.toMatch(/password|Sim-[A-Za-z0-9_-]{20,}/i);

    // Staff first, then the manager, then the Administrator, on each day.
    const firstDay = events.filter(e => e.day === "2026-08-03" && e.kind === "action").map(e => e.actor);
    const staff = PERSONAS.filter(p => p.role === "staff").map(p => p.name);
    expect(firstDay.slice(0, 24).every(a => staff.includes(a))).toBe(true);
    expect(firstDay.slice(24)).toEqual([PERSONAS[1].name, PERSONAS[0].name]);

    // Attendance carries the simulated dates and instants.
    const trainee = cohort.members.find(m => m.persona.key === "trainee")!;
    const entries = await attendance.listForEmployee(trainee.employeeId!);
    expect(entries.map(e => e.date).sort()).toEqual(calendar.workingDays);
    const first = entries.find(e => e.date === "2026-08-03")!;
    expect(first.clockIn).toBe(dhakaInstant("2026-08-03", "09:00").toISOString());
    expect(first.clockOut).toBe(dhakaInstant("2026-08-03", "18:00").toISOString());
    expect(first.log?.summary).toMatch(/2026-08-03/);
    const senior = await attendance.listForEmployee(cohort.members.find(m => m.persona.key === "senior")!.employeeId!);
    expect(senior[0].clockIn.slice(11, 16)).toBe("03:05"); // 09:05 in Dhaka: staff position 1.
  });

  it("stops after maxDays working days", async () => {
    const { deps } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const dir = tempDir();
    const result = await runSimulation({ cohort, driver: createDryRunDriver(), calendar, timeline: createTimeline(dir), maxDays: 3 });
    expect(result.days).toEqual(["2026-08-03", "2026-08-04", "2026-08-06"]);
    expect(result.holidays).toEqual(["2026-08-05"]);
    expect(readJsonl(dir).filter(e => e.kind === "day")).toHaveLength(3);
  });

  it("turns a refused action into a refusal event carrying the app's message, and carries on", async () => {
    const { deps } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const dryRun = createDryRunDriver();
    // Acts twice on the same day: the second clock-in is refused by the app's own rule.
    const twice: SimDriver = { act: async (member, day, position) => [...await dryRun.act(member, day, position), ...await dryRun.act(member, day, position)] };
    const dir = tempDir();
    const result = await runSimulation({ cohort, driver: twice, calendar, timeline: createTimeline(dir), maxDays: 2 });
    const refusals = readJsonl(dir).filter(e => e.kind === "refusal");
    expect(result.refusals).toBe(refusals.length);
    expect(refusals.length).toBe(2 * 8); // per day and staff: the second clock-in, which ends that persona's day
    expect(new Set(refusals.map(r => r.text))).toEqual(new Set(["Today's attendance is already recorded."]));
    expect(refusals[0].detail).toMatchObject({ command: "clockIn", error: "TimesheetValidationError" });
    expect(result.days).toHaveLength(2);
    expect(readJsonl(dir).at(-1)!.kind).toBe("end");
  });

  it("skips the log and clock-out when the clock-in is refused, recording one refusal", async () => {
    const store = createMemoryAttendanceStore();
    const refusing = { ...store, save: async () => { throw new AttendanceUnavailableError({ cause: { code: "42501", message: "rls" } }); } };
    const { deps } = fakeProvisionDeps({ attendance: refusing });
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const trainee = cohort.members.find(m => m.persona.key === "trainee")!;
    const steps = await createDryRunDriver().act(trainee, { date: "2026-08-03", index: 0 }, 0);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "refusal", text: "Attendance records are temporarily unavailable.", detail: { command: "clockIn", cause: "42501 rls" } });
  });

  it("records a driver that throws as a refusal instead of crashing", async () => {
    const { deps } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const dir = tempDir();
    const broken: SimDriver = { act: async () => { throw new Error("boom"); } };
    const result = await runSimulation({ cohort, driver: broken, calendar, timeline: createTimeline(dir), maxDays: 1 });
    expect(result.refusals).toBe(10);
    expect(readJsonl(dir).filter(e => e.kind === "refusal").every(e => e.text === "boom")).toBe(true);
  });
});

describe("sim:run and sim:retire commands (Story 9.1)", () => {
  const quiet = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, out: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) } };
  };

  it.each(["abc", "0", "-3"])("exits 2 on SIM_MAX_USD=%s and provisions nothing (Story 9.3)", async budget => {
    const { errors, out } = quiet();
    const loadDeps = vi.fn();
    const createClient = vi.fn();
    expect(await simRun([], { loadDeps, out, env: { SIM_MAX_USD: budget }, createClient })).toBe(2);
    expect(errors).toEqual([expect.stringMatching(/^SIM_MAX_USD must be a positive number/)]);
    expect(loadDeps).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("exits 2 on another bad SIM_* setting (Story 9.3)", async () => {
    const { errors, out } = quiet();
    const loadDeps = vi.fn();
    expect(await simRun([], { loadDeps, out, env: { SIM_EFFORT: "extreme" } })).toBe(2);
    expect(errors[0]).toMatch(/^SIM_EFFORT must be one of/);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("runs a real run with a fake-fetch client, writing the timeline, cost.json and notes.json (Story 9.3)", async () => {
    const { lines, errors, out } = quiet();
    const { deps } = fakeProvisionDeps();
    const { stores, serviceAudit } = fakeToolContext("staff");
    const outputRoot = tempDir();
    const requests: { model: string }[] = [];
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return new Response(JSON.stringify({
        id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "A quiet day.\nNOTES: all good" }], stop_reason: "end_turn", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const loadDeps = () => ({
      ...deps,
      signIn: async (email: string, password: string) => ({ ...await deps.signIn(email, password), tools: stores }),
      activeCalendar: async () => ({ policy }),
      clock: createSimClock("2026-08-03"),
      serviceAudit,
    });
    const code = await simRun(["--days", "2"], {
      loadDeps, out, outputRoot, env: { SIM_MAX_USD: "5" },
      createClient: () => new Anthropic({ apiKey: "test", fetch: fakeFetch, maxRetries: 0 }),
    });
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(requests).toHaveLength(20);
    const dir = join(outputRoot, "c00ab12");
    expect(readJsonl(dir).filter(e => e.kind === "day")).toHaveLength(2);
    const cost = JSON.parse(readFileSync(join(dir, "cost.json"), "utf8"));
    expect(cost).toMatchObject({ run: "c00ab12", maxUsd: 5, days: 2, stopReason: { kind: "max-days" } });
    expect(cost.perModel["claude-haiku-5-5"].requests).toBe(16);
    expect(cost.perModel["claude-opus-5-5"].requests).toBe(4);
    expect(cost.spentUsd).toBeCloseTo(16 * (1000 * 0.1 + 100 * 0.5) / 1e6 + 4 * (1000 * 4 + 100 * 20) / 1e6, 10);
    const notes = JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"));
    expect(Object.keys(notes.personas)).toHaveLength(10);
    expect(notes.personas.trainee.notes).toBe("all good");
    const printed = lines.join("\n");
    expect(printed).toContain("c00ab12");
    expect(printed).toMatch(/spent \$0\.03 of \$5\.00/);
    expect(printed).not.toMatch(/Sim-[A-Za-z0-9_-]{20,}/);
  });

  it("exits non-zero and provisions nothing without an active calendar", async () => {
    const { errors, out } = quiet();
    const { deps, calls } = fakeProvisionDeps();
    const code = await simRun(["--dry-run"], { loadDeps: () => ({ ...deps, activeCalendar: async () => null }), out, outputRoot: tempDir() });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/^No active holiday calendar/);
    expect(calls).toEqual([]);
  });

  it("stops before provisioning when the calendar does not cover the year", async () => {
    const { errors, out } = quiet();
    const { deps, calls } = fakeProvisionDeps();
    const old = { holidays: new Set<string>(), supportedYearStart: 2025, supportedYearEnd: 2025 };
    expect(await simRun(["--dry-run"], { loadDeps: () => ({ ...deps, activeCalendar: async () => ({ policy: old }) }), out, outputRoot: tempDir() })).toBe(1);
    expect(errors[0]).toMatch(/covers 2025-2025/);
    expect(calls).toEqual([]);
  });

  it("runs the dry run end to end, writing both timeline files, without reading ANTHROPIC_API_KEY", async () => {
    const { lines, errors, out } = quiet();
    const { deps } = fakeProvisionDeps();
    const outputRoot = tempDir();
    const reads: string[] = [];
    const env = process.env;
    process.env = new Proxy(env, {
      get(target, key, receiver) {
        if (typeof key === "string" && key.startsWith("ANTHROPIC")) reads.push(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        if (typeof key === "string" && key.startsWith("ANTHROPIC")) reads.push(key);
        return Reflect.has(target, key);
      },
    });
    let code: number;
    try {
      code = await simRun(["--dry-run", "--days", "2"], { loadDeps: () => ({ ...deps, activeCalendar: async () => ({ policy }) }), out, outputRoot });
    } finally {
      process.env = env;
    }
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(reads).toEqual([]);
    const [run] = readdirSync(outputRoot);
    expect(run).toBe("c00ab12");
    expect(statSync(join(outputRoot, run, "timeline.md")).size).toBeGreaterThan(0);
    expect(readJsonl(join(outputRoot, run)).filter(e => e.kind === "day")).toHaveLength(2);
    expect(lines.join("\n")).toContain("c00ab12");
    expect(lines.join("\n")).toContain(join(outputRoot, run, "timeline.md"));
  });

  it("says how many steps the app refused, still exiting 0", async () => {
    const { lines, out } = quiet();
    const refusing = { ...createMemoryAttendanceStore(), save: async () => { throw new AttendanceUnavailableError(); } };
    const { deps } = fakeProvisionDeps({ attendance: refusing });
    const outputRoot = tempDir();
    const code = await simRun(["--dry-run", "--days", "2"], { loadDeps: () => ({ ...deps, activeCalendar: async () => ({ policy }) }), out, outputRoot });
    expect(code).toBe(0);
    expect(lines).toContain(`The app refused 16 steps; the reasons are in ${join(outputRoot, "c00ab12", "timeline.md")}.`);
  });

  it("names the partly provisioned cohort and the failed step when provisioning fails", async () => {
    const { errors, out } = quiet();
    const { deps } = fakeProvisionDeps();
    const failing = {
      ...deps,
      signIn: async (email: string, password: string) => {
        if (email.includes("-trainee@")) throw new Error("Sign-in refused.");
        return deps.signIn(email, password);
      },
      activeCalendar: async () => ({ policy }),
    };
    expect(await simRun(["--dry-run"], { loadDeps: () => failing, out, outputRoot: tempDir() })).toBe(1);
    expect(errors).toEqual(["Cohort c00ab12 is partly provisioned: the sign-in of trainee failed: Sign-in refused. Nothing was rolled back."]);
  });

  it("rejects unknown options", async () => {
    const { out } = quiet();
    expect(await simRun(["--dry-run", "--days", "zero"], { loadDeps: vi.fn(), out })).toBe(2);
    expect(await simRetire(["--everything"], { loadDeps: vi.fn(), out })).toBe(2);
  });

  it("retires earlier cohorts by default and every cohort with --all", async () => {
    const employees = [
      { employeeId: "BS-2000", summary: "Simulation cohort c00aaaa. A.", archived: false },
      { employeeId: "BS-2010", summary: "Simulation cohort c01bbbb. B.", archived: false },
    ];
    const users = [{ id: "aaaa0000-0000-4000-8000-000000000000", email: "sim-c00aaaa-admin@example.com" }, { id: "aaaa0000-0000-4000-8000-000000000001", email: "sim-c01bbbb-admin@example.com" }];
    const first = fakeRetireDeps(employees, users);
    expect(await simRetire([], { loadDeps: () => first.deps, out: quiet().out })).toBe(0);
    expect(first.archived.map(a => a.employeeId)).toEqual(["BS-2000"]);
    const all = fakeRetireDeps(employees, users);
    expect(await simRetire(["--all"], { loadDeps: () => all.deps, out: quiet().out })).toBe(0);
    expect(all.archived.map(a => a.employeeId)).toEqual(["BS-2000", "BS-2010"]);
  });

  it("reports skipped cohorts (exit 0) and failed archives (exit 1), never 'No earlier cohort'", async () => {
    const employees = [
      { employeeId: "BS-2000", summary: "Simulation cohort c00aaaa. A.", archived: false },
      { employeeId: "BS-2001", summary: "Simulation cohort c00aaaa. B.", archived: false },
      { employeeId: "BS-2010", summary: "Simulation cohort c01bbbb. C.", archived: false },
    ];
    const users = [{ id: "aaaa0000-0000-4000-8000-000000000000", email: "sim-c00aaaa-admin@example.com" }];
    const skipped = quiet();
    expect(await simRetire(["--all"], { loadDeps: () => fakeRetireDeps(employees, users).deps, out: skipped.out })).toBe(0);
    expect(skipped.lines).toContain("Skipped 1 cohort whose Administrator account was not found.");
    expect(skipped.lines).not.toContain("No earlier cohort to retire.");

    const failed = quiet();
    const onlySkipped = employees.filter(e => e.employeeId === "BS-2010");
    expect(await simRetire(["--all"], { loadDeps: () => fakeRetireDeps(onlySkipped, users).deps, out: failed.out })).toBe(0);
    expect(failed.lines).toEqual(["Skipped 1 cohort whose Administrator account was not found."]);

    const failing = quiet();
    const deps = fakeRetireDeps(employees, users, ["BS-2000"]);
    expect(await simRetire(["--all"], { loadDeps: () => deps.deps, out: failing.out })).toBe(1);
    expect(failing.lines).toContain("Could not archive 1 employee; see the warnings above.");
    expect(failing.lines).not.toContain("No earlier cohort to retire.");
    expect(deps.archived.map(a => a.employeeId)).toEqual(["BS-2001"]);
  });
});

describe("loadSimEnv (Story 9.1)", () => {
  it("loads the env file into the env object it checks, keeping existing values", () => {
    const file = join(tempDir(), ".env.local");
    writeFileSync(file, "NEXT_PUBLIC_SUPABASE_URL=https://file.example\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon-from-file\n");
    const env: Record<string, string | undefined> = { SUPABASE_SERVICE_ROLE_KEY: "service", NEXT_PUBLIC_SUPABASE_URL: "https://env.example" };
    expect(loadSimEnv(env, file)).toEqual({ url: "https://env.example", anonKey: "anon-from-file", serviceKey: "service" });
    expect(() => loadSimEnv({}, join(tempDir(), "missing"))).toThrow(/^Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("simulator boundaries (Story 9.1)", () => {
  const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);

  it("imports the Anthropic SDK only in the tool adapter and the agents, and never reads the API key (Stories 9.2-9.3)", () => {
    const adapter = join(root, "sim", "tools", "anthropic.ts");
    const agents = join(root, "sim", "agents");
    for (const file of [...filesUnder(join(root, "sim")), ...filesUnder(join(root, "scripts", "sim"))]) {
      const text = readFileSync(file, "utf8");
      if (file !== adapter && !file.startsWith(`${agents}/`)) expect(text, file).not.toMatch(/@anthropic-ai/);
      expect(text, file).not.toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it("loads the agents from the CLI only with a dynamic import (Story 9.3)", () => {
    const cli = readFileSync(join(root, "sim", "cli.ts"), "utf8");
    // No runtime (non-type) static import or re-export of ./agents.
    expect(cli).not.toMatch(/^\s*(import|export)\s+(?!type\b)[^;]*from\s+["']\.\/agents/m);
    expect(cli).not.toMatch(/^\s*import\s+["']\.\/agents/m);
    expect(cli).toMatch(/import\("\.\/agents\/index"\)/);
  });

  it("keeps the dry-run modules free of the tool adapter (Story 9.2)", () => {
    for (const name of ["cli.ts", "runner.ts", "dry-run-driver.ts", "cohort.ts", "env.ts"]) {
      expect(readFileSync(join(root, "sim", name), "utf8"), name).not.toMatch(/tools\/anthropic/);
    }
  });

  it("is never imported by the web app", () => {
    for (const file of [...filesUnder(join(root, "src", "app")), ...filesUnder(join(root, "src", "components"))]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*\bsim\//);
    }
  });
});
