import { createHmac } from "node:crypto";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore, redirectMock } = vi.hoisted(() => {
  // A known HMAC secret, so the test can sign a legacy admin token exactly as auth.ts would verify it.
  process.env.DEMO_SESSION_SECRET = "auth-test-secret";
  const store = new Map<string, string>();
  return {
    cookieStore: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
      getAll: () => [...store].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
      __store: store,
    },
    redirectMock: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

// Staff sign-in looks employees up through employees-store; keep these tests off the network.
const { findByEmail } = vi.hoisted(() => ({ findByEmail: vi.fn() }));
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { findByEmail, listFor: vi.fn(), getFor: vi.fn() },
}));

// A stand-in for Supabase Auth: accounts by email, and the auth cookie it would set on sign-in.
type FakeUser = { id: string; password: string; app_metadata: Record<string, unknown>; last_sign_in_at?: string };
const AUTH_COOKIE = "sb-test-auth-token";
const supabase = {
  users: new Map<string, FakeUser>(),
  /** Per signed-in email: the `amr` password timestamp (seconds) in that session's access token. */
  amr: new Map<string, number>(),
  mode: "ok" as "ok" | "network" | "outage" | "rate-limited" | "unconfigured",
  signOuts: 0,
};
const fakeJwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const fakeAuth = {
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
vi.mock("../src/server/supabase", () => ({
  getUserClient: async () => {
    if (supabase.mode === "unconfigured") throw new Error("Supabase is not configured");
    return { auth: fakeAuth };
  },
  getServiceClient: () => {
    throw new Error("auth must not use the service-role client");
  },
}));

const { isSignedIn, signIn, signOut, getSession } = await import("../src/server/auth");
const { EmployeesUnavailableError } = await import("../src/server/employees-store");
const { employees } = await import("@/data/employees");
const staffPassword = process.env.DEMO_STAFF_PASSWORD || "Staff23Demo!";

const adminEmail = "lnd.manager@example.test";
const adminPassword = "a-long-admin-passphrase";
const INCORRECT = "The email or password is incorrect. Please try again.";
const UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again shortly.";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function reset() {
  cookieStore.__store.clear();
  redirectMock.mockClear();
  findByEmail.mockReset();
  findByEmail.mockResolvedValue(null);
  supabase.users.clear();
  supabase.amr.clear();
  supabase.mode = "ok";
  supabase.signOuts = 0;
  supabase.users.set(adminEmail, { id: "admin-1", password: adminPassword, app_metadata: { role: "admin" } });
  supabase.users.set("staff.user@example.test", { id: "staff-1", password: "a-long-staff-passphrase", app_metadata: { role: "staff" } });
  supabase.users.set("no.role@example.test", { id: "none-1", password: "a-long-other-passphrase", app_metadata: {} });
}

describe("Administrator sign-in with a Supabase account", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reports signed out when no session cookie is present", async () => {
    expect(await isSignedIn()).toBe(false);
    expect(await getSession()).toBeNull();
  });

  it("signs an admin in, matching email case-insensitively, and redirects home", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail.toUpperCase(), password: adminPassword }));
    expect(cookieStore.get(AUTH_COOKIE)).toBeDefined();
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(await getSession()).toEqual({ role: "admin" });
    expect(await isSignedIn()).toBe(true);
  });

  it("rejects a wrong password with the generic message and no cookie", async () => {
    const result = await signIn({ error: "" }, formData({ email: adminEmail, password: "wrong-password" }));
    expect(result).toEqual({ error: INCORRECT });
    expect(cookieStore.__store.size).toBe(0);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("rejects an unknown email with the same generic message", async () => {
    const result = await signIn({ error: "" }, formData({ email: "nobody@example.test", password: adminPassword }));
    expect(result).toEqual({ error: INCORRECT });
    expect(await getSession()).toBeNull();
  });

  it.each([["staff.user@example.test", "a-long-staff-passphrase"], ["no.role@example.test", "a-long-other-passphrase"]])(
    "rejects a valid Supabase user without the admin role (%s) and signs that session out",
    async (email, password) => {
      const result = await signIn({ error: "" }, formData({ email, password }));
      expect(result).toEqual({ error: INCORRECT });
      expect(supabase.signOuts).toBe(1);
      expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
      expect(redirectMock).not.toHaveBeenCalled();
      expect(await getSession()).toBeNull();
    },
  );

  it("rejects the retired demo credentials (manager@example.com / Brain23Demo!)", async () => {
    const result = await signIn({ error: "" }, formData({ email: "manager@example.com", password: "Brain23Demo!" }));
    expect(result).toEqual({ error: INCORRECT });
    expect(await getSession()).toBeNull();
  });

  it.each(["network", "outage", "rate-limited", "unconfigured"] as const)("reports sign-in unavailable when Supabase is %s", async mode => {
    supabase.mode = mode;
    const result = await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    expect(result).toEqual({ error: UNAVAILABLE });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    // Logged without values: never the email or password.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(adminPassword);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(adminEmail);
  });

  it("treats an admin session older than 8 hours as signed out", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000 + 59 * 60 * 1000);
    expect(await getSession()).toEqual({ role: "admin" });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("ends a session whose own password sign-in is over 8 hours old, even if the account signed in recently elsewhere", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    // A fresh last_sign_in_at (another device), but this session's token says it signed in 9 hours ago.
    supabase.amr.set(adminEmail, Math.floor(Date.now() / 1000) - 9 * 60 * 60);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("ends a session whose token carries no password sign-in time", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    supabase.amr.delete(adminEmail);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
  });

  it("drops an existing staff HMAC session when an admin signs in", async () => {
    const employee = employees.find(e => e.id === "BS-1003")!;
    findByEmail.mockResolvedValue(employee);
    await signIn({ error: "" }, formData({ email: employee.email, password: staffPassword }));
    expect(cookieStore.get("bs23-demo-session")).toBeDefined();

    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    expect(cookieStore.get("bs23-demo-session")).toBeUndefined();
    expect(await getSession()).toEqual({ role: "admin" });
  });

  it("does not trust an auth cookie Supabase does not recognise", async () => {
    cookieStore.set(AUTH_COOKIE, "forged@example.test");
    expect(await getSession()).toBeNull();
  });

  it("treats an old HMAC admin token as signed out", async () => {
    const payload = Buffer.from(JSON.stringify({ role: "admin", expires: Date.now() + 60_000 })).toString("base64url");
    const token = `${payload}.${createHmac("sha256", "auth-test-secret").update(payload).digest("base64url")}`;
    cookieStore.set("bs23-demo-session", token);
    expect(await getSession()).toBeNull();
  });

  it("signs out by ending the Supabase session and redirecting home", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    expect(await isSignedIn()).toBe(true);
    redirectMock.mockClear();

    await signOut();
    expect(supabase.signOuts).toBe(1);
    expect(await isSignedIn()).toBe(false);
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});

describe("demo staff auth through employees-store (unchanged until Story 1.3)", () => {
  beforeEach(reset);

  it("signs a staff member in as the employee the store finds by email", async () => {
    const employee = employees.find(e => e.id === "BS-1003")!;
    findByEmail.mockResolvedValue(employee);
    await signIn({ error: "" }, formData({ email: employee.email.toUpperCase(), password: staffPassword }));
    expect(findByEmail).toHaveBeenCalledWith(employee.email.toLowerCase());
    expect(await getSession()).toEqual({ role: "staff", employeeId: "BS-1003" });
    expect(await isSignedIn()).toBe(false);
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("ends an existing Administrator session when staff sign in in the same browser", async () => {
    await signIn({ error: "" }, formData({ email: adminEmail, password: adminPassword }));
    expect(await getSession()).toEqual({ role: "admin" });

    const employee = employees.find(e => e.id === "BS-1003")!;
    findByEmail.mockResolvedValue(employee);
    await signIn({ error: "" }, formData({ email: employee.email, password: staffPassword }));
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
    expect(await getSession()).toEqual({ role: "staff", employeeId: "BS-1003" });
    expect(await isSignedIn()).toBe(false);
  });

  it("rejects an email the store does not know with the generic message", async () => {
    findByEmail.mockResolvedValue(null);
    const result = await signIn({ error: "" }, formData({ email: "nobody@example.com", password: staffPassword }));
    expect(result).toEqual({ error: INCORRECT });
    expect(await getSession()).toBeNull();
  });

  it("rejects a wrong staff password without querying the store", async () => {
    const result = await signIn({ error: "" }, formData({ email: "meera.das@example.com", password: "wrong-password" }));
    expect(result).toEqual({ error: INCORRECT });
    expect(findByEmail).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("reports sign-in as unavailable, without a session, when the store is unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findByEmail.mockRejectedValue(new EmployeesUnavailableError());
    const result = await signIn({ error: "" }, formData({ email: "nadia.rahman@example.com", password: staffPassword }));
    expect(result).toEqual({ error: UNAVAILABLE });
    expect(await getSession()).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
