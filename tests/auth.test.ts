import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore, redirectMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    cookieStore: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
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

const { isSignedIn, signIn, signOut, getSession } = await import("../src/server/auth");
const { EmployeesUnavailableError } = await import("../src/server/employees-store");
const { employees } = await import("@/data/employees");
const staffPassword = process.env.DEMO_STAFF_PASSWORD || "Staff23Demo!";

const demoEmail = process.env.DEMO_ADMIN_EMAIL || "manager@example.com";
const demoPassword = process.env.DEMO_ADMIN_PASSWORD || "Brain23Demo!";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("demo admin auth", () => {
  beforeEach(() => {
    cookieStore.__store.clear();
    redirectMock.mockClear();
  });

  it("reports signed out when no session cookie is present", async () => {
    expect(await isSignedIn()).toBe(false);
  });

  it("rejects an incorrect password without creating a session", async () => {
    const result = await signIn({ error: "" }, formData({ email: demoEmail, password: "wrong-password" }));
    expect(result.error).toMatch(/incorrect/i);
    expect(await isSignedIn()).toBe(false);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown email without creating a session", async () => {
    const result = await signIn({ error: "" }, formData({ email: "nobody@example.com", password: demoPassword }));
    expect(result.error).toMatch(/incorrect/i);
    expect(await isSignedIn()).toBe(false);
  });

  it("signs in with the correct demo credentials, matching email case-insensitively, and redirects home", async () => {
    await signIn({ error: "" }, formData({ email: demoEmail.toUpperCase(), password: demoPassword }));
    expect(await isSignedIn()).toBe(true);
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("signs out by clearing the session and redirecting home", async () => {
    await signIn({ error: "" }, formData({ email: demoEmail, password: demoPassword }));
    expect(await isSignedIn()).toBe(true);
    redirectMock.mockClear();

    await signOut();
    expect(await isSignedIn()).toBe(false);
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});

describe("demo staff auth through employees-store", () => {
  beforeEach(() => {
    cookieStore.__store.clear();
    redirectMock.mockClear();
    findByEmail.mockReset();
  });

  it("signs a staff member in as the employee the store finds by email", async () => {
    const employee = employees.find(e => e.id === "BS-1003")!;
    findByEmail.mockResolvedValue(employee);
    await signIn({ error: "" }, formData({ email: employee.email.toUpperCase(), password: staffPassword }));
    expect(findByEmail).toHaveBeenCalledWith(employee.email.toLowerCase());
    expect(await getSession()).toEqual({ role: "staff", employeeId: "BS-1003" });
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("rejects an email the store does not know with the generic message", async () => {
    findByEmail.mockResolvedValue(null);
    const result = await signIn({ error: "" }, formData({ email: "nobody@example.com", password: staffPassword }));
    expect(result.error).toMatch(/incorrect/i);
    expect(await getSession()).toBeNull();
  });

  it("rejects a wrong staff password without querying the store", async () => {
    const result = await signIn({ error: "" }, formData({ email: "meera.das@example.com", password: "wrong-password" }));
    expect(result.error).toMatch(/incorrect/i);
    expect(findByEmail).not.toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });

  it("reports sign-in as unavailable, without a session, when the store is unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findByEmail.mockRejectedValue(new EmployeesUnavailableError());
    const result = await signIn({ error: "" }, formData({ email: "nadia.rahman@example.com", password: staffPassword }));
    expect(result.error).toMatch(/unavailable/i);
    expect(await getSession()).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
