// Offline stand-ins shared by the auth-related unit tests: a Next.js cookie store and a fake
// Supabase Auth (accounts by email, the auth cookie it sets on sign-in, and each session's `amr`
// password sign-in time). Wire them up from a test file with:
//   vi.mock("next/headers", async () => (await import("./support/fake-auth")).headersModule());
//   vi.mock("next/navigation", async () => (await import("./support/fake-auth")).navigationModule());
//   vi.mock("../src/server/supabase", async () => (await import("./support/fake-auth")).supabaseModule());
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { vi } from "vitest";

const store = new Map<string, string>();
export const cookieStore = {
  get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
  getAll: () => [...store].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => {
    store.set(name, value);
  },
  delete: (name: string) => {
    store.delete(name);
  },
  __store: store,
};

export const redirectMock = vi.fn();

export type FakeUser = { id: string; password: string; app_metadata: Record<string, unknown>; last_sign_in_at?: string };
export const AUTH_COOKIE = "sb-test-auth-token";
export const LEGACY_COOKIE = "bs23-demo-session";

export const supabase = {
  users: new Map<string, FakeUser>(),
  /** Per signed-in email: the `amr` password timestamp (seconds) in that session's access token. */
  amr: new Map<string, number>(),
  mode: "ok" as "ok" | "network" | "outage" | "rate-limited" | "unconfigured",
  signOuts: 0,
  /** Counts getServiceClient() calls; auth and employee reads must never make one. */
  serviceClientCalls: 0,
};

const fakeJwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

export const fakeAuth = {
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    if (supabase.mode === "network") return { data: { user: null, session: null }, error: new AuthRetryableFetchError("fetch failed", 0) };
    if (supabase.mode === "outage") return { data: { user: null, session: null }, error: new AuthApiError("upstream error", 503, "unexpected_failure") };
    if (supabase.mode === "rate-limited") {
      return { data: { user: null, session: null }, error: new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit") };
    }
    const user = supabase.users.get(email);
    if (!user || user.password !== password) {
      return { data: { user: null, session: null }, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") };
    }
    user.last_sign_in_at = new Date().toISOString();
    supabase.amr.set(email, Math.floor(Date.now() / 1000));
    cookieStore.set(AUTH_COOKIE, email);
    return { data: { user: { ...user, email }, session: {} }, error: null };
  },
  async getUser() {
    const email = cookieStore.get(AUTH_COOKIE)?.value;
    const user = email ? supabase.users.get(email) : undefined;
    if (!user) return { data: { user: null }, error: new AuthApiError("Auth session missing!", 400, "session_not_found") };
    return { data: { user: { ...user, email } }, error: null };
  },
  async getSession() {
    // Read only after getUser() has validated the same session; returns its access token.
    const email = cookieStore.get(AUTH_COOKIE)?.value;
    if (!email) return { data: { session: null }, error: null };
    const timestamp = supabase.amr.get(email);
    const amr = timestamp === undefined ? [] : [{ method: "password", timestamp }];
    return { data: { session: { access_token: fakeJwt({ sub: email, amr }) } }, error: null };
  },
  async signOut() {
    supabase.signOuts++;
    cookieStore.delete(AUTH_COOKIE);
    return { error: null };
  },
};

export const headersModule = () => ({ cookies: () => Promise.resolve(cookieStore) });
export const navigationModule = () => ({ redirect: redirectMock });
export const supabaseModule = () => ({
  getUserClient: async () => {
    if (supabase.mode === "unconfigured") throw new Error("Supabase is not configured");
    return { auth: fakeAuth };
  },
  getServiceClient: () => {
    supabase.serviceClientCalls++;
    throw new Error("the service-role client is not available in this test");
  },
});

export const ADMIN = { email: "lnd.manager@example.test", password: "a-long-admin-passphrase" };
export const STAFF = { email: "meera.das@example.com", password: "a-long-staff-passphrase", employeeId: "BS-1003" };

/** Clears cookies and redirects, and restores the default accounts: an admin, a linked staff member and a role-less user. */
export function resetAuth() {
  store.clear();
  redirectMock.mockClear();
  supabase.users.clear();
  supabase.amr.clear();
  supabase.mode = "ok";
  supabase.signOuts = 0;
  supabase.serviceClientCalls = 0;
  supabase.users.set(ADMIN.email, { id: "admin-1", password: ADMIN.password, app_metadata: { role: "admin" } });
  supabase.users.set(STAFF.email, { id: "staff-1", password: STAFF.password, app_metadata: { role: "staff", employee_id: STAFF.employeeId } });
  supabase.users.set("no.role@example.test", { id: "none-1", password: "a-long-other-passphrase", app_metadata: {} });
}

export function formData(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(key, v);
  return data;
}
