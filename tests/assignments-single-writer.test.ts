// Single writer (AD-2, Story 4.5): assignments-store.ts is the only file under src/ that mentions the
// `completion_date` column or writes to the `assignments` table (insert, update, upsert or delete), so
// only it can set an assignment's status or completion date.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const STORE = "src/server/assignments-store.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(join(root, "src")).filter(p => /\.(ts|tsx|mjs|js)$/.test(p))
  .map(p => ({ file: relative(root, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }));

/** A `.from("assignments")` chain that reaches a write method (the chain may span lines). */
const WRITES_ASSIGNMENTS = /\.from\(\s*["'`]assignments["'`]\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;

describe("assignments single writer", () => {
  it("finds the store and the source tree", () => {
    expect(sources.some(s => s.file === STORE)).toBe(true);
    expect(sources.length).toBeGreaterThan(10);
  });

  it("mentions completion_date only in assignments-store.ts", () => {
    expect(sources.filter(s => s.text.includes("completion_date")).map(s => s.file)).toEqual([STORE]);
  });

  it("writes the assignments table (status included) only in assignments-store.ts", () => {
    expect(sources.filter(s => s.file !== STORE && WRITES_ASSIGNMENTS.test(s.text)).map(s => s.file)).toEqual([]);
    // The detector does catch a write chain (guards against the regex silently matching nothing).
    expect(WRITES_ASSIGNMENTS.test(`client.from("assignments")\n  .update({ status: "closed" })`)).toBe(true);
  });

  it("is the only module that names the assignments table at all", () => {
    expect(sources.filter(s => /from\(\s*["'`]assignments["'`]|TABLE\s*=\s*["'`]assignments["'`]/.test(s.text)).map(s => s.file)).toEqual([STORE]);
  });
});
