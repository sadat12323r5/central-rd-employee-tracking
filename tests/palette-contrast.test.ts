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

  // Administrator workspace (Story 6.2): hover and selected states, every badge and avatar
  // colour (including ones the demo data may not render), and text on tinted surfaces.
  ["--text-nav", "--surface", TEXT, "sidebar navigation item"],
  ["--text-nav", "--surface-hover", TEXT, "sidebar navigation item on hover"],
  ["--text-nav", "--accent-chip", TEXT, "employee count chip in an unselected navigation item"],
  ["--accent-active", "--accent-selected", TEXT, "selected navigation item"],
  ["--accent-active", "--accent-chip", TEXT, "employee count chip in the selected navigation item"],
  ["--text-label", "--surface", TEXT, "sidebar section label"],
  ["--accent-strong", "--accent-tint", TEXT, "workspace icon initials"],
  ["--muted", "--surface-subtle", TEXT, "demo card copy"],
  ["--text-pill", "--background", TEXT, "SYNTHETIC DATA pill on the translucent top bar (worst case)"],
  ["--ink-soft", "--background", TEXT, "breadcrumb current page"],
  ["--text-period", "--background", TEXT, "dashboard period label"],
  ["--text-stat", "--surface", TEXT, "stat card label"],
  ["--accent-panel-text", "--accent-panel", TEXT, "focus panel copy"],
  ["--accent-panel-foot", "--accent-panel", TEXT, "focus panel footer"],
  ["--ink", "--accent-wash", TEXT, "secondary button on hover"],
  ["--accent", "--surface", TEXT, "text buttons and radar row titles on hover"],
  ["--accent", "--background", TEXT, "back button and selected profile tab on the page background"],
  ["--accent", "--accent-selected", LARGE_OR_NON_TEXT, "profile arrow button glyph on hover"],
  ["--success-text", "--success-bg", TEXT, "green badge and avatar"],
  ["--warning-text", "--warning-bg", TEXT, "amber badge and avatar"],
  ["--critical-text", "--critical-bg", TEXT, "rose badge and avatar"],
  ["--lavender-text", "--lavender-bg", TEXT, "lavender avatar"],
  ["--mint-text", "--mint-bg", TEXT, "mint avatar"],
  ["--peach-text", "--peach-bg", TEXT, "peach avatar"],
  ["--yellow-text", "--yellow-bg", TEXT, "yellow avatar"],
  ["--text-count", "--surface-count", TEXT, "directory count"],
  ["--text-placeholder", "--surface", TEXT, "directory search placeholder"],
  ["--text-select", "--surface", TEXT, "directory filter select"],
  ["--text-table-header", "--surface-header", TEXT, "table header"],
  ["--ink", "--surface-row-hover", TEXT, "table row on hover"],
  ["--muted", "--surface-row-hover", TEXT, "secondary table text on row hover"],
  ["--text-tag", "--surface-chip", TEXT, "skill tag"],
  ["--text-table-footer", "--surface", TEXT, "table footer"],
  ["--text-footer", "--background", TEXT, "page footer"],
  ["--text-secondary", "--background", TEXT, "profile subtitle and unselected tabs"],
  ["--text-meta", "--background", TEXT, "profile location and join date"],
  ["--text-body", "--surface", TEXT, "profile body copy"],
  ["--callout-text", "--callout-bg", TEXT, "callout"],
  ["--text-fine-print", "--surface", TEXT, "fine print"],
  ["--text-empty-heading", "--surface", TEXT, "empty state heading"],
  ["--success-ink", "--success-surface", TEXT, "success notice"],
  ["--rating-fill", "--rating-track", LARGE_OR_NON_TEXT, "filled against empty skill-rating segment"],
];

describe("palette contrast (WCAG 2.2 AA)", () => {
  it.each(pairings)("%s on %s meets %s:1 (%s)", (fg, bg, minimum) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(minimum);
  });
});
