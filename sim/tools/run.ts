import type { z } from "zod";
import { describeError } from "../errors";
import type { SimTool, ToolContext, ToolOutcome } from "./types";

// Story 9.2: runs one persona tool call. The raw input is validated with the tool's strict zod schema
// first (a failure is a refusal and the store is never called), then the tool calls its store. Any store
// or domain error becomes `{ ok: false, error: <class name>, message }`: it is recorded as a `refusal`
// and returned, never retried, worked around or thrown. A success is recorded as an `action`.

export const TOOL_TEXT_MAX = 4000;
export const INVALID_TOOL_INPUT = "InvalidToolInput";

/** Caps a result text at TOOL_TEXT_MAX characters, marking the cut. */
export function capText(text: string, max = TOOL_TEXT_MAX): string {
  if (text.length <= max) return text;
  const marker = " …(truncated)";
  return `${text.slice(0, max - marker.length)}${marker}`;
}

/** Every zod issue as "path: message", so the persona can see which field to fix. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.length > 0 ? issue.path.join(".") : "(input)"}: ${issue.message}`).join("; ");
}

export async function runTool(tool: SimTool, ctx: ToolContext, rawInput: unknown): Promise<ToolOutcome> {
  const at = ctx.clock.now();
  const parsed = tool.input.safeParse(rawInput);
  let outcome: ToolOutcome;
  // The timeline text: narrate() appends a refusal's cause itself, so it is left out here.
  let text: string;
  if (!parsed.success) {
    outcome = { ok: false, error: INVALID_TOOL_INPUT, message: capText(`Invalid input for ${tool.name}: ${describeIssues(parsed.error)}`) };
    text = outcome.message;
  } else {
    try {
      outcome = { ok: true, text: capText(await tool.run(ctx, parsed.data)) };
      text = outcome.text;
    } catch (error) {
      const { error: name, message, code, cause } = describeError(error);
      // The database's own reason behind an "unavailable" refusal is part of the app's message here.
      const full = cause ? `${message} (${cause})` : message;
      outcome = { ok: false, error: name, message: capText(full), ...(code ? { code } : {}), ...(cause ? { cause } : {}) };
      text = capText(message);
    }
  }

  ctx.timeline.record({
    day: ctx.clock.today(),
    at: at.toISOString(),
    actor: ctx.member.persona.name,
    kind: outcome.ok ? "action" : "refusal",
    text: outcome.ok ? text : `${tool.name}: ${text}`,
    detail: outcome.ok
      ? { tool: tool.name, input: rawInput }
      : {
        tool: tool.name, input: rawInput, error: outcome.error,
        ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.cause ? { cause: outcome.cause } : {}),
      },
  });
  return outcome;
}
