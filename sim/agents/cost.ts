// Story 9.3: what the run spends. Every model response's `usage` (input, output, cache read and cache
// write tokens) is priced at its model's per-million-token prices and summed per model. Before each day
// the run checks spent + the projected cost of one day (the mean of the completed days, or the configured
// estimate before any day completes) against SIM_MAX_USD and stops at that day boundary if it would be
// exceeded; mid-day, reaching the budget skips the rest of the day. Pure apart from the warning callback.

/** A SIM_* setting is invalid: the run exits 2 with this message and provisions nothing. */
export class SimSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimSettingsError";
  }
}

/** USD per million tokens. */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/**
 * An unknown model is priced at this conservative rate, above every known price (with a warning), so spend
 * is never under-counted.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export const DEFAULT_MAX_USD = 15;

/** The token counts of a response's `usage` this module reads (the SDK's fields may be null or absent). */
export type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

const count = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function tokensOf(usage: UsageLike | null | undefined): Tokens {
  return {
    input: count(usage?.input_tokens),
    output: count(usage?.output_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens),
  };
}

/**
 * A model's price: an exact id, else the longest known id it extends (a dated or aliased id such as
 * `claude-opus-5-5-20261001`), else the unknown-model rate.
 */
export function priceOf(model: string): { price: ModelPrice; known: boolean } {
  const exact = PRICES[model];
  if (exact) return { price: exact, known: true };
  const base = Object.keys(PRICES).filter(id => model.startsWith(`${id}-`) || model.startsWith(`${id}@`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? { price: PRICES[base], known: true } : { price: UNKNOWN_MODEL_PRICE, known: false };
}

/** The USD cost of one response's usage on `model`. */
export function costOf(model: string, usage: UsageLike | null | undefined): number {
  const { price } = priceOf(model);
  const t = tokensOf(usage);
  return (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1_000_000;
}

/** SIM_MAX_USD (default 15): a positive number of US dollars. Throws SimSettingsError otherwise. */
export function parseBudget(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIM_MAX_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_USD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) throw new SimSettingsError(`SIM_MAX_USD must be a positive number of US dollars, not "${raw}". Nothing was provisioned.`);
  return n;
}

/** True when starting another day could take spend past the budget. */
export function shouldStopBeforeDay(spent: number, projectedDay: number, maxUsd: number): boolean {
  return spent + projectedDay > maxUsd;
}

export type ModelSpend = { requests: number; tokens: Tokens; usd: number };

export type CostTracker = {
  /** Prices one response's usage on `model`, adds it and returns its USD cost. */
  add(model: string, usage: UsageLike | null | undefined): number;
  spent(): number;
  perModel(): Record<string, ModelSpend>;
  /**
   * Closes a working day: its spend joins the per-day costs. A partial day (stopped mid-day by the budget)
   * is recorded too, so the per-day costs always sum to the total, but it is left out of the projection.
   */
  dayClosed(date?: string, options?: { partial?: boolean }): void;
  /** The date of the day the budget cut short, or null. */
  partialDay(): string | null;
  /** The projected cost of one day: the completed days' mean, or the estimate before any. */
  projectedDay(): number;
  /** The completed days' costs, in order. */
  days(): number[];
};

export function createCostTracker({ dayEstimateUsd, warn = line => console.warn(line) }: {
  dayEstimateUsd: number; warn?: (line: string) => void;
}): CostTracker {
  const models = new Map<string, ModelSpend>();
  const warned = new Set<string>();
  const closed: { usd: number; partial: boolean; date?: string }[] = [];
  let spent = 0;
  let atLastClose = 0;
  return {
    add(model, usage) {
      if (!priceOf(model).known && !warned.has(model)) {
        warned.add(model);
        warn(`No price is configured for model ${model}; it is priced at the highest known tier.`);
      }
      const usd = costOf(model, usage);
      const t = tokensOf(usage);
      const entry = models.get(model) ?? { requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0 };
      entry.requests += 1;
      entry.tokens.input += t.input;
      entry.tokens.output += t.output;
      entry.tokens.cacheRead += t.cacheRead;
      entry.tokens.cacheWrite += t.cacheWrite;
      entry.usd += usd;
      models.set(model, entry);
      spent += usd;
      return usd;
    },
    spent: () => spent,
    perModel: () => Object.fromEntries([...models].map(([m, s]) => [m, { requests: s.requests, tokens: { ...s.tokens }, usd: s.usd }])),
    dayClosed(date, { partial = false } = {}) {
      closed.push({ usd: spent - atLastClose, partial, ...(date ? { date } : {}) });
      atLastClose = spent;
    },
    partialDay: () => closed.find(d => d.partial)?.date ?? null,
    projectedDay() {
      const full = closed.filter(d => !d.partial);
      return full.length === 0 ? dayEstimateUsd : full.reduce((a, d) => a + d.usd, 0) / full.length;
    },
    days: () => closed.map(d => d.usd),
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The runner's budget hooks (see runSimulation's `budget`) for a tracker and a budget. */
export function budgetHooks(cost: CostTracker, maxUsd: number) {
  return {
    beforeDay(date: string): string | null {
      const spent = cost.spent();
      const projected = cost.projectedDay();
      if (!shouldStopBeforeDay(spent, projected, maxUsd)) return null;
      return `Stopped before ${date}: spent ${usd(spent)} plus a projected ${usd(projected)} for one more day would exceed SIM_MAX_USD (${usd(maxUsd)}).`;
    },
    duringDay(date: string): string | null {
      const spent = cost.spent();
      if (spent < maxUsd) return null;
      return `Stopped during ${date}: spent ${usd(spent)} reached SIM_MAX_USD (${usd(maxUsd)}); the rest of the day was skipped.`;
    },
    afterDay(date: string, options?: { partial?: boolean }): void {
      cost.dayClosed(date, options);
    },
  };
}
