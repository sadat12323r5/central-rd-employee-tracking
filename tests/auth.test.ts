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

const { isSignedIn, signIn, signOut } = await import("../src/server/auth");

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
