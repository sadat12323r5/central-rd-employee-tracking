import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only. SUPABASE_SERVICE_ROLE_KEY bypasses RLS, so this module must never be imported
// from a client component; the key has no NEXT_PUBLIC_ prefix and is never sent to the browser.
// Story 1.1 uses it at runtime only because demo sessions are not Supabase JWTs yet (see
// employees-store.ts); Story 1.2 replaces runtime reads with a per-request user client.

let client: SupabaseClient | undefined;

/** Lazily creates the service-role client. Throws if its environment variables are missing. */
export function getServiceClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
