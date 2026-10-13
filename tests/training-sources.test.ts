import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Story 3.2 source rules, checked by scanning src/:
// - nothing reads the fixture (`src/data/employees.ts`) for training at runtime: neither training-store
//   nor lms-client imports it (it is seed-only for training);
// - every LMS call goes through lms-client's contract, and only training-store imports lms-client.
const root = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

/** Every module specifier a file imports or re-exports (static, dynamic and require). */
function importsOf(path: string): string[] {
  const code = readFileSync(path, "utf8");
  const specifiers = [
    ...code.matchAll(/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g),
    ...code.matchAll(/\bimport\s*["'`]([^"'`]+)["'`]/g),
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
  ];
  return specifiers.map(m => m[1]);
}

const isFixture = (spec: string) => /(^|\/)data\/employees(\.ts)?$/.test(spec);
const isLmsClient = (spec: string) => /(^|\/)lms-client(\.ts)?$/.test(spec);

describe("training sources", () => {
  const files = sources(root);

  it("finds the modules it checks", () => {
    const names = files.map(f => relative(root, f));
    expect(names).toContain(join("server", "training-store.ts"));
    expect(names).toContain(join("server", "lms-client.ts"));
  });

  it("training-store and lms-client never import the fixture", () => {
    for (const file of ["training-store.ts", "lms-client.ts"]) {
      expect(importsOf(join(root, "server", file)).filter(isFixture)).toEqual([]);
    }
  });

  it("only training-store imports lms-client", () => {
    const importers = files.filter(f => importsOf(f).some(isLmsClient)).map(f => relative(root, f));
    expect(importers).toEqual([join("server", "training-store.ts")]);
  });
});
