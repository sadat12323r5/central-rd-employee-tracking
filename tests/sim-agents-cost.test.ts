import { describe, expect, it, vi } from "vitest";
import { budgetHooks, costOf, createCostTracker, parseBudget, PRICES, shouldStopBeforeDay, SimSettingsError, UNKNOWN_MODEL_PRICE } from "../sim/agents/cost";
import { parseAgentSettings } from "../sim/agents/settings";

// Story 9.3: pricing, the cost tracker, the budget and the agents' settings. Pure.

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };

describe("costOf (Story 9.3)", () => {
  it("prices input, output, cache read and cache write per model", () => {
    expect(PRICES["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(costOf("claude-opus-5-5", usage)).toBeCloseTo(29.2, 10);
    expect(costOf("claude-haiku-5-5", usage)).toBeCloseTo(0.735, 10);
    expect(costOf("claude-haiku-5-5", { input_tokens: 2000, output_tokens: 100 })).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1e6, 12);
    expect(costOf("claude-opus-5-5", { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toBeCloseTo(40 / 1e6, 12);
  });

  it("prices dated or aliased ids by their longest known prefix", () => {
    const warn = vi.fn();
    const cost = createCostTracker({ dayEstimateUsd: 1.5, warn });
    expect(cost.add("claude-opus-5-5-20261001", usage)).toBeCloseTo(29.2, 10);
    expect(costOf("claude-haiku-5-5@latest", usage)).toBeCloseTo(0.735, 10);
    expect(warn).not.toHaveBeenCalled();
    // Not a prefix at an id boundary: unknown.
    expect(costOf("claude-opus-5-50", usage)).toBeCloseTo(73.5, 10);
  });

  it("prices an unknown model at the conservative rate, warning once", () => {
    const warn = vi.fn();
    const cost = createCostTracker({ dayEstimateUsd: 1.5, warn });
    expect(cost.add("claude-mystery", usage)).toBeCloseTo(UNKNOWN_MODEL_PRICE.input + UNKNOWN_MODEL_PRICE.output + UNKNOWN_MODEL_PRICE.cacheRead + UNKNOWN_MODEL_PRICE.cacheWrite, 10);
    cost.add("claude-mystery", usage);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/claude-mystery/);
  });
});

describe("createCostTracker (Story 9.3)", () => {
  it("sums tokens and USD per model and projects a day from the completed days' mean", () => {
    const cost = createCostTracker({ dayEstimateUsd: 1.5, warn: vi.fn() });
    expect(cost.projectedDay()).toBe(1.5);
    cost.add("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 100 });
    cost.add("claude-opus-5-5", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 });
    cost.add("claude-opus-5-5", { input_tokens: 1000, output_tokens: 100 });
    expect(cost.perModel()).toEqual({
      "claude-haiku-5-5": { requests: 1, tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, usd: expect.closeTo(150e-6, 12) },
      "claude-opus-5-5": { requests: 2, tokens: { input: 2000, output: 200, cacheRead: 50, cacheWrite: 20 }, usd: expect.closeTo(12_110e-6, 12) },
    });
    cost.dayClosed();
    cost.add("claude-opus-5-5", { input_tokens: 0, output_tokens: 50_000 }); // $1.00
    cost.dayClosed();
    expect(cost.days()).toEqual([expect.closeTo(12_260e-6, 12), expect.closeTo(1, 12)]);
    expect(cost.projectedDay()).toBeCloseTo((12_260e-6 + 1) / 2, 12);
    expect(cost.spent()).toBeCloseTo(1.01226, 10);
  });
});

describe("partial days (Story 9.3)", () => {
  it("records a partial day so the day costs sum to the total, leaving it out of the projection", () => {
    const cost = createCostTracker({ dayEstimateUsd: 1.5, warn: vi.fn() });
    const hooks = budgetHooks(cost, 10);
    cost.add("claude-opus-5-5", { input_tokens: 0, output_tokens: 10_000 }); // $0.20
    hooks.afterDay("2026-08-03");
    cost.add("claude-opus-5-5", { input_tokens: 0, output_tokens: 5_000 }); // $0.10
    hooks.afterDay("2026-08-04", { partial: true });
    expect(cost.days()).toEqual([expect.closeTo(0.2, 10), expect.closeTo(0.1, 10)]);
    expect(cost.days().reduce((a, b) => a + b, 0)).toBeCloseTo(cost.spent(), 12);
    expect(cost.partialDay()).toBe("2026-08-04");
    expect(cost.projectedDay()).toBeCloseTo(0.2, 10);
  });
});

describe("the budget (Story 9.3)", () => {
  it("stops before a day when spent + the projected day would exceed it", () => {
    expect(shouldStopBeforeDay(0.7, 0.4, 1)).toBe(true);
    expect(shouldStopBeforeDay(0.5, 0.4, 1)).toBe(false);
    expect(shouldStopBeforeDay(0.6, 0.4, 1)).toBe(false);
  });

  it("explains the stop in the hooks", () => {
    const cost = createCostTracker({ dayEstimateUsd: 0.4, warn: vi.fn() });
    cost.add("claude-opus-5-5", { input_tokens: 0, output_tokens: 35_000 }); // $0.70
    const hooks = budgetHooks(cost, 1);
    expect(hooks.beforeDay("2026-08-04")).toBe("Stopped before 2026-08-04: spent $0.70 plus a projected $0.40 for one more day would exceed SIM_MAX_USD ($1.00).");
    expect(hooks.duringDay("2026-08-04")).toBeNull();
    cost.add("claude-opus-5-5", { input_tokens: 0, output_tokens: 15_000 }); // $1.00 in all
    expect(hooks.duringDay("2026-08-04")).toMatch(/^Stopped during 2026-08-04: spent \$1\.00 reached SIM_MAX_USD/);
  });

  it("reads SIM_MAX_USD: default 15, positive numbers only", () => {
    expect(parseBudget({})).toBe(15);
    expect(parseBudget({ SIM_MAX_USD: " 2.5 " })).toBe(2.5);
    for (const bad of ["abc", "0", "-1", "Infinity", "NaN"]) expect(() => parseBudget({ SIM_MAX_USD: bad }), bad).toThrow(SimSettingsError);
  });
});

describe("parseAgentSettings (Story 9.3)", () => {
  it("has the documented defaults", () => {
    expect(parseAgentSettings({})).toEqual({
      managerModel: "claude-opus-5-5", staffModel: "claude-haiku-5-5", effort: "medium", maxTokens: 4000,
      maxActionsPerDay: 6, maxUsd: 15, dayEstimateUsd: 1.5,
    });
  });

  it("honours overrides and caps max_tokens at 16000", () => {
    expect(parseAgentSettings({
      SIM_MANAGER_MODEL: "claude-fable-5", SIM_STAFF_MODEL: "claude-sonnet-5-5", SIM_EFFORT: "high", SIM_MAX_TOKENS: "20000",
      SIM_MAX_ACTIONS_PER_DAY: "4", SIM_MAX_USD: "3", SIM_DAY_ESTIMATE_USD: "0.25",
    })).toEqual({
      managerModel: "claude-fable-5", staffModel: "claude-sonnet-5-5", effort: "high", maxTokens: 16000,
      maxActionsPerDay: 4, maxUsd: 3, dayEstimateUsd: 0.25,
    });
  });

  it.each([
    [{ SIM_EFFORT: "extreme" }, /^SIM_EFFORT/],
    [{ SIM_MAX_TOKENS: "1.5" }, /^SIM_MAX_TOKENS/],
    [{ SIM_MAX_TOKENS: "0" }, /^SIM_MAX_TOKENS/],
    [{ SIM_MAX_ACTIONS_PER_DAY: "x" }, /^SIM_MAX_ACTIONS_PER_DAY/],
    [{ SIM_MAX_ACTIONS_PER_DAY: "500" }, /^SIM_MAX_ACTIONS_PER_DAY/],
    [{ SIM_DAY_ESTIMATE_USD: "-1" }, /^SIM_DAY_ESTIMATE_USD/],
    [{ SIM_STAFF_MODEL: "has spaces" }, /^SIM_STAFF_MODEL/],
    [{ SIM_MAX_USD: "abc" }, /^SIM_MAX_USD/],
  ])("refuses %o", (env, message) => {
    expect(() => parseAgentSettings(env)).toThrow(SimSettingsError);
    expect(() => parseAgentSettings(env)).toThrow(message);
  });
});
