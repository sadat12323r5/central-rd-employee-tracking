// Single writer (AD-2, Story 4.7): backfilled-project-store.ts is the only file under src/ that writes
// the `backfilled_projects` table (insert, update, upsert or delete) or names it at all.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const STORE = "src/server/backfilled-project-store.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(join(root, "src")).filter(p => /\.(ts|tsx|mjs|js)$/.test(p))
  .map(p => ({ file: relative(root, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }));

/** The source without comments (documentation may name the table freely). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A `.from("backfilled_projects")` chain that reaches a write method (the chain may span lines). */
const WRITES = /\.from\(\s*["'`]backfilled_projects["'`]\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;

describe("backfilled projects single writer", () => {
  it("finds the store and the source tree", () => {
    expect(sources.some(s => s.file === STORE)).toBe(true);
    expect(sources.length).toBeGreaterThan(10);
  });

  it("writes the backfilled_projects table only in backfilled-project-store.ts", () => {
    expect(sources.filter(s => s.file !== STORE && WRITES.test(s.text)).map(s => s.file)).toEqual([]);
    // The detector does catch a write chain (guards against the regex silently matching nothing).
    expect(WRITES.test(`client.from("backfilled_projects")\n  .update({ status: "withdrawn" })`)).toBe(true);
  });

  it("is the only module that names the backfilled_projects table at all", () => {
    expect(sources.filter(s => /["'`]backfilled_projects["'`]/.test(code(s.text))).map(s => s.file)).toEqual([STORE]);
  });

  it("never exposes a delete on the store", () => {
    const text = sources.find(s => s.file === STORE)!.text;
    expect(text).not.toMatch(/\.delete\s*\(/);
  });
});

describe("department options", () => {
  it("is read only through the department_options function, by the backfilled-project store", () => {
    const callers = sources.filter(s => /["'`]department_options["'`]/.test(code(s.text))).map(s => s.file);
    expect(callers).toEqual([STORE]);
  });
});
