import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_ACTION_CAP_REACHED, parseNotes, preflightModels, runPersonaDay, SERVER_SIDE_FALLBACK_BETA } from "../sim/agents/agent";
import { SimFatalError } from "../sim/errors";
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
  overBudget = undefined as (() => string | null) | undefined,
} = {}) {
  const settings = parseAgentSettings(env);
  const fake = fakeToolContext(role);
  const usage: { model: string; usage: unknown }[] = [];
  const modelId = role === "staff" ? settings.staffModel : settings.managerModel;
  const result = await runPersonaDay({
    client: model.client, model: modelId, settings, persona: fake.ctx.member.persona, ctx: fake.ctx, brief, notes,
    onUsage: (m, u) => usage.push({ model: m, usage: u }), overBudget,
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
    // Stopping at max_iterations mid-tool-use is recorded as a model refusal.
    expect(result.stop).toBe("tool_use");
    expect(result.steps.at(-1)).toMatchObject({ kind: "refusal", detail: { source: "model", stop_reason: "tool_use" } });
    expect(result.steps.at(-1)!.recorded).toBeFalsy();
  });

  it("records a model_context_window_exceeded stop as a model refusal", async () => {
    const model = fakeModel(() => ({ content: [text("NOTES: no")], stop_reason: "model_context_window_exceeded" }));
    const { result } = await day("staff", model);
    expect(result).toMatchObject({ stop: "model_context_window_exceeded", notes: "old notes" });
    expect(result.steps).toEqual([expect.objectContaining({ kind: "refusal", detail: expect.objectContaining({ stop_reason: "model_context_window_exceeded" }) })]);
  });

  it("cuts the day off as soon as the budget is reached: no further requests or tool calls", async () => {
    // The model would ask for a tool on every one of 5 requests; the budget is reached after the second.
    const model = fakeModel((_, n) => ({ content: [toolUse(`toolu_${n}`, "clock_in", { workMode: "Office" })], stop_reason: "tool_use" }));
    let responses = 0;
    const { result, calls } = await day("staff", model, {
      env: { SIM_MAX_ACTIONS_PER_DAY: "3" },
      overBudget: () => (++responses >= 2 ? "spent $1.00 reached SIM_MAX_USD ($1.00)." : null),
    });
    expect(model.requests).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(result.stop).toBe("budget");
    expect(result.steps.at(-1)).toMatchObject({ kind: "refusal", detail: { source: "model", reason: "budget" } });
    expect(result.steps.at(-1)!.text).toMatch(/reached SIM_MAX_USD/);
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

  it.each([
    [401, "AuthenticationError"], [403, "PermissionDeniedError"], [404, "NotFoundError"], [400, "BadRequestError"],
  ])("rethrows a fatal %s API error as SimFatalError so the run stops", async (status, name) => {
    const model = fakeModel(() => ({ status }));
    const settings = parseAgentSettings({});
    const { ctx } = fakeToolContext("staff");
    const run = runPersonaDay({ client: model.client, model: "claude-haiku-5-5", settings, persona: ctx.member.persona, ctx, brief: "b", notes: "", onUsage: () => {} });
    await expect(run).rejects.toBeInstanceOf(SimFatalError);
    await expect(run).rejects.toMatchObject({ cause: expect.objectContaining({ constructor: expect.objectContaining({ name }) }) });
  });

  it.each([429, 529])("keeps a transient %s API error a per-persona refusal", async status => {
    const { result } = await day("staff", fakeModel(() => ({ status })));
    expect(result.stop).toBe("error");
    expect(result.steps).toEqual([expect.objectContaining({ kind: "refusal", detail: expect.objectContaining({ source: "model", status }) })]);
  });

  it("keeps a connection error a per-persona refusal", async () => {
    const settings = parseAgentSettings({});
    const { ctx } = fakeToolContext("staff");
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async () => { throw new TypeError("fetch failed"); } });
    const result = await runPersonaDay({ client, model: "claude-haiku-5-5", settings, persona: ctx.member.persona, ctx, brief: "b", notes: "kept", onUsage: () => {} });
    expect(result).toMatchObject({ stop: "error", notes: "kept" });
    expect(result.steps[0].detail).toMatchObject({ source: "model", error: "APIConnectionError" });
  });

  it("only takes NOTES from the final reply", async () => {
    const model = fakeModel((_, n) => n === 1
      ? { content: [text("NOTES: early"), toolUse("toolu_1", "clock_in", { workMode: "Office" })], stop_reason: "tool_use" }
      : { content: [text("Done for today.")], stop_reason: "end_turn" });
    expect((await day("staff", model)).result.notes).toBe("old notes");
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

describe("preflightModels (Story 9.3)", () => {
  it("checks each distinct model once and passes when all exist", async () => {
    const model = fakeModel(() => ({ content: [], stop_reason: "end_turn" }));
    expect(await preflightModels(model.client, ["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5-5"])).toBeNull();
    expect(model.modelChecks).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("names an unknown model", async () => {
    const model = fakeModel(() => ({ content: [], stop_reason: "end_turn" }), { models: id => (id === "claude-nope" ? 404 : 200) });
    expect(await preflightModels(model.client, ["claude-opus-5-5", "claude-nope"])).toMatch(/^Model claude-nope was not found \(NotFoundError 404\)[\s\S]*Nothing was provisioned\.$/);
  });

  it("names a credential problem without showing the key", async () => {
    const model = fakeModel(() => ({ content: [], stop_reason: "end_turn" }), { models: () => 401 });
    const message = await preflightModels(model.client, ["claude-opus-5-5"]);
    expect(message).toMatch(/rejected the credentials \(AuthenticationError 401\)/);
    expect(message).not.toContain("test");
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
