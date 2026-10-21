import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { runTool } from "./run";
import type { SimTool, ToolContext } from "./types";

// Story 9.2: the only module that imports the Anthropic SDK. It turns persona tools into `strict: true`
// runnable tools for the SDK Tool Runner. Nothing here reads an API key or makes a model call, and the
// dry-run modules (cli, runner, dry-run-driver, cohort, env) never import it.
//
// - The input schema is made strict-compatible (strictSchema): constraints strict tools do not support
//   (lengths, numeric bounds, item counts above 1, patterns) move into the field descriptions, as the SDK's
//   own output-format transform does, while `enum`, `const` and supported formats stay; every object gets
//   `additionalProperties: false`. The zod schema still enforces everything, in runTool.
// - `parse` passes the raw input through, so validation happens in runTool, where a zod failure is
//   recorded in the timeline as a refusal (betaZodTool's own parse would reject it before `run`).
// - A refusal is rethrown as the SDK's ToolError so the runner returns it with `is_error: true`.

type Schema = Record<string, unknown>;

/** Keywords strict tool schemas do not support: kept for the model as text in the description. */
const MOVED = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern"];
const STRICT_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** A copy of a JSON schema node that strict tool use accepts (see the module comment). Pure. */
export function strictSchema(node: Schema): Schema {
  const out: Schema = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, Schema>).map(([name, child]) => [name, strictSchema(child)]));
    } else if (key === "$defs" && value && typeof value === "object") {
      out.$defs = Object.fromEntries(Object.entries(value as Record<string, Schema>).map(([name, child]) => [name, strictSchema(child)]));
    } else if (key === "items" && value && typeof value === "object") {
      out.items = strictSchema(value as Schema);
    } else if ((key === "anyOf" || key === "allOf" || key === "oneOf") && Array.isArray(value)) {
      out[key === "oneOf" ? "anyOf" : key] = (value as Schema[]).map(strictSchema);
    } else if (MOVED.includes(key) || (key === "minItems" && value !== 0 && value !== 1) || (key === "format" && !STRICT_FORMATS.has(String(value)))) {
      moved.push(`${key}: ${JSON.stringify(value)}`);
    } else if (key !== "additionalProperties") {
      out[key] = value;
    }
  }
  if (out.type === "object") out.additionalProperties = false;
  if (moved.length > 0) out.description = `${typeof out.description === "string" ? `${out.description}\n\n` : ""}{${moved.join(", ")}}`;
  return out;
}

/** A strict custom tool the SDK Tool Runner can run. */
export type RunnablePersonaTool = BetaRunnableTool<unknown> & BetaTool & { strict: true };

export function toRunnableTools(tools: readonly SimTool[], ctx: ToolContext): RunnablePersonaTool[] {
  return tools.map(tool => {
    const base = betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      run: async (input: unknown) => {
        const result = await runTool(tool, ctx, input);
        if (!result.ok) throw new ToolError(`${result.error}: ${result.message}`);
        return result.text;
      },
    }) as BetaRunnableTool<unknown> & BetaTool;
    return {
      ...base,
      input_schema: strictSchema(base.input_schema) as BetaTool.InputSchema,
      strict: true as const,
      parse: (input: unknown) => input,
    };
  });
}
