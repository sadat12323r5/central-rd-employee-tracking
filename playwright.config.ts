import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // Creates a throwaway Administrator (E2E_ADMIN_*), two linked throwaway Staff accounts (E2E_STAFF_1_*,
  // E2E_STAFF_2_*) and an unlinked throwaway employee (E2E_STAFF_UNLINKED_*) in Supabase for the run,
  // and deletes them afterwards, so e2e never needs a real account's password.
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:3100",
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
