// Single writer (AD-2, Story 4.8): employees-store.ts is the only file under src/ that calls the
// `transfer_employee` function, and nothing under src/ writes `employees.department_id` directly, so the
// department only changes through the transfer function (authority, open-assignment check, audit row).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const STORE = "src/server/employees-store.ts";
const BACKFILL_STORE = "src/server/backfilled-project-store.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(join(root, "src")).filter(p => /\.(ts|tsx|mjs|js)$/.test(p))
  .map(p => ({ file: relative(root, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }));

/** Code only: comments may name the function or the column freely. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A `.from("employees")` chain that reaches a write method (the chain may span lines). */
const WRITES_EMPLOYEES = /\.from\(\s*["'`]employees["'`]\s*\)[\s\S]{0,400}?\.(insert|update|upsert)\s*\(/;

describe("transfer single writer", () => {
  it("finds the store and the source tree", () => {
    expect(sources.some(s => s.file === STORE)).toBe(true);
    expect(sources.length).toBeGreaterThan(10);
  });

  it("calls transfer_employee only from employees-store.ts", () => {
    expect(sources.filter(s => /["'`]transfer_employee["'`]/.test(code(s.text))).map(s => s.file)).toEqual([STORE]);
  });

  it("never writes employees.department_id directly anywhere under src/", () => {
    // No write chain on the employees table carries department_id.
    const chains = sources.flatMap(s => {
      const text = code(s.text);
      return [...text.matchAll(new RegExp(WRITES_EMPLOYEES.source, "g"))]
        .map(m => ({ file: s.file, call: text.slice(m.index, m.index + m[0].length + 200) }));
    });
    expect(chains.length).toBeGreaterThan(0); // accounts-store links auth_user_id this way
    expect(chains.filter(c => /\bdepartment_id\b/.test(c.call)).map(c => c.file)).toEqual([]);
    // The only write literals naming a department_id column belong to stores of other tables, each bound to
    // its own table (`const TABLE = "..."`) and naming the employees table only in reads.
    const literal = /\.(insert|update|upsert)\(\s*\{[^}]*\bdepartment_id\s*:/;
    const ownTables: Record<string, string> = {
      "src/server/assignments-store.ts": "assignments",
      "src/server/assignment-evaluations-store.ts": "assignment_evaluations",
      [BACKFILL_STORE]: "backfilled_projects",
    };
    expect(sources.filter(s => literal.test(code(s.text))).map(s => s.file).sort()).toEqual(Object.keys(ownTables).sort());
    for (const [file, table] of Object.entries(ownTables)) {
      const text = code(sources.find(s => s.file === file)!.text);
      expect(text).toContain(`const TABLE = "${table}";`);
      const mentions = text.match(/["'`]employees["'`]/g) ?? [];
      const reads = text.match(/\bread<[^>]*>\(\s*["'`]employees["'`]/g) ?? [];
      expect(reads).toHaveLength(mentions.length);
    }
    // The detectors do catch a write (guards against the regexes silently matching nothing).
    expect(WRITES_EMPLOYEES.test(`client.from("employees")\n  .update({ department_id: "x" })`)).toBe(true);
    expect(literal.test(`t.update({ department_id: to })`)).toBe(true);
    expect(literal.test(`t.update({ parent_department_id: to })`)).toBe(false);
  });
});
