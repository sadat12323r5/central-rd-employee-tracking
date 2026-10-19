import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaMessage, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import { dhakaDate } from "@/domain/timesheet";
import type { DriverStep } from "../dry-run-driver";
import { SimFatalError } from "../errors";
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

export type DayStop = "refusal" | "max_tokens" | "tool_use" | "pause_turn" | "model_context_window_exceeded" | "budget" | "error" | null;

/** Stop reasons that end a persona's day without a usable reply (recorded as model refusals). */
const UNFINISHED: Record<string, string> = {
  refusal: "The model declined to continue",
  max_tokens: "The model's reply hit max_tokens",
  tool_use: "The model was still calling tools when the day's request limit was reached",
  pause_turn: "The model paused its turn",
  model_context_window_exceeded: "The conversation exceeded the model's context window",
};

/**
 * SDK errors no retry or other persona can fix (credentials, permissions, an unknown model, an invalid
 * request): they stop the whole run. Rate limits, server errors and connection errors stay per persona.
 */
export function isFatalApiError(error: unknown): boolean {
  return error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
    || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.BadRequestError;
}

/** A short description of a fatal SDK error (class, status and the API's message); never a credential. */
export function describeApiError(error: unknown, model: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown }).status;
  const short = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  if (error instanceof Anthropic.AuthenticationError) return `The model API rejected the credentials (AuthenticationError 401); check the Anthropic API key in .env.local. ${short}`;
  if (error instanceof Anthropic.PermissionDeniedError) return `The model API denied access to ${model} (PermissionDeniedError 403). ${short}`;
  if (error instanceof Anthropic.NotFoundError) return `Model ${model} was not found (NotFoundError 404); check SIM_MANAGER_MODEL and SIM_STAFF_MODEL. ${short}`;
  return `The model API rejected a request to ${model} (${errorClass(error)}${typeof status === "number" ? ` ${status}` : ""}). ${short}`;
}

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

export async function runPersonaDay({ client, model, settings, persona, ctx, brief, notes, onUsage, overBudget }: {
  client: Anthropic;
  model: string;
  settings: AgentSettings;
  persona: Persona;
  ctx: ToolContext;
  brief: string;
  notes: string;
  onUsage: (model: string, usage: UsageLike) => void;
  /** Checked after each response's usage is added: a reason stops this persona's day at once (the hard budget). */
  overBudget?: () => string | null;
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
  let budgetStop: string | null = null;
  try {
    const runner = client.beta.messages.toolRunner(personaDayParams({ model, settings, persona, tools, brief }));
    for await (const message of runner) {
      messages.push(message);
      try {
        onUsage(message.model || model, message.usage);
      } catch (error) {
        console.warn(`Could not cost a response: ${error instanceof Error ? error.message : String(error)}`);
      }
      budgetStop = overBudget?.() ?? null;
      // Leaving the loop ends the runner before it runs this reply's tool calls or sends another request.
      if (budgetStop) break;
    }
  } catch (error) {
    if (isFatalApiError(error)) throw new SimFatalError(describeApiError(error, model), { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: unknown }).status;
    steps.push(refusal(`The model call failed: ${message.length > 500 ? `${message.slice(0, 499)}…` : message}`, {
      error: errorClass(error), ...(typeof status === "number" ? { status } : {}), model,
    }));
    return { steps, notes, stop: "error" };
  }

  if (budgetStop) {
    steps.push(refusal(`${persona.name}'s day was cut short: ${budgetStop}`, { reason: "budget", model }));
    return { steps, notes, stop: "budget" };
  }
  const last = messages.at(-1);
  const stop = last?.stop_reason;
  if (last && stop && stop in UNFINISHED) {
    steps.push(refusal(`${UNFINISHED[stop]}; ${persona.name}'s day ended there.`, {
      stop_reason: stop, model: last.model || model, ...(last.stop_details ? { stop_details: last.stop_details } : {}),
    }));
    return { steps, notes, stop: stop as DayStop };
  }
  // Only the final reply's NOTES count; otherwise yesterday's notes stand.
  const parsed = last ? parseNotes(textOf(last)) : null;
  return { steps, notes: parsed ?? notes, stop: null };
}

/**
 * Checks, before anything is provisioned, that the client's credentials work and that each distinct model
 * exists (the free models endpoint). Returns null when all are fine, or a message naming the model or the
 * credential problem (never a credential).
 */
export async function preflightModels(client: Anthropic, models: readonly string[]): Promise<string | null> {
  for (const model of [...new Set(models)]) {
    try {
      await client.models.retrieve(model);
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status !== undefined) return `${describeApiError(error, model)} Nothing was provisioned.`;
      const message = error instanceof Error ? error.message : String(error);
      return `Could not check model ${model} (${errorClass(error)}): ${message.length > 300 ? `${message.slice(0, 299)}…` : message} Check the Anthropic API key in .env.local and the network. Nothing was provisioned.`;
    }
  }
  return null;
}
