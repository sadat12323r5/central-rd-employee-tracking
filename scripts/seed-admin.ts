// One-time seed: creates the first Administrator through accounts-store.create() (the AD-6 single
// account-creation path; this script is its one sanctioned non-runtime caller). Refuses to run when
// any Administrator already exists. Run with `npm run db:seed-admin`.
// Reads SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// from the environment or .env.local. Never prints the password or keys; prints only the email.
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type * as AccountsModule from "../src/server/accounts-store";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const email = process.env.SEED_ADMIN_EMAIL?.trim();
const password = process.env.SEED_ADMIN_PASSWORD;
if (!email) fail("SEED_ADMIN_EMAIL must be set to the first Administrator's email address.");
if (!password) fail("SEED_ADMIN_PASSWORD must be set (at least 12 characters).");
if (password.length < 12) fail("SEED_ADMIN_PASSWORD must be at least 12 characters.");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see docs/DEPLOYMENT.md).");

// Loaded by URL so Node runs the TypeScript module directly while tsc still sees a plain module path above.
const storeUrl = new URL("../src/server/accounts-store.ts", import.meta.url).href;
const { createAccountsStore, seedFirstAdministrator, AccountExistsError, AccountValidationError, AccountsUnavailableError } =
  (await import(storeUrl)) as typeof AccountsModule;

const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const accounts = createAccountsStore(() => service);

const variableFor: Record<string, string> = { email: "SEED_ADMIN_EMAIL", password: "SEED_ADMIN_PASSWORD" };

try {
  const account = await seedFirstAdministrator(accounts, { email, password });
  if (!account) fail("An Administrator already exists; nothing was created. Further accounts are provisioned in the app.");
  console.log(`Created Administrator ${account.email}.`);
} catch (error) {
  if (error instanceof AccountValidationError) fail(`Invalid ${error.fields.map(f => variableFor[f] ?? f).join(", ")}; nothing was created.`);
  if (error instanceof AccountExistsError) fail("An account with SEED_ADMIN_EMAIL already exists; nothing was created.");
  if (error instanceof AccountsUnavailableError) fail("Supabase Auth is unavailable; nothing was created. Try again shortly.");
  fail(`Seeding failed: ${error instanceof Error ? error.name : "unknown error"}.`);
}
