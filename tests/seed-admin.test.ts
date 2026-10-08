// Offline checks of scripts/seed-admin.ts: the environment is validated before any network call.
// Each run uses an empty temporary working directory (so no .env.local is loaded) and an
// unroutable Supabase URL, so these tests can never create an account.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "seed-admin.ts");
const cwd = mkdtempSync(join(tmpdir(), "seed-admin-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function seed(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
    cwd, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("seed-admin environment checks", () => {
  it("exits non-zero naming SEED_ADMIN_EMAIL when it is missing", () => {
    const { status, output } = seed({ SEED_ADMIN_PASSWORD: "a-long-enough-password" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_ADMIN_EMAIL");
  });

  it("exits non-zero naming SEED_ADMIN_PASSWORD when it is missing", () => {
    const { status, output } = seed({ SEED_ADMIN_EMAIL: "first.admin@example.test" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_ADMIN_PASSWORD");
  });

  it("exits non-zero naming SEED_ADMIN_PASSWORD when it is shorter than 12 characters, without printing it", () => {
    const { status, output } = seed({ SEED_ADMIN_EMAIL: "first.admin@example.test", SEED_ADMIN_PASSWORD: "short-pw-11" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_ADMIN_PASSWORD");
    expect(output).not.toContain("short-pw-11");
  });

  it("reports Supabase unavailable, creating nothing and printing no secrets, when Auth cannot be reached", () => {
    const { status, output } = seed({ SEED_ADMIN_EMAIL: "first.admin@example.test", SEED_ADMIN_PASSWORD: "a-long-enough-password" });
    expect(status).not.toBe(0);
    expect(output).toMatch(/unavailable/i);
    expect(output).not.toContain("a-long-enough-password");
    expect(output).not.toContain("not-a-real-key");
  });
});
