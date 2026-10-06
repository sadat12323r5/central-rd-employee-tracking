// No self-registration, anywhere (AD-6): no sign-up/registration route or call in the app, no public
// sign-up link or wording on the sign-in page, and accounts-store.create() is the only code in src/
// or scripts/ that creates auth users.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });
}

const srcPaths = walk(join(root, "src")).map(p => relative(root, p));
const sourceFiles = [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter(p => /\.(ts|tsx|mjs|js)$/.test(p));

describe("no self-registration", () => {
  it("has no route, page or file named signup, sign-up or register under src/", () => {
    expect(srcPaths.filter(p => /sign-?up|register/i.test(p))).toEqual([]);
  });

  it("never calls auth.signUp anywhere in src/ or scripts/", () => {
    const callers = sourceFiles.filter(file => /\.signUp\s*\(/.test(readFileSync(file, "utf8")));
    expect(callers.map(f => relative(root, f))).toEqual([]);
  });

  it("offers no public sign-up or registration link or wording on the sign-in page", () => {
    // Scoped to the public sign-in page only: Administrator-only provisioning UI (Story 1.3) is allowed elsewhere.
    const login = readFileSync(join(root, "src", "components", "login.tsx"), "utf8");
    expect(login).not.toMatch(/href=["'{][^"'}]*(sign-?up|register)/i);
    expect(login).not.toMatch(/\b(sign[ -]?up|register)\b/i);
  });

  it("creates auth users only in accounts-store.create()", () => {
    const callers = sourceFiles.filter(file => /admin\s*\.\s*createUser\s*\(|\.createUser\s*\(/.test(readFileSync(file, "utf8")));
    expect(callers.map(f => relative(root, f))).toEqual(["src/server/accounts-store.ts"]);
  });
});
