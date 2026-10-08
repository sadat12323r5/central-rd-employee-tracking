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

  it("uses the service-role client at runtime only for the Administrator-only account actions", () => {
    const runtime = sourceFiles.filter(file => file.includes(`${join(root, "src")}`) && !file.endsWith(join("server", "supabase.ts")));
    const callers = runtime.filter(file => /getServiceClient\b/.test(readFileSync(file, "utf8")));
    expect(callers.map(f => relative(root, f))).toEqual(["src/server/account-actions.ts"]);
  });

  it("has no sign-up, invite or magic-link calls and no retired demo credentials", () => {
    const pattern = /\.(inviteUserByEmail|signInWithOtp|generateLink)\s*\(|Staff23Demo|(?<!SEED_)DEMO_STAFF_PASSWORD|DEMO_SESSION_SECRET|createSession|readSession/;
    const offenders = sourceFiles.filter(file => pattern.test(readFileSync(file, "utf8")));
    expect(offenders.map(f => relative(root, f))).toEqual([]);
  });

  it("archives and restores only through accounts-store (the one rpc caller of set_employee_archived)", () => {
    const callers = sourceFiles.filter(file => /set_employee_archived/.test(readFileSync(file, "utf8")));
    expect(callers.map(f => relative(root, f))).toEqual(["src/server/accounts-store.ts"]);
    // Nothing in the app updates archived_at directly.
    const writers = sourceFiles.filter(file => /\.update\([^)]*archived_at/.test(readFileSync(file, "utf8")));
    expect(writers.map(f => relative(root, f))).toEqual([]);
  });
});
