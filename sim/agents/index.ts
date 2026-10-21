import Anthropic from "@anthropic-ai/sdk";

// Story 9.3: the persona agents, loaded by sim/cli.ts with a dynamic import() only on a real run, so the
// dry run's import graph never reaches the SDK. The SDK client resolves its own credentials.

export { preflightModels, runPersonaDay } from "./agent";
export { budgetHooks, createCostTracker, SimSettingsError } from "./cost";
export { createAgentDriver } from "./driver";
export { parseAgentSettings } from "./settings";

/** A real SDK client (it reads its own credentials from the environment). */
export function createAnthropicClient(): Anthropic {
  return new Anthropic();
}
