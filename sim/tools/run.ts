import type { z } from "zod";
import { dhakaDate } from "@/domain/timesheet";
import { describeError } from "../errors";
import type { SimTool, ToolContext, ToolOutcome } from "./types";

// Story 9.2: runs one persona tool call. A tool outside the persona's role set is refused first (a wiring
// mistake, never an app finding). The raw input is then validated with the tool's strict zod schema (a
// failure is a refusal and the store is never called), then the tool calls its store. Any store or domain
// error becomes `{ ok: false, error: <class name>, message }`: it is recorded as a `refusal` and returned,
// never retried, worked around or thrown. A success is recorded as an `action`. A failing timeline write
// never changes the outcome (the store write may already be committed).

export const TOOL_TEXT_MAX = 4000;
export const RECORDED_INPUT_MAX = 2000;
export const INVALID_TOOL_INPUT = "InvalidToolInput";
export const TOOL_NOT_ALLOWED = "ToolNotAllowed";

/** Caps a plain result text at TOOL_TEXT_MAX characters, marking the cut. */
export function capText(text: string, max = TOOL_TEXT_MAX): string {
  if (text.length <= max) return text;
  const marker = " …(truncated)";
  return `${text.slice(0, max - marker.length)}${marker}`;
}

/**
 * A list read as valid JSON of at most `max` characters: the whole array when it fits, otherwise
 * `{ truncated: true, shown, total, items }` with as many leading items as fit.
 */
export function fitJsonList(items: readonly unknown[], max = TOOL_TEXT_MAX): string {
  const whole = JSON.stringify(items);
  if (whole.length <= max) return whole;
  for (let shown = items.length - 1; shown >= 0; shown--) {
    const text = JSON.stringify({ truncated: true, shown, total: items.length, items: items.slice(0, shown) });
    if (text.length <= max) return text;
  }
  return JSON.stringify({ truncated: true, shown: 0, total: items.length, items: [] });
}

/** Every zod issue as "path: message", so the persona can see which field to fix. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.length > 0 ? issue.path.join(".") : "(input)"}: ${issue.message}`).join("; ");
}

/** The input as recorded in the timeline: as given, or a truncated JSON string when it is long. */
function recordedInput(input: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    return "(unserializable input)";
  }
  return text !== undefined && text.length > RECORDED_INPUT_MAX ? capText(text, RECORDED_INPUT_MAX) : input;
}

export async function runTool(tool: SimTool, ctx: ToolContext, rawInput: unknown): Promise<ToolOutcome> {
  const at = ctx.clock.now();
  const role = ctx.member.persona.role;
  let outcome: ToolOutcome;
  // The timeline text: narrate() appends a refusal's cause itself, so it is left out here.
  let text: string;
  if (!tool.roles.includes(role)) {
    outcome = { ok: false, error: TOOL_NOT_ALLOWED, message: `${tool.name} is not one of the ${role} tools.` };
    text = outcome.message;
  } else {
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      outcome = { ok: false, error: INVALID_TOOL_INPUT, message: capText(`Invalid input: ${describeIssues(parsed.error)}`) };
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
  }

  try {
    const input = recordedInput(rawInput);
    ctx.timeline.record({
      day: dhakaDate(at),
      at: at.toISOString(),
      actor: ctx.member.persona.name,
      kind: outcome.ok ? "action" : "refusal",
      text: outcome.ok ? text : `${tool.name}: ${text}`,
      detail: outcome.ok
        ? { tool: tool.name, input }
        : {
          tool: tool.name, input, error: outcome.error,
          ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.cause ? { cause: outcome.cause } : {}),
        },
    });
  } catch (error) {
    // The call already happened (and may have written): its outcome stands; the lost event is reported.
    console.warn(`Could not record ${tool.name} in the timeline: ${describeError(error).message}`);
  }
  return outcome;
}
