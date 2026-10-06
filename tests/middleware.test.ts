import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for @supabase/ssr: getUser() refreshes the session by writing new cookies through setAll,
// exactly as the real client does when the access token has expired.
type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (toSet: { name: string; value: string; options: Record<string, unknown> }[], headers: Record<string, string>) => void;
};
const { createServerClient, getUser } = vi.hoisted(() => {
  const state: { cookies?: CookieMethods } = {};
  const getUser = vi.fn(async () => {
    state.cookies!.setAll(
      [{ name: "sb-test-auth-token", value: "refreshed-token", options: { path: "/", httpOnly: true } }],
      { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" },
    );
    return { data: { user: null }, error: null };
  });
  const createServerClient = vi.fn((_url: string, _key: string, options: { cookies: CookieMethods }) => {
    state.cookies = options.cookies;
    return { auth: { getUser } };
  });
  return { createServerClient, getUser };
});
vi.mock("@supabase/ssr", () => ({ createServerClient }));

const { middleware } = await import("../src/middleware");

const request = () => new NextRequest("http://localhost/", { headers: { cookie: "sb-test-auth-token=expired-token" } });

describe("middleware session refresh", () => {
  beforeEach(() => {
    createServerClient.mockClear();
    getUser.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-for-tests");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("validates the session with getUser() and returns the refreshed auth cookies and no-cache headers", async () => {
    const req = request();
    const response = await middleware(req);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed-token");
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    // The refreshed cookie is also forwarded to the page render on this same request.
    expect(req.cookies.get("sb-test-auth-token")?.value).toBe("refreshed-token");
  });

  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])("passes the request through untouched when %s is missing", async name => {
    vi.stubEnv(name, "");
    const response = await middleware(request());
    expect(createServerClient).not.toHaveBeenCalled();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.getAll()).toEqual([]);
  });
});
