// Idempotent seed: upserts the fixture's basic employee fields into the Supabase `employees` table
// with the service-role client. Nested profile data stays in the fixture (read by employees-store).
// Run with `npm run db:seed`. Credentials come from the environment or .env.local and are never printed.
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Employee } from "../src/data/employees";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see docs/DEPLOYMENT.md).");
  process.exit(1);
}

// Loaded by URL so Node runs the fixture directly while tsc still sees a plain module path above.
const fixtureUrl = new URL("../src/data/employees.ts", import.meta.url).href;
const { employees } = (await import(fixtureUrl)) as { employees: Employee[] };

const rows = employees.map(e => ({
  employee_id: e.id, name: e.name, title: e.title, team: e.team, employment_type: e.type,
  email: e.email.toLowerCase(), joined_on: e.joined, manager: e.manager, office: e.location,
  status: e.status, initials: e.initials, avatar_color: e.color, summary: e.summary,
}));

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await supabase.from("employees").upsert(rows, { onConflict: "employee_id" }).select("employee_id");
if (error) {
  console.error(`Seeding failed: ${error.message}`);
  process.exit(1);
}
console.log(`Upserted ${data?.length ?? 0} employees.`);
