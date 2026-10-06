import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Server-only. SUPABASE_SERVICE_ROLE_KEY bypasses RLS, so this module must never be imported
// from a client component; the key has no NEXT_PUBLIC_ prefix and is never sent to the browser.
// The service-role client is used at runtime only for the interim staff reads and the pre-session
// staff sign-in lookup (see employees-store.ts) until Story 1.3 gives staff Supabase accounts.
// Administrator reads use getUserClient(), which carries the signed-in user's JWT, so RLS applies.

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

/**
 * A per-request client using the anon key and the request's Supabase auth cookies, so every
 * query runs as the signed-in user and RLS is enforced. Create one per request; never cache it.
 * Throws if its environment variables are missing.
 */
export async function getUserClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(toSet) {
        // Server Components cannot set cookies; middleware.ts refreshes the session instead.
        // Server actions (sign-in/out) can, so the write succeeds there.
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Ignored: called from a Server Component render.
        }
      },
    },
  });
}
