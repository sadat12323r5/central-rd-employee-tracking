import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaveOverlapError } from "@/server/leave-store";
import { strictSchema, toRunnableTools } from "../sim/tools/anthropic";
import { TOOLS, toolsFor } from "../sim/tools/catalog";
import { fakeToolContext } from "./support/sim-tool-fakes";

// Story 9.2: the SDK adapter, offline. `run` is called directly as the Tool Runner would (parse, then run):
// no client, no API key, no network.

afterEach(() => vi.restoreAllMocks());

type Schema = Record<string, unknown>;
/** Every object node of a schema (properties, items, anyOf, $defs). */
function objectNodes(node: Schema): Schema[] {
  const children = [
    ...Object.values((node.properties ?? {}) as Record<string, Schema>),
    ...Object.values((node.$defs ?? {}) as Record<string, Schema>),
    ...((node.anyOf ?? []) as Schema[]),
    ...(node.items ? [node.items as Schema] : []),
  ];
  return [...(node.type === "object" ? [node] : []), ...children.flatMap(objectNodes)];
}

/** Every schema node (properties, items, anyOf, $defs), whatever its type. */
function allNodes(node: Schema): Schema[] {
  const children = [
    ...Object.values((node.properties ?? {}) as Record<string, Schema>),
    ...Object.values((node.$defs ?? {}) as Record<string, Schema>),
    ...((node.anyOf ?? []) as Schema[]),
    ...(node.items ? [node.items as Schema] : []),
  ];
  return [node, ...children.flatMap(allNodes)];
}

const STRICT_FORMATS = ["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"];

describe("toRunnableTools (Story 9.2)", () => {
  it("makes every tool a strict custom tool with closed objects and every property required", () => {
    const { ctx } = fakeToolContext("admin");
    const tools = toRunnableTools(TOOLS, ctx);
    expect(tools.map(t => t.name)).toEqual(TOOLS.map(t => t.name));
    for (const tool of tools) {
      expect(tool.strict, tool.name).toBe(true);
      expect(tool.type, tool.name).toBe("custom");
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
      expect(tool.input_schema.$schema, tool.name).toBeUndefined();
      for (const node of objectNodes(tool.input_schema)) {
        expect(node.additionalProperties, tool.name).toBe(false);
        expect([...((node.required ?? []) as string[])].sort(), tool.name).toEqual(Object.keys((node.properties ?? {}) as object).sort());
      }
      expect(JSON.stringify(tool.input_schema), tool.name)
        .not.toMatch(/"(minLength|maxLength|maximum|minimum|exclusiveMinimum|exclusiveMaximum|multipleOf|maxItems|pattern)":/);
      for (const node of allNodes(tool.input_schema)) {
        if ("minItems" in node) expect([0, 1], tool.name).toContain(node.minItems);
        if ("format" in node) expect(STRICT_FORMATS, tool.name).toContain(node.format);
      }
    }
  });

  it("keeps enums and supported formats, and moves unsupported constraints into the description", () => {
    expect(strictSchema({
      type: "object", properties: {
        mode: { type: "string", enum: ["Office", "Remote"] },
        id: { type: "string", format: "uuid", pattern: "^x$" },
        note: { type: "string", description: "A note.", maxLength: 20 },
      }, required: ["mode", "id", "note"], additionalProperties: false,
    })).toEqual({
      type: "object", properties: {
        mode: { type: "string", enum: ["Office", "Remote"] },
        id: { type: "string", format: "uuid", description: "{pattern: \"^x$\"}" },
        note: { type: "string", description: "A note.\n\n{maxLength: 20}" },
      }, required: ["mode", "id", "note"], additionalProperties: false,
    });
  });

  it("returns the tool's text on success, recording an action", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { ctx, calls, events } = fakeToolContext("staff");
    const recordLeave = toRunnableTools(toolsFor("staff"), ctx).find(t => t.name === "record_leave")!;
    const input = recordLeave.parse({ startDate: "2026-08-24", endDate: "2026-08-25" });
    const text = await recordLeave.run(input);
    expect(text).toMatch(/^Leave recorded\./);
    expect(calls.map(c => `${c.store}.${c.method}`)).toEqual(["leave.record"]);
    expect(events.map(e => e.kind)).toEqual(["action"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws a ToolError carrying the class name and the app's message on a refusal", async () => {
    const error = new LeaveOverlapError({ startDate: "2026-08-20", endDate: "2026-08-24" });
    const { ctx, events } = fakeToolContext("staff", { failures: { "leave.record": error } });
    const recordLeave = toRunnableTools(toolsFor("staff"), ctx).find(t => t.name === "record_leave")!;
    const run = recordLeave.run(recordLeave.parse({ startDate: "2026-08-24", endDate: "2026-08-25" }));
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({ content: `LeaveOverlapError: ${error.message}` });
    expect(events.map(e => e.kind)).toEqual(["refusal"]);
  });

  it("lets invalid input reach runTool, so the refusal is recorded and the store is not called", async () => {
    const { ctx, calls, events } = fakeToolContext("staff");
    const clockIn = toRunnableTools(toolsFor("staff"), ctx).find(t => t.name === "clock_in")!;
    const raw = { workMode: "Beach", extra: true };
    expect(clockIn.parse(raw)).toBe(raw);
    await expect(clockIn.run(clockIn.parse(raw))).rejects.toMatchObject({ content: expect.stringMatching(/^InvalidToolInput: /) });
    expect(calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ kind: "refusal", detail: expect.objectContaining({ tool: "clock_in", error: "InvalidToolInput" }) })]);
  });

  it("runs under the SDK Tool Runner with a scripted fake model: a refusal goes back as an is_error tool_result", async () => {
    const error = new LeaveOverlapError({ startDate: "2026-08-20", endDate: "2026-08-24" });
    const { ctx, events } = fakeToolContext("staff", { failures: { "leave.record": error } });
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const reply = (content: unknown[], stop: string) => new Response(JSON.stringify({
      id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? reply([{ type: "tool_use", id: "toolu_1", name: "record_leave", input: { startDate: "2026-08-24", endDate: "2026-08-25" } }], "tool_use")
        : reply([{ type: "text", text: "That overlaps; I will pick other dates." }], "end_turn");
    };
    const client = new Anthropic({ apiKey: "test", fetch: fakeFetch, maxRetries: 0 });
    const final = await client.beta.messages.toolRunner({
      model: "claude-haiku-5-5", max_tokens: 1024, max_iterations: 3,
      messages: [{ role: "user", content: "Record leave for 24-25 August." }],
      tools: toRunnableTools(toolsFor("staff"), ctx),
    });
    expect(final.stop_reason).toBe("end_turn");
    expect(bodies).toHaveLength(2);
    const last = bodies[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([expect.objectContaining({
      type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: `LeaveOverlapError: ${error.message}`,
    })]);
    expect(events).toEqual([expect.objectContaining({ kind: "refusal", detail: expect.objectContaining({ tool: "record_leave", error: "LeaveOverlapError" }) })]);
  });
});
