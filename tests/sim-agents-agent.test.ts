import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_ACTION_CAP_REACHED, parseNotes, runPersonaDay, SERVER_SIDE_FALLBACK_BETA } from "../sim/agents/agent";
import { NOTES_MAX } from "../sim/agents/brief";
import { parseAgentSettings } from "../sim/agents/settings";
import { toolsFor } from "../sim/tools/catalog";
import { fakeModel, text, toolUse, USAGE } from "./support/sim-agent-fakes";
import { fakeToolContext } from "./support/sim-tool-fakes";

// Story 9.3: one persona's day against a scripted fake model (fake fetch, no retries): the request shape,
// the action cap, stop reasons, API errors, notes and the cached prefix. No real model call.

afterEach(() => vi.restoreAllMocks());

type Role = "staff" | "manager" | "admin";

async function day(role: Role, model: ReturnType<typeof fakeModel>, {
  env = {} as Record<string, string>, brief = "Today is Monday 10 August 2026.", notes = "old notes",
} = {}) {
  const settings = parseAgentSettings(env);
  const fake = fakeToolContext(role);
  const usage: { model: string; usage: unknown }[] = [];
  const modelId = role === "staff" ? settings.staffModel : settings.managerModel;
  const result = await runPersonaDay({
    client: model.client, model: modelId, settings, persona: fake.ctx.member.persona, ctx: fake.ctx, brief, notes,
    onUsage: (m, u) => usage.push({ model: m, usage: u }),
  });
  return { ...fake, result, usage, settings };
}

describe("runPersonaDay (Story 9.3)", () => {
  it("runs a tool through runTool, takes the NOTES and reports every response's usage", async () => {
    const model = fakeModel((_, n) => n === 1
      ? { content: [text("Clocking in."), toolUse("toolu_1", "clock_in", { workMode: "Office" })], stop_reason: "tool_use" }
      : { content: [text("Logged in for the day.\nNOTES: x")], stop_reason: "end_turn" });
    const { result, calls, events, usage } = await day("staff", model);
    expect(calls.map(c => `${c.store}.${c.method}`)).toEqual(["attendance-commands.clockIn"]);
    expect(events).toEqual([expect.objectContaining({ kind: "action", detail: expect.objectContaining({ tool: "clock_in" }) })]);
    expect(result.steps).toEqual([expect.objectContaining({ kind: "action", recorded: true })]);
    expect(result.notes).toBe("x");
    expect(result.stop).toBeNull();
    expect(usage).toEqual([{ model: "claude-haiku-5-5", usage: expect.objectContaining(USAGE) }, { model: "claude-haiku-5-5", usage: expect.objectContaining(USAGE) }]);
    // The tool result went back to the model in the second request.
    expect(model.requests[1].body.messages.at(-1).content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_1" })]);
  });

  it.each([
    ["staff", "claude-haiku-5-5", false],
    ["manager", "claude-opus-5-5", true],
    ["admin", "claude-opus-5-5", true],
  ] as const)("sends %s requests to %s (fallbacks only on Opus), with auto tool choice, effort and bounded max_tokens", async (role, modelId, fallback) => {
    const model = fakeModel(() => ({ content: [text("NOTES: ok")], stop_reason: "end_turn" }));
    await day(role, model);
    const { body, headers } = model.requests[0];
    expect(body.model).toBe(modelId);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(4000);
    expect(body).not.toHaveProperty("thinking");
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(toolsFor(role).map(t => t.name));
    expect(body.tools.every((t: { strict?: boolean }) => t.strict === true)).toBe(true);
    if (fallback) {
      expect(body.fallbacks).toBe("default");
      expect(headers.get("anthropic-beta")).toContain(SERVER_SIDE_FALLBACK_BETA);
    } else {
      expect(body).not.toHaveProperty("fallbacks");
      expect(headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    }
  });

  it("honours the model, effort and max_tokens overrides (fallbacks follow the model id)", async () => {
    const env = { SIM_STAFF_MODEL: "claude-fable-5", SIM_MANAGER_MODEL: "claude-sonnet-5-5", SIM_EFFORT: "low", SIM_MAX_TOKENS: "99999" };
    const staff = fakeModel(() => ({ content: [text("NOTES: ok")], stop_reason: "end_turn" }));
    await day("staff", staff, { env });
    expect(staff.requests[0].body).toMatchObject({ model: "claude-fable-5", fallbacks: "default", output_config: { effort: "low" }, max_tokens: 16000 });
    const manager = fakeModel(() => ({ content: [text("NOTES: ok")], stop_reason: "end_turn" }));
    await day("manager", manager, { env });
    expect(manager.requests[0].body.model).toBe("claude-sonnet-5-5");
    expect(manager.requests[0].body).not.toHaveProperty("fallbacks");
  });

  it("refuses calls past the daily cap with DailyActionCapReached: the store runs only 6 times", async () => {
    const model = fakeModel((_, n) => n === 1
      ? { content: Array.from({ length: 8 }, (_, i) => toolUse(`toolu_${i + 1}`, "clock_in", { workMode: "Office" })), stop_reason: "tool_use" }
      : { content: [text("NOTES: capped")], stop_reason: "end_turn" });
    const { result, calls, events } = await day("staff", model);
    expect(calls).toHaveLength(6);
    expect(events.map(e => e.kind)).toEqual([...Array(6).fill("action"), "refusal", "refusal"]);
    expect(events.slice(6).map(e => e.detail?.error)).toEqual([DAILY_ACTION_CAP_REACHED, DAILY_ACTION_CAP_REACHED]);
    expect(result.steps.filter(s => s.kind === "refusal")).toHaveLength(2);
    expect(result.steps.every(s => s.recorded)).toBe(true);
    const results = model.requests[1].body.messages.at(-1).content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results.slice(6)).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_7", is_error: true, content: expect.stringMatching(/^DailyActionCapReached: /) }),
      expect.objectContaining({ tool_use_id: "toolu_8", is_error: true }),
    ]);
  });

  it("stops after cap + 2 requests when the model keeps calling tools", async () => {
    const model = fakeModel((_, n) => ({ content: [toolUse(`toolu_${n}`, "clock_in", { workMode: "Office" })], stop_reason: "tool_use" }));
    const { result, calls } = await day("staff", model, { env: { SIM_MAX_ACTIONS_PER_DAY: "3" } });
    expect(model.requests).toHaveLength(5);
    expect(calls).toHaveLength(3);
    expect(result.notes).toBe("old notes");
  });

  it.each(["refusal", "max_tokens"])("ends the day on a %s stop with one model refusal step, keeping the notes", async stop => {
    const details = stop === "refusal" ? { type: "refusal", category: "general_harms", explanation: null } : undefined;
    const model = fakeModel(() => ({ content: [text("NOTES: should not be used")], stop_reason: stop, stop_details: details }));
    const { result } = await day("manager", model);
    expect(result.stop).toBe(stop);
    expect(result.notes).toBe("old notes");
    expect(result.steps).toEqual([expect.objectContaining({
      kind: "refusal", detail: expect.objectContaining({ source: "model", stop_reason: stop, ...(details ? { stop_details: details } : {}) }),
    })]);
    expect(result.steps[0].recorded).toBeFalsy();
    if (!details) expect(result.steps[0].detail).not.toHaveProperty("stop_details");
  });

  it("turns an API error into a model refusal step instead of throwing", async () => {
    const model = fakeModel(() => ({ status: 500 }));
    const { result } = await day("staff", model);
    expect(result.stop).toBe("error");
    expect(result.notes).toBe("old notes");
    expect(result.steps).toEqual([expect.objectContaining({
      kind: "refusal", detail: expect.objectContaining({ source: "model", error: "InternalServerError", status: 500 }),
    })]);
  });

  it("keeps the old notes when the reply has no NOTES line", async () => {
    const model = fakeModel(() => ({ content: [text("Nothing to do today.")], stop_reason: "end_turn" }));
    expect((await day("staff", model)).result.notes).toBe("old notes");
  });

  it("caches a stable prefix: the same system and tools every day, the cache breakpoint last, per-day text only in the user message", async () => {
    const model = fakeModel(() => ({ content: [text("NOTES: ok")], stop_reason: "end_turn" }));
    await day("manager", model, { brief: "Today is Monday 10 August 2026." });
    await day("manager", model, { brief: "Today is Tuesday 11 August 2026." });
    const [a, b] = model.requests.map(r => r.body);
    expect(a.system).toEqual(b.system);
    expect(a.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(a.system)).not.toMatch(/\d{4}-\d{2}-\d{2}|August|c00ab12/);
    expect(a.tools).toEqual(b.tools);
    expect(a.messages).toEqual([{ role: "user", content: "Today is Monday 10 August 2026." }]);
    expect(b.messages).toEqual([{ role: "user", content: "Today is Tuesday 11 August 2026." }]);
  });
});

describe("parseNotes (Story 9.3)", () => {
  it("takes the text after the last NOTES: line, trimmed and capped", () => {
    expect(parseNotes("Did things.\nNOTES: a\nb")).toBe("a\nb");
    expect(parseNotes("NOTES: first\nmore\nNOTES: second")).toBe("second");
    expect(parseNotes("no notes here")).toBeNull();
    expect(parseNotes("NOTES:   ")).toBeNull();
    expect(parseNotes(`NOTES: ${"x".repeat(2000)}`)).toHaveLength(NOTES_MAX);
  });
});
