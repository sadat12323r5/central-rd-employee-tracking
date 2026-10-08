import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, AUTH_COOKIE, cookieStore, formData, LEGACY_COOKIE, redirectMock, resetAuth, STAFF, supabase } from "./support/fake-auth";

vi.mock("next/headers", async () => (await import("./support/fake-auth")).headersModule());
vi.mock("next/navigation", async () => (await import("./support/fake-auth")).navigationModule());
vi.mock("../src/server/supabase", async () => (await import("./support/fake-auth")).supabaseModule());

// Staff sign-in and every staff session check confirm the linked, unarchived employee row through
// employees-store (the JWT client); keep it offline. `archived` stands in for the row's archived_at.
const { isActive, archived } = vi.hoisted(() => ({ isActive: vi.fn(), archived: new Set<string>() }));
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { listFor: vi.fn(), getFor: vi.fn(), isActive },
}));

const { isSignedIn, signIn, signOut, getSession, getActor } = await import("../src/server/auth");
const { EmployeesUnavailableError } = await import("../src/server/employees-store");

const INCORRECT = "The email or password is incorrect. Please try again.";
const UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again shortly.";
function reset() {
  resetAuth();
  archived.clear();
  isActive.mockReset();
  isActive.mockImplementation(async (session: { employeeId: string }) => session.employeeId === STAFF.employeeId && !archived.has(session.employeeId));
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
    await signIn({ error: "" }, formData({ email: ADMIN.email.toUpperCase(), password: ADMIN.password }));
    expect(cookieStore.get(AUTH_COOKIE)).toBeDefined();
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(await getSession()).toEqual({ role: "admin" });
    expect(await isSignedIn()).toBe(true);
    expect(isActive).not.toHaveBeenCalled();
  });

  it("rejects a wrong password with the generic message and no cookie", async () => {
    const result = await signIn({ error: "" }, formData({ email: ADMIN.email, password: "wrong-password" }));
    expect(result).toEqual({ error: INCORRECT });
    expect(cookieStore.__store.size).toBe(0);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("rejects an unknown email with the same generic message", async () => {
    const result = await signIn({ error: "" }, formData({ email: "nobody@example.test", password: ADMIN.password }));
    expect(result).toEqual({ error: INCORRECT });
    expect(await getSession()).toBeNull();
  });

  it("rejects a valid Supabase user without a role and signs that session out", async () => {
    const result = await signIn({ error: "" }, formData({ email: "no.role@example.test", password: "a-long-other-passphrase" }));
    expect(result).toEqual({ error: INCORRECT });
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it.each([{ role: "owner" }, { role: "manager" }, { role: "staff" }, { role: "staff", employee_id: "../admin" }, { role: "staff", employee_id: 1003 }])(
    "rejects a user whose app_metadata is %j and signs that session out",
    async app_metadata => {
      supabase.users.set("odd@example.test", { id: "odd-1", password: "a-long-odd-passphrase", app_metadata });
      const result = await signIn({ error: "" }, formData({ email: "odd@example.test", password: "a-long-odd-passphrase" }));
      expect(result).toEqual({ error: INCORRECT });
      expect(supabase.signOuts).toBe(1);
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
    const result = await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    expect(result).toEqual({ error: UNAVAILABLE });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    // Logged without values: never the email or password.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(ADMIN.password);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(ADMIN.email);
  });

  it("treats an admin session older than 8 hours as signed out", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000 + 59 * 60 * 1000);
    expect(await getSession()).toEqual({ role: "admin" });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("ends a session whose own password sign-in is over 8 hours old, even if the account signed in recently elsewhere", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    // A fresh last_sign_in_at (another device), but this session's token says it signed in 9 hours ago.
    supabase.amr.set(ADMIN.email, Math.floor(Date.now() / 1000) - 9 * 60 * 60);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("ends a session whose token carries no password sign-in time", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    supabase.amr.delete(ADMIN.email);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
  });

  it("does not trust an auth cookie Supabase does not recognise", async () => {
    cookieStore.set(AUTH_COOKIE, "forged@example.test");
    expect(await getSession()).toBeNull();
  });

  it("signs out by ending the Supabase session, deleting the legacy cookie and redirecting home", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    expect(await isSignedIn()).toBe(true);
    redirectMock.mockClear();
    cookieStore.set(LEGACY_COOKIE, "old-token");

    await signOut();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(LEGACY_COOKIE)).toBeUndefined();
    expect(await isSignedIn()).toBe(false);
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("never uses the service-role client to sign in or read the session", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    await getSession();
    expect(supabase.serviceClientCalls).toBe(0);
  });
});

describe("Staff sign-in with a provisioned Supabase account", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("signs a staff member in as the employee in their app_metadata, after confirming the row through RLS", async () => {
    await signIn({ error: "" }, formData({ email: STAFF.email.toUpperCase(), password: STAFF.password }));
    expect(isActive).toHaveBeenCalledWith({ role: "staff", employeeId: STAFF.employeeId });
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    expect(await isSignedIn()).toBe(false);
  });

  it("rejects a staff user whose linked employee row is not visible, signing them out", async () => {
    isActive.mockResolvedValue(false);
    const result = await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(result).toEqual({ error: INCORRECT });
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("reports sign-in unavailable, signed out, when employee records cannot be read", async () => {
    isActive.mockRejectedValue(new EmployeesUnavailableError());
    const result = await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(result).toEqual({ error: UNAVAILABLE });
    expect(supabase.signOuts).toBe(1);
    expect(await getSession()).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(STAFF.password);
  });

  it.each(["meera.das@example.com", "nadia.rahman@example.com", "rafi.ahmed@example.com"])(
    "rejects the retired shared demo password for %s with the generic message",
    async email => {
      const result = await signIn({ error: "" }, formData({ email, password: "Staff23Demo!" }));
      expect(result).toEqual({ error: INCORRECT });
      expect(cookieStore.__store.size).toBe(0);
      expect(await getSession()).toBeNull();
      expect(isActive).not.toHaveBeenCalled();
    },
  );

  it("ignores a legacy HMAC demo cookie, even a validly signed one", async () => {
    const payload = Buffer.from(JSON.stringify({ role: "staff", employeeId: "BS-1003", expires: Date.now() + 60_000 })).toString("base64url");
    cookieStore.set(LEGACY_COOKIE, `${payload}.${createHmac("sha256", "any-secret").update(payload).digest("base64url")}`);
    expect(await getSession()).toBeNull();
    const admin = Buffer.from(JSON.stringify({ role: "admin", expires: Date.now() + 60_000 })).toString("base64url");
    cookieStore.set(LEGACY_COOKIE, `${admin}.${createHmac("sha256", "any-secret").update(admin).digest("base64url")}`);
    expect(await getSession()).toBeNull();
  });

  it("deletes the legacy demo cookie when anyone signs in", async () => {
    cookieStore.set(LEGACY_COOKIE, "old-token");
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(cookieStore.get(LEGACY_COOKIE)).toBeUndefined();
  });

  it("replaces an Administrator session when staff sign in in the same browser", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    expect(await getSession()).toEqual({ role: "admin" });
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    expect(await isSignedIn()).toBe(false);
  });
});

describe("archived Staff accounts (Story 1.4)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("ends a live staff session on the next request once the employee is archived", async () => {
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    archived.add(STAFF.employeeId);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("returns no session but keeps the staff member signed in when the archive check cannot read the row", async () => {
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    isActive.mockRejectedValue(new EmployeesUnavailableError());
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(0);
    expect(cookieStore.get(AUTH_COOKIE)).toBeDefined();
    isActive.mockReset();
    isActive.mockResolvedValue(true);
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
  });

  it("rejects an archived staff member's correct password with the generic message, signed out", async () => {
    archived.add(STAFF.employeeId);
    const result = await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(result).toEqual({ error: INCORRECT });
    expect(supabase.signOuts).toBe(1);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("lets a restored staff member sign in again", async () => {
    archived.add(STAFF.employeeId);
    expect(await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }))).toEqual({ error: INCORRECT });
    archived.delete(STAFF.employeeId);
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
  });

  it("never checks an Administrator session against employee rows", async () => {
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    expect(await getSession()).toEqual({ role: "admin" });
    expect(isActive).not.toHaveBeenCalled();
  });

  it("getActor returns the identity with the validated Supabase user id", async () => {
    expect(await getActor()).toBeNull();
    await signIn({ error: "" }, formData({ email: ADMIN.email, password: ADMIN.password }));
    expect(await getActor()).toEqual({ identity: { role: "admin" }, userId: "admin-1" });
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    expect(await getActor()).toEqual({ identity: { role: "staff", employeeId: STAFF.employeeId }, userId: "staff-1" });
    archived.add(STAFF.employeeId);
    expect(await getActor()).toBeNull();
  });
});
