// Demo seed: creates one real Staff account for a fictional seeded employee through
// accounts-store.create() (the AD-6 single account-creation path), which also links
// employees.auth_user_id. Not a runtime route. Run with `npm run db:seed-demo-staff`.
// Reads SEED_DEMO_STAFF_EMAIL (a seeded employee's primary email), SEED_DEMO_STAFF_PASSWORD,
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or .env.local.
// Never prints the password or keys; prints only the email.
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type * as AccountsModule from "../src/server/accounts-store";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const email = process.env.SEED_DEMO_STAFF_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_DEMO_STAFF_PASSWORD;
if (!email) fail("SEED_DEMO_STAFF_EMAIL must be set to a seeded employee's primary email address.");
if (!password) fail("SEED_DEMO_STAFF_PASSWORD must be set (at least 12 characters).");
if (password.length < 12) fail("SEED_DEMO_STAFF_PASSWORD must be at least 12 characters.");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see docs/DEPLOYMENT.md).");

// Loaded by URL so Node runs the TypeScript module directly while tsc still sees a plain module path above.
const storeUrl = new URL("../src/server/accounts-store.ts", import.meta.url).href;
const { createAccountsStore, AccountExistsError, AccountValidationError, AccountsUnavailableError } =
  (await import(storeUrl)) as typeof AccountsModule;

const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let lookup: { data: { employee_id: string; auth_user_id: string | null } | null; error: unknown };
try {
  lookup = await service.from("employees").select("employee_id,auth_user_id").eq("email", email).maybeSingle();
} catch {
  fail("Supabase is unavailable; nothing was created. Try again shortly.");
}
if (lookup.error) fail("Supabase is unavailable; nothing was created. Try again shortly.");
if (!lookup.data) fail("No seeded employee has SEED_DEMO_STAFF_EMAIL as their email; nothing was created. Run `npm run db:seed` first.");
if (lookup.data.auth_user_id) {
  console.log(`Employee ${email} already has an account; nothing was created.`);
  process.exit(0);
}

try {
  const account = await createAccountsStore(() => service).create({ role: "staff", employeeId: lookup.data.employee_id, password });
  console.log(`Created Staff account ${account.email}.`);
} catch (error) {
  // The pre-check found the employee unlinked, so the email belongs to another auth user (e.g. an Administrator).
  if (error instanceof AccountExistsError) fail("An account with SEED_DEMO_STAFF_EMAIL already exists but is not linked to this employee; nothing was created.");
  if (error instanceof AccountValidationError) fail(`Invalid ${error.fields.map(f => (f === "password" ? "SEED_DEMO_STAFF_PASSWORD" : "SEED_DEMO_STAFF_EMAIL")).join(", ")}; nothing was created.`);
  if (error instanceof AccountsUnavailableError) fail("Supabase is unavailable; nothing was created. Try again shortly.");
  fail(`Seeding failed: ${error instanceof Error ? error.name : "unknown error"}.`);
}
