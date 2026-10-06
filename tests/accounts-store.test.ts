import { randomBytes } from "node:crypto";
import { AuthApiError, createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import {
  AccountExistsError, AccountsUnavailableError, AccountValidationError, createAccountsStore, seedFirstAdministrator,
} from "@/server/accounts-store";

type CreateArgs = { email: string; password: string; email_confirm: boolean; app_metadata: Record<string, unknown> };
type Mode = "ok" | "error" | "throw";

/**
 * Minimal stand-in for supabase-js `auth.admin`: an in-memory user list. `cap` mimics a server that
 * limits perPage below what was asked; `omitNextPage` mimics a response without pagination info.
 */
function fakeClient(
  initial: { email: string; app_metadata: Record<string, unknown> }[] = [], mode: Mode = "ok",
  { cap = Infinity, omitNextPage = false }: { cap?: number; omitNextPage?: boolean } = {},
) {
  const users = initial.map((u, i) => ({ id: `u-${i}`, ...u }));
  const created: CreateArgs[] = [];
  const pages: number[] = [];
  const admin = {
    async createUser(args: CreateArgs) {
      if (mode === "throw") throw new TypeError("fetch failed");
      if (mode === "error") return { data: { user: null }, error: new AuthApiError("upstream error", 500, "unexpected_failure") };
      if (users.some(u => u.email === args.email)) {
        return { data: { user: null }, error: new AuthApiError("A user with this email address has already been registered", 422, "email_exists") };
      }
      created.push(args);
      const user = { id: `u-${users.length}`, email: args.email, app_metadata: args.app_metadata };
      users.push(user);
      return { data: { user }, error: null };
    },
    async listUsers({ page, perPage }: { page: number; perPage: number }) {
      if (mode === "throw") throw new TypeError("fetch failed");
      if (mode === "error") return { data: { users: [] }, error: new AuthApiError("upstream error", 500, "unexpected_failure") };
      pages.push(page);
      const size = Math.min(perPage, cap);
      const slice = users.slice((page - 1) * size, page * size);
      const nextPage = page * size < users.length ? page + 1 : null;
      return { data: omitNextPage ? { users: slice } : { users: slice, nextPage }, error: null };
    },
  };
  return { client: { auth: { admin } } as unknown as SupabaseClient, created, pages, users };
}

const valid = { email: "  First.Admin@Example.test ", password: "correct-horse-battery", role: "admin" } as const;

describe("accounts-store.create", () => {
  it("creates a confirmed user with the role in app_metadata and a normalised email", async () => {
    const { client, created } = fakeClient();
    const account = await createAccountsStore(() => client).create(valid);
    expect(account).toEqual({ id: "u-0", email: "first.admin@example.test", role: "admin" });
    expect(created).toEqual([{ email: "first.admin@example.test", password: valid.password, email_confirm: true, app_metadata: { role: "admin" } }]);
  });

  it.each([
    [{ ...valid, email: "not-an-email" }, ["email"]],
    [{ ...valid, email: "" }, ["email"]],
    [{ ...valid, password: "elevenchars" }, ["password"]],
    [{ ...valid, role: "staff" }, ["role"]],
    [{ email: "x", password: "short", role: "owner" }, ["email", "password", "role"]],
  ])("rejects invalid input %# with AccountValidationError naming the fields, creating nothing", async (input, fields) => {
    const { client, created } = fakeClient();
    const error = await createAccountsStore(() => client).create(input as never).catch(e => e);
    expect(error).toBeInstanceOf(AccountValidationError);
    expect(error.fields).toEqual(fields);
    expect(error.message).not.toContain((input as { password: string }).password);
    expect(created).toHaveLength(0);
  });

  it("accepts a password of exactly 12 characters", async () => {
    const { client } = fakeClient();
    await expect(createAccountsStore(() => client).create({ ...valid, password: "twelve-chars" })).resolves.toMatchObject({ role: "admin" });
  });

  it("throws AccountExistsError for a duplicate email", async () => {
    const { client } = fakeClient([{ email: "first.admin@example.test", app_metadata: {} }]);
    await expect(createAccountsStore(() => client).create(valid)).rejects.toBeInstanceOf(AccountExistsError);
  });

  it.each(["error", "throw"] as const)("throws AccountsUnavailableError when Supabase fails (%s)", async mode => {
    const { client } = fakeClient([], mode);
    await expect(createAccountsStore(() => client).create(valid)).rejects.toBeInstanceOf(AccountsUnavailableError);
  });

  it("throws AccountsUnavailableError when Supabase is not configured", async () => {
    const store = createAccountsStore(() => { throw new Error("Supabase is not configured"); });
    await expect(store.create(valid)).rejects.toBeInstanceOf(AccountsUnavailableError);
    await expect(store.hasAdministrator()).rejects.toBeInstanceOf(AccountsUnavailableError);
  });
});

describe("accounts-store.hasAdministrator", () => {
  it("is false with no users or only non-admin users", async () => {
    expect(await createAccountsStore(() => fakeClient().client).hasAdministrator()).toBe(false);
    const { client } = fakeClient([{ email: "a@example.test", app_metadata: { role: "staff" } }, { email: "b@example.test", app_metadata: {} }]);
    expect(await createAccountsStore(() => client).hasAdministrator()).toBe(false);
  });

  it("is true when any user has the admin role, looking past the first page", async () => {
    const others = Array.from({ length: 1000 }, (_, i) => ({ email: `s${i}@example.test`, app_metadata: { role: "staff" } }));
    const { client, pages } = fakeClient([...others, { email: "admin@example.test", app_metadata: { role: "admin" } }]);
    expect(await createAccountsStore(() => client).hasAdministrator()).toBe(true);
    expect(pages).toEqual([1, 2]);
  });

  it("follows nextPage when the server caps perPage below the requested size", async () => {
    const others = Array.from({ length: 120 }, (_, i) => ({ email: `s${i}@example.test`, app_metadata: { role: "staff" } }));
    const { client, pages } = fakeClient([...others, { email: "admin@example.test", app_metadata: { role: "admin" } }], "ok", { cap: 50 });
    expect(await createAccountsStore(() => client).hasAdministrator()).toBe(true);
    expect(pages).toEqual([1, 2, 3]);
  });

  it("stops when nextPage is null, even on a short capped page", async () => {
    const { client, pages } = fakeClient([{ email: "a@example.test", app_metadata: { role: "staff" } }], "ok", { cap: 50 });
    expect(await createAccountsStore(() => client).hasAdministrator()).toBe(false);
    expect(pages).toEqual([1]);
  });

  it("falls back to the page length when the response has no nextPage", async () => {
    const others = Array.from({ length: 1000 }, (_, i) => ({ email: `s${i}@example.test`, app_metadata: { role: "staff" } }));
    const withAdmin = fakeClient([...others, { email: "admin@example.test", app_metadata: { role: "admin" } }], "ok", { omitNextPage: true });
    expect(await createAccountsStore(() => withAdmin.client).hasAdministrator()).toBe(true);
    expect(withAdmin.pages).toEqual([1, 2]);
    const short = fakeClient([{ email: "a@example.test", app_metadata: {} }], "ok", { omitNextPage: true });
    expect(await createAccountsStore(() => short.client).hasAdministrator()).toBe(false);
    expect(short.pages).toEqual([1]);
  });

  it.each(["error", "throw"] as const)("throws AccountsUnavailableError when Supabase fails (%s)", async mode => {
    await expect(createAccountsStore(() => fakeClient([], mode).client).hasAdministrator()).rejects.toBeInstanceOf(AccountsUnavailableError);
  });
});

// Live check against the shared Supabase project; skipped without credentials. Uses a throwaway
// account and deletes it in afterAll, never touching real Administrators.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

describe("seedFirstAdministrator", () => {
  it("creates the first Administrator through create() when none exists", async () => {
    const { client, created } = fakeClient([{ email: "staff@example.test", app_metadata: { role: "staff" } }]);
    const account = await seedFirstAdministrator(createAccountsStore(() => client), { email: valid.email, password: valid.password });
    expect(account).toMatchObject({ email: "first.admin@example.test", role: "admin" });
    expect(created).toHaveLength(1);
    expect(created[0].app_metadata).toEqual({ role: "admin" });
  });

  it("creates nothing and returns null when an Administrator already exists", async () => {
    const { client, created } = fakeClient([{ email: "boss@example.test", app_metadata: { role: "admin" } }]);
    expect(await seedFirstAdministrator(createAccountsStore(() => client), { email: valid.email, password: valid.password })).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe.skipIf(!(url && anonKey && serviceKey))("accounts-store against Supabase Auth (shared project)", () => {
  const service = url && serviceKey ? createClient(url, serviceKey, noSession) : (undefined as never);
  const email = `accounts-test-${randomBytes(4).toString("hex")}@example.test`;
  const password = `Acct-${randomBytes(12).toString("hex")}!`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await service.auth.admin.deleteUser(createdId);
  }, 30_000);

  it("creates an Administrator who can sign in with the admin role, and refuses a duplicate", async () => {
    const store = createAccountsStore(() => service);
    const account = await store.create({ email, password, role: "admin" });
    createdId = account.id;
    expect(account).toMatchObject({ email, role: "admin" });

    const anon = createClient(url!, anonKey!, noSession);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    expect(data.user?.app_metadata.role).toBe("admin");
    // auth.ts's 8-hour check reads this session's password sign-in time from the token's amr claim.
    const claims = JSON.parse(Buffer.from(data.session!.access_token.split(".")[1], "base64url").toString());
    expect(claims.amr).toEqual(expect.arrayContaining([expect.objectContaining({ method: "password", timestamp: expect.any(Number) })]));
    await anon.auth.signOut({ scope: "local" });

    await expect(store.create({ email, password, role: "admin" })).rejects.toBeInstanceOf(AccountExistsError);
    expect(await store.hasAdministrator()).toBe(true);
  }, 30_000);
});
