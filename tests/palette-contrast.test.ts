import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// axe only checks text it can see rendered. These pairings are either never rendered during
// e2e scans (placeholders, hover/focus states, the demo-credentials box) or are non-text
// contrast, so their ratios are checked here, straight from the stylesheet's :root tokens.

const css = readFileSync(join(process.cwd(), "src/app/styles.css"), "utf8");
const root = css.match(/:root\{([^}]*)\}/)?.[1] ?? "";
const tokens = Object.fromEntries([...root.matchAll(/(--[a-z-]+):(#[0-9a-f]{3,6})\b/gi)].map(m => [m[1], m[2]]));

function hex(name: string): number[] {
  const value = tokens[name];
  if (!value) throw new Error(`${name} is not a plain hex token in :root`);
  const h = value.length === 4 ? value.slice(1).split("").map(c => c + c).join("") : value.slice(1);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(hex(fg)), luminance(hex(bg))].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const LARGE_OR_NON_TEXT = 3;

const pairings: [fg: string, bg: string, minimum: number, where: string][] = [
  ["--muted", "--surface", TEXT, "muted text, placeholders, footnote on white"],
  ["--muted", "--surface-tint", TEXT, "sign-in panel copy and footer"],
  ["--muted", "--surface-subtle", TEXT, "demo note text"],
  ["--muted", "--background", TEXT, "muted text on the page background"],
  ["--accent-strong", "--surface-tint", TEXT, "eyebrow and brand accent text on the sign-in panel"],
  ["--accent-strong", "--surface", TEXT, "eyebrow and brand accent text on white"],
  ["--info-text", "--info-bg", TEXT, "blue badge"],
  ["--ink-heading", "--surface-tint", TEXT, "sign-in panel heading"],
  ["--accent-soft", "--surface-tint", LARGE_OR_NON_TEXT, "sign-in panel heading highlight (large text)"],
  ["--ink-code", "--surface-subtle", TEXT, "demo credentials"],
  ["--danger-text", "--danger-bg", TEXT, "sign-in error message"],
  ["--on-accent", "--accent", TEXT, "primary button"],
  ["--on-accent", "--accent-hover", TEXT, "primary button on hover"],
  ["--focus-ring", "--surface", LARGE_OR_NON_TEXT, "focus ring on white"],
  ["--focus-ring", "--surface-tint", LARGE_OR_NON_TEXT, "focus ring on the sign-in panel"],
];

describe("palette contrast (WCAG 2.2 AA)", () => {
  it.each(pairings)("%s on %s meets %s:1 (%s)", (fg, bg, minimum) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(minimum);
  });
});
