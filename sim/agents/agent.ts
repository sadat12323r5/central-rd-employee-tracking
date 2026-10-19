import type Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaMessage, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import { dhakaDate } from "@/domain/timesheet";
import type { DriverStep } from "../dry-run-driver";
import type { Persona } from "../personas";
import type { NewTimelineEvent } from "../timeline";
import { toRunnableTools, type RunnablePersonaTool } from "../tools/anthropic";
import { toolsFor } from "../tools/catalog";
import type { ToolContext } from "../tools/types";
import { NOTES_MAX, systemPrompt } from "./brief";
import type { UsageLike } from "./cost";
import type { AgentSettings } from "./settings";

// Story 9.3: one persona's working day. A fresh one-message conversation (the daily brief) goes to the
// SDK Tool Runner with the persona's role tools (strict, in catalogue order) and its stable, cached system
// prompt. Tool calls go through runTool (which records each in the timeline); past the daily action cap a
// call is refused with DailyActionCapReached instead. A `refusal` or `max_tokens` stop, or an SDK/API
// error after the SDK's own retries, ends the persona's day with a refusal step; nothing here throws. The
// final reply's "NOTES:" line becomes the persona's notes for tomorrow.

export const DAILY_ACTION_CAP_REACHED = "DailyActionCapReached";
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Server-side fallbacks exist only for Opus and Fable models (not Haiku). */
export const hasServerSideFallback = (model: string) => /opus|fable/i.test(model);

export type DayStop = "refusal" | "max_tokens" | "error" | null;

export type PersonaDayResult = { steps: DriverStep[]; notes: string; stop: DayStop };

/** The text after the last line starting "NOTES:", trimmed and capped; null when there is none. */
export function parseNotes(text: string): string | null {
  const matches = [...text.matchAll(/^[ \t]*NOTES:/gm)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const notes = text.slice(last.index + last[0].length).trim();
  if (!notes) return null;
  return notes.length <= NOTES_MAX ? notes : notes.slice(0, NOTES_MAX);
}

const textOf = (message: BetaMessage) =>
  message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

/** The request every day of this persona starts with (exported for the tests). */
export function personaDayParams({ model, settings, persona, tools, brief }: {
  model: string; settings: AgentSettings; persona: Persona; tools: RunnablePersonaTool[]; brief: string;
}): BetaToolRunnerParams & { stream?: false } {
  // The cache breakpoint is on the last (only) system block: tools then system are the stable prefix.
  const system: BetaTextBlockParam[] = [{ type: "text", text: systemPrompt(persona, persona.role), cache_control: { type: "ephemeral" } }];
  return {
    model,
    max_tokens: settings.maxTokens,
    system,
    messages: [{ role: "user", content: brief }],
    tools,
    tool_choice: { type: "auto" },
    output_config: { effort: settings.effort },
    max_iterations: settings.maxActionsPerDay + 2,
    stream: false,
    ...(hasServerSideFallback(model) ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

function errorClass(error: unknown): string {
  if (error instanceof Error) {
    const ctor = (error as { constructor?: { name?: string } }).constructor?.name;
    return ctor && ctor !== "Error" ? ctor : error.name;
  }
  return "Error";
}

export async function runPersonaDay({ client, model, settings, persona, ctx, brief, notes, onUsage }: {
  client: Anthropic;
  model: string;
  settings: AgentSettings;
  persona: Persona;
  ctx: ToolContext;
  brief: string;
  notes: string;
  onUsage: (model: string, usage: UsageLike) => void;
}): Promise<PersonaDayResult> {
  const steps: DriverStep[] = [];
  // Every event the tool layer records for this persona today is also a (recorded) step.
  const timeline: ToolContext["timeline"] = {
    record(event: NewTimelineEvent) {
      const full = ctx.timeline.record(event);
      steps.push({ at: new Date(event.at), kind: event.kind === "refusal" ? "refusal" : "action", text: event.text, detail: event.detail, recorded: true });
      return full;
    },
  };
  const dayCtx: ToolContext = { ...ctx, timeline };
  let calls = 0;
  const cap = settings.maxActionsPerDay;
  // The runner may start a reply's tool calls together; they run one at a time, in the model's order, so
  // a clock_in and the log after it never race and the cap counts calls in order.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const tools: RunnablePersonaTool[] = toRunnableTools(toolsFor(persona.role), dayCtx).map(tool => ({
    ...tool,
    run: (input, context) => inTurn(async () => {
      if (calls >= cap) {
        const message = `You have used all ${cap} of today's tool calls. Stop here and write your NOTES for tomorrow.`;
        const at = ctx.clock.now();
        try {
          timeline.record({
            day: dhakaDate(at), at: at.toISOString(), actor: persona.name, kind: "refusal", text: `${tool.name}: ${message}`,
            detail: { tool: tool.name, error: DAILY_ACTION_CAP_REACHED, source: "cap", cap },
          });
        } catch (error) {
          console.warn(`Could not record the action cap for ${persona.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw new ToolError(`${DAILY_ACTION_CAP_REACHED}: ${message}`);
      }
      calls += 1;
      return tool.run(input, context);
    }),
  }));

  const refusal = (text: string, detail: Record<string, unknown>): DriverStep =>
    ({ at: ctx.clock.now(), kind: "refusal", text, detail: { source: "model", ...detail } });

  const messages: BetaMessage[] = [];
  try {
    const runner = client.beta.messages.toolRunner(personaDayParams({ model, settings, persona, tools, brief }));
    for await (const message of runner) {
      messages.push(message);
      try {
        onUsage(message.model || model, message.usage);
      } catch (error) {
        console.warn(`Could not cost a response: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: unknown }).status;
    steps.push(refusal(`The model call failed: ${message.length > 500 ? `${message.slice(0, 499)}…` : message}`, {
      error: errorClass(error), ...(typeof status === "number" ? { status } : {}), model,
    }));
    return { steps, notes, stop: "error" };
  }

  const last = messages.at(-1);
  if (last && (last.stop_reason === "refusal" || last.stop_reason === "max_tokens")) {
    const why = last.stop_reason === "refusal" ? "The model declined to continue" : "The model's reply hit max_tokens";
    steps.push(refusal(`${why}; ${persona.name}'s day ended there.`, {
      stop_reason: last.stop_reason, model: last.model || model, ...(last.stop_details ? { stop_details: last.stop_details } : {}),
    }));
    return { steps, notes, stop: last.stop_reason };
  }
  for (const message of [...messages].reverse()) {
    const parsed = parseNotes(textOf(message));
    if (parsed !== null) return { steps, notes: parsed, stop: null };
  }
  return { steps, notes, stop: null };
}
