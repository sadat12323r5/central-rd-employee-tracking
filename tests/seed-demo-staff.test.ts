// Offline checks of scripts/seed-demo-staff.ts: the environment is validated before any network call.
// Each run uses an empty temporary working directory (so no .env.local is loaded) and an
// unroutable Supabase URL, so these tests can never create an account. A live block (skipped without
// Supabase credentials) runs the script against a throwaway BS-9797 employee and removes it afterwards.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "seed-demo-staff.ts");
const cwd = mkdtempSync(join(tmpdir(), "seed-demo-staff-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function seed(env: Record<string, string>, inherit = false) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
    cwd, encoding: "utf8", timeout: 25_000,
    env: { ...(inherit ? process.env : { PATH: process.env.PATH ?? "" }), NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("seed-demo-staff environment checks", () => {
  it("exits non-zero naming SEED_DEMO_STAFF_EMAIL when it is missing", () => {
    const { status, output } = seed({ SEED_DEMO_STAFF_PASSWORD: "a-long-enough-password" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_DEMO_STAFF_EMAIL");
  });

  it("exits non-zero naming SEED_DEMO_STAFF_PASSWORD when it is missing", () => {
    const { status, output } = seed({ SEED_DEMO_STAFF_EMAIL: "nadia.rahman@example.com" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_DEMO_STAFF_PASSWORD");
  });

  it("exits non-zero naming SEED_DEMO_STAFF_PASSWORD when it is shorter than 12 characters, without printing it", () => {
    const { status, output } = seed({ SEED_DEMO_STAFF_EMAIL: "nadia.rahman@example.com", SEED_DEMO_STAFF_PASSWORD: "short-pw-11" });
    expect(status).not.toBe(0);
    expect(output).toContain("SEED_DEMO_STAFF_PASSWORD");
    expect(output).not.toContain("short-pw-11");
  });

  it("exits non-zero when the Supabase variables are missing", () => {
    const { status, output } = seed({
      SEED_DEMO_STAFF_EMAIL: "nadia.rahman@example.com", SEED_DEMO_STAFF_PASSWORD: "a-long-enough-password",
      NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("reports Supabase unavailable, creating nothing and printing no secrets, when it cannot be reached", () => {
    const { status, output } = seed({ SEED_DEMO_STAFF_EMAIL: "nadia.rahman@example.com", SEED_DEMO_STAFF_PASSWORD: "a-long-enough-password" });
    expect(status).not.toBe(0);
    expect(output).toMatch(/unavailable/i);
    expect(output).not.toContain("a-long-enough-password");
    expect(output).not.toContain("not-a-real-key");
  }, 30_000); // the database client retries a failed request for a few seconds before giving up
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!(url && serviceKey))("seed-demo-staff against the shared project", () => {
  const service = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : (undefined as never);
  // BS-9797 is outside the slots employees-rls (BS-9900..9998), accounts-store (BS-9999) and e2e (BS-98nn) use.
  const employeeId = "BS-9797";
  const email = `seed-demo-staff-${randomBytes(4).toString("hex")}@example.test`;
  const password = `Demo-${randomBytes(12).toString("hex")}!`;

  async function cleanUp() {
    const { data } = await service.from("employees").select("auth_user_id").eq("employee_id", employeeId).maybeSingle();
    await service.from("employees").delete().eq("employee_id", employeeId);
    if (data?.auth_user_id) await service.auth.admin.deleteUser(data.auth_user_id);
  }

  afterAll(cleanUp, 30_000);

  it("creates and links the demo Staff account once, then reports it already exists", async () => {
    await cleanUp(); // leftovers of an aborted run
    const { error: insertError } = await service.from("employees").insert({
      employee_id: employeeId, name: "Seed Demo Staff Test", title: "Test", team: "Test", employment_type: "Permanent", email,
      joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "SD", avatar_color: "mint",
      summary: "Throwaway row created by tests/seed-demo-staff.test.ts.",
    });
    expect(insertError).toBeNull();

    const live = { NEXT_PUBLIC_SUPABASE_URL: url!, SUPABASE_SERVICE_ROLE_KEY: serviceKey!, SEED_DEMO_STAFF_EMAIL: email.toUpperCase(), SEED_DEMO_STAFF_PASSWORD: password };
    const first = seed(live, true); // inherits proxy/CA settings so the child can reach Supabase
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain(`Created Staff account ${email}`);
    expect(first.output).not.toContain(password);
    expect(first.output).not.toContain(serviceKey!);

    const { data: row } = await service.from("employees").select("auth_user_id").eq("employee_id", employeeId).single();
    expect(row?.auth_user_id).toBeTruthy();
    const { data: user } = await service.auth.admin.getUserById(row!.auth_user_id);
    expect(user.user?.app_metadata).toMatchObject({ role: "staff", employee_id: employeeId });

    const second = seed(live, true);
    expect(second.status).toBe(0);
    expect(second.output).toContain("already has an account");
    const { data: after } = await service.from("employees").select("auth_user_id").eq("employee_id", employeeId).single();
    expect(after?.auth_user_id).toBe(row!.auth_user_id);
  }, 60_000);
});
