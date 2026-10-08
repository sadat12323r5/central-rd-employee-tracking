import { existsSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Service-role client for e2e setup/teardown. Credentials come from the environment or .env.local. */
export function serviceClient(): SupabaseClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/DEPLOYMENT.md).");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
