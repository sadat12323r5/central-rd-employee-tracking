import { parseBudget, SimSettingsError } from "./cost";

// Story 9.3: the persona agents' settings, read from the environment (SIM_*) and validated before
// anything is provisioned. A bad value is a SimSettingsError whose message names the variable (and the
// value, which is never a secret). The model API key is not one of them: the SDK client resolves its
// own credentials.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MANAGER_MODEL = "claude-opus-5-5";
export const DEFAULT_STAFF_MODEL = "claude-haiku-5-5";
export const DEFAULT_MAX_TOKENS = 4000;
export const MAX_TOKENS_CAP = 16000;
export const DEFAULT_MAX_ACTIONS_PER_DAY = 6;
export const MAX_ACTIONS_PER_DAY_LIMIT = 50;
export const DEFAULT_DAY_ESTIMATE_USD = 1.5;

export type AgentSettings = {
  /** The manager's and the Administrator's model. */
  managerModel: string;
  staffModel: string;
  effort: Effort;
  /** Per request, at most MAX_TOKENS_CAP. */
  maxTokens: number;
  /** Tool calls per persona per day. */
  maxActionsPerDay: number;
  /** The run's hard budget in USD. */
  maxUsd: number;
  /** The projected cost of one day before any day has completed, in USD. */
  dayEstimateUsd: number;
};

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
};

function model(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@\-[\]]*$/.test(raw) || raw.length > 100) throw new SimSettingsError(`${name} must be a model id such as ${fallback}, not "${raw}".`);
  return raw;
}

function wholeNumber(env: Env, name: string, fallback: number, max: number, { clamp }: { clamp: boolean }): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new SimSettingsError(`${name} must be a whole number, 1 or more, not "${raw}".`);
  if (n > max) {
    if (clamp) return max;
    throw new SimSettingsError(`${name} must be at most ${max}, not "${raw}".`);
  }
  return n;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new SimSettingsError(`${name} must be a positive number of US dollars, not "${raw}".`);
  return n;
}

/** The agents' settings from the environment. Throws SimSettingsError naming the first bad variable. */
export function parseAgentSettings(env: Env = process.env): AgentSettings {
  const effort = value(env, "SIM_EFFORT") ?? "medium";
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new SimSettingsError(`SIM_EFFORT must be one of ${EFFORTS.join(", ")}, not "${effort}".`);
  return {
    managerModel: model(env, "SIM_MANAGER_MODEL", DEFAULT_MANAGER_MODEL),
    staffModel: model(env, "SIM_STAFF_MODEL", DEFAULT_STAFF_MODEL),
    effort: effort as Effort,
    // max_tokens is capped (bounded), not refused, above the cap.
    maxTokens: wholeNumber(env, "SIM_MAX_TOKENS", DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP, { clamp: true }),
    maxActionsPerDay: wholeNumber(env, "SIM_MAX_ACTIONS_PER_DAY", DEFAULT_MAX_ACTIONS_PER_DAY, MAX_ACTIONS_PER_DAY_LIMIT, { clamp: false }),
    maxUsd: parseBudget(env),
    dayEstimateUsd: positive(env, "SIM_DAY_ESTIMATE_USD", DEFAULT_DAY_ESTIMATE_USD),
  };
}
