import { randomBytes, randomUUID } from "node:crypto";
import { AuthApiError, createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import {
  AccountExistsError, AccountStateError, AccountsUnavailableError, AccountValidationError, ArchiveSelfError, createAccountsStore,
  seedFirstAdministrator,
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
    [{ ...valid, password: "x".repeat(73) }, ["password"]],
    [{ ...valid, role: "staff" }, ["employeeId"]],
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

type EmployeeRow = { employee_id: string; email: string; name: string; auth_user_id: string | null };

/**
 * Stand-in for the service-role client on the staff path: `auth.admin` (createUser/deleteUser) plus the
 * `employees` table (select ... eq ... maybeSingle, and the conditional link update ... eq ... is ... select).
 * `linkMode` simulates a lost race (another account linked first), a link error or a thrown link.
 */
function staffClient(
  rows: EmployeeRow[],
  { authUsers = [] as string[], readMode = "ok" as Mode, createMode = "ok" as Mode, linkMode = "ok" as "ok" | "race" | "error" | "throw" } = {},
) {
  const created: CreateArgs[] = [];
  const deleted: string[] = [];
  const updates: { values: Record<string, unknown>; filters: [string, string, unknown][] }[] = [];
  const emails = new Set(authUsers);
  const admin = {
    async createUser(args: CreateArgs) {
      if (createMode === "throw") throw new TypeError("fetch failed");
      if (createMode === "error") return { data: { user: null }, error: new AuthApiError("upstream error", 500, "unexpected_failure") };
      if (emails.has(args.email)) {
        return { data: { user: null }, error: new AuthApiError("A user with this email address has already been registered", 422, "email_exists") };
      }
      emails.add(args.email);
      created.push(args);
      return { data: { user: { id: `user-${created.length}`, email: args.email, app_metadata: args.app_metadata } }, error: null };
    },
    async deleteUser(id: string) {
      deleted.push(id);
      return { data: { user: null }, error: null };
    },
  };
  function from(table: string) {
    expect(table).toBe("employees");
    const filters: [string, string, unknown][] = [];
    let values: Record<string, unknown> | undefined;
    const matches = () => rows.filter(r => filters.every(([op, col, val]) => (op === "eq" ? r[col as keyof EmployeeRow] === val : r[col as keyof EmployeeRow] === null)));
    const builder = {
      select: () => builder,
      update: (v: Record<string, unknown>) => { values = v; return builder; },
      eq: (col: string, val: unknown) => { filters.push(["eq", col, val]); return builder; },
      is: (col: string, val: unknown) => { filters.push(["is", col, val]); return builder; },
      async maybeSingle() {
        if (readMode === "throw") throw new TypeError("fetch failed");
        if (readMode === "error") return { data: null, error: { message: "connection refused" } };
        return { data: matches()[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve().then(() => {
          updates.push({ values: values!, filters: [...filters] });
          if (linkMode === "throw") throw new TypeError("fetch failed");
          if (linkMode === "error") return { data: null, error: { message: "connection refused" } };
          if (linkMode === "race") for (const r of matches()) r.auth_user_id = "someone-else";
          const touched = matches();
          for (const r of touched) Object.assign(r, values);
          return { data: touched.map(r => ({ employee_id: r.employee_id })), error: null };
        }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { client: { auth: { admin }, from } as unknown as SupabaseClient, created, deleted, updates, rows };
}

const meera = (): EmployeeRow => ({ employee_id: "BS-1003", email: "Meera.Das@example.com", name: "Meera Das", auth_user_id: null });
const staffInput = { role: "staff", employeeId: "BS-1003", password: "a-long-initial-password" } as const;

describe("accounts-store.create for Staff", () => {
  it("creates the user with the employee's own email, role and employee_id, and links the row", async () => {
    const fake = staffClient([meera()]);
    const account = await createAccountsStore(() => fake.client).create(staffInput);
    expect(account).toEqual({ id: "user-1", email: "meera.das@example.com", role: "staff", employeeId: "BS-1003", name: "Meera Das" });
    expect(fake.created).toEqual([{
      email: "meera.das@example.com", password: staffInput.password, email_confirm: true, app_metadata: { role: "staff", employee_id: "BS-1003" },
    }]);
    expect(fake.rows[0].auth_user_id).toBe("user-1");
    // The link is conditional on the row still being unlinked.
    expect(fake.updates[0]).toEqual({ values: { auth_user_id: "user-1" }, filters: [["eq", "employee_id", "BS-1003"], ["is", "auth_user_id", null]] });
    expect(fake.deleted).toEqual([]);
  });

  it("ignores any email in the input: the account email always comes from the employees row", async () => {
    const fake = staffClient([meera()]);
    await createAccountsStore(() => fake.client).create({ ...staffInput, email: "attacker@example.test" } as never);
    expect(fake.created[0].email).toBe("meera.das@example.com");
  });

  it("rejects an employee that already has an account before creating any user", async () => {
    const fake = staffClient([{ ...meera(), auth_user_id: "existing-user" }]);
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountExistsError);
    expect(fake.created).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("rejects an email that is already registered, linking nothing", async () => {
    const fake = staffClient([meera()], { authUsers: ["meera.das@example.com"] });
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountExistsError);
    expect(fake.updates).toHaveLength(0);
    expect(fake.rows[0].auth_user_id).toBeNull();
  });

  it.each([["BS-1999"], ["BS-12"], ["../admin"], [""]])("rejects unknown or malformed employee id %j with AccountValidationError(employeeId)", async employeeId => {
    const fake = staffClient([meera()]);
    const error = await createAccountsStore(() => fake.client).create({ ...staffInput, employeeId }).catch(e => e);
    expect(error).toBeInstanceOf(AccountValidationError);
    expect(error.fields).toEqual(["employeeId"]);
    expect(fake.created).toHaveLength(0);
  });

  it("rejects a password over 72 characters with AccountValidationError(password), creating nothing", async () => {
    const fake = staffClient([meera()]);
    const error = await createAccountsStore(() => fake.client).create({ ...staffInput, password: "x".repeat(73) }).catch(e => e);
    expect(error).toBeInstanceOf(AccountValidationError);
    expect(error.fields).toEqual(["password"]);
    expect(fake.created).toHaveLength(0);
    await expect(createAccountsStore(() => staffClient([meera()]).client).create({ ...staffInput, password: "x".repeat(72) })).resolves.toMatchObject({ role: "staff" });
  });

  it("rejects a password shorter than 12 characters with AccountValidationError(password), never echoing it", async () => {
    const fake = staffClient([meera()]);
    const error = await createAccountsStore(() => fake.client).create({ ...staffInput, password: "elevenchars" }).catch(e => e);
    expect(error).toBeInstanceOf(AccountValidationError);
    expect(error.fields).toEqual(["password"]);
    expect(error.message).not.toContain("elevenchars");
    expect(fake.created).toHaveLength(0);
  });

  it("deletes the new user and reports an existing account when the link race is lost", async () => {
    const fake = staffClient([meera()], { linkMode: "race" });
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountExistsError);
    expect(fake.deleted).toEqual(["user-1"]);
    expect(fake.rows[0].auth_user_id).toBe("someone-else");
  });

  it.each(["error", "throw"] as const)("deletes the new user and reports unavailable when the link fails (%s)", async linkMode => {
    const fake = staffClient([meera()], { linkMode });
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountsUnavailableError);
    expect(fake.deleted).toEqual(["user-1"]);
  });

  it.each(["error", "throw"] as const)("reports unavailable, creating nothing, when the employee read fails (%s)", async readMode => {
    const fake = staffClient([meera()], { readMode });
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountsUnavailableError);
    expect(fake.created).toHaveLength(0);
  });

  it.each(["error", "throw"] as const)("reports unavailable, linking nothing, when Supabase Auth fails (%s)", async createMode => {
    const fake = staffClient([meera()], { createMode });
    await expect(createAccountsStore(() => fake.client).create(staffInput)).rejects.toBeInstanceOf(AccountsUnavailableError);
    expect(fake.updates).toHaveLength(0);
  });

  it("reports unavailable when Supabase is not configured", async () => {
    const store = createAccountsStore(() => { throw new Error("Supabase is not configured"); });
    await expect(store.create(staffInput)).rejects.toBeInstanceOf(AccountsUnavailableError);
  });
});

type ArchiveRow = { employee_id: string; name: string; archived_at: string | null; auth_user_id: string | null };
type RpcMode = "ok" | "error" | "throw" | "no-data";

/**
 * Stand-in for `rpc("set_employee_archived")`: mimics the Postgres function's checks and error messages
 * on in-memory rows, and records the audit rows it would write in the same transaction.
 */
function archiveClient(rows: ArchiveRow[], mode: RpcMode = "ok") {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const audit: { actor: string; target: string; action: string }[] = [];
  const fail = (message: string, details: string | null = null) => ({ data: null, error: { code: "P0001", message, details, hint: null } });
  async function rpc(fn: string, args: { p_employee_id: string; p_archived: boolean; p_actor: string }) {
    calls.push({ fn, args });
    if (mode === "throw") throw new TypeError("fetch failed");
    if (mode === "error") return { data: null, error: { code: "PGRST000", message: "connection refused", details: null, hint: null } };
    if (mode === "no-data") return { data: null, error: null };
    const row = rows.find(r => r.employee_id === args.p_employee_id);
    if (!row) return fail("employee_not_found");
    if (args.p_archived && row.archived_at) return fail("already_archived", row.name);
    if (!args.p_archived && !row.archived_at) return fail("not_archived", row.name);
    if (args.p_archived && row.auth_user_id === args.p_actor) return fail("cannot_archive_self");
    row.archived_at = args.p_archived ? "2026-10-08T09:00:00Z" : null;
    audit.push({ actor: args.p_actor, target: row.employee_id, action: args.p_archived ? "archive" : "restore" });
    return { data: row.name, error: null };
  }
  return { client: { rpc } as unknown as SupabaseClient, calls, audit, rows };
}

const actorId = "6f1d2c1e-0000-4000-8000-000000000001";
const activeMeera = (): ArchiveRow => ({ employee_id: "BS-1003", name: "Meera Das", archived_at: null, auth_user_id: "7a2e3d4f-0000-4000-8000-000000000002" });

describe("accounts-store.archive and restore", () => {
  it("archives through one set_employee_archived call, writing one audit row", async () => {
    const fake = archiveClient([activeMeera()]);
    const result = await createAccountsStore(() => fake.client).archive({ employeeId: " BS-1003 ", actorId });
    expect(result).toEqual({ employeeId: "BS-1003", name: "Meera Das", archived: true });
    expect(fake.calls).toEqual([{ fn: "set_employee_archived", args: { p_employee_id: "BS-1003", p_archived: true, p_actor: actorId } }]);
    expect(fake.rows[0].archived_at).not.toBeNull();
    expect(fake.audit).toEqual([{ actor: actorId, target: "BS-1003", action: "archive" }]);
  });

  it("restores an archived employee, writing one audit row", async () => {
    const fake = archiveClient([{ ...activeMeera(), archived_at: "2026-10-01T00:00:00Z" }]);
    const result = await createAccountsStore(() => fake.client).restore({ employeeId: "BS-1003", actorId });
    expect(result).toEqual({ employeeId: "BS-1003", name: "Meera Das", archived: false });
    expect(fake.calls[0].args).toEqual({ p_employee_id: "BS-1003", p_archived: false, p_actor: actorId });
    expect(fake.rows[0].archived_at).toBeNull();
    expect(fake.audit).toEqual([{ actor: actorId, target: "BS-1003", action: "restore" }]);
  });

  it("rejects archiving an archived employee with AccountStateError(archived), carrying the name, and no audit row", async () => {
    const fake = archiveClient([{ ...activeMeera(), archived_at: "2026-10-01T00:00:00Z" }]);
    const error = await createAccountsStore(() => fake.client).archive({ employeeId: "BS-1003", actorId }).catch(e => e);
    expect(error).toBeInstanceOf(AccountStateError);
    expect(error).toMatchObject({ state: "archived", employeeName: "Meera Das" });
    expect(fake.audit).toEqual([]);
  });

  it("rejects restoring an active employee with AccountStateError(active) and no audit row", async () => {
    const fake = archiveClient([activeMeera()]);
    const error = await createAccountsStore(() => fake.client).restore({ employeeId: "BS-1003", actorId }).catch(e => e);
    expect(error).toBeInstanceOf(AccountStateError);
    expect(error).toMatchObject({ state: "active", employeeName: "Meera Das" });
    expect(fake.audit).toEqual([]);
  });

  it("rejects archiving the employee linked to the actor's own account with ArchiveSelfError, changing nothing", async () => {
    const fake = archiveClient([activeMeera()]);
    const own = fake.rows[0].auth_user_id!;
    await expect(createAccountsStore(() => fake.client).archive({ employeeId: "BS-1003", actorId: own })).rejects.toBeInstanceOf(ArchiveSelfError);
    expect(fake.rows[0].archived_at).toBeNull();
    expect(fake.audit).toEqual([]);
  });

  it("maps an unknown employee to AccountValidationError(employeeId)", async () => {
    const fake = archiveClient([activeMeera()]);
    const error = await createAccountsStore(() => fake.client).archive({ employeeId: "BS-1999", actorId }).catch(e => e);
    expect(error).toBeInstanceOf(AccountValidationError);
    expect(error.fields).toEqual(["employeeId"]);
  });

  it.each([
    [{ employeeId: "BS-12", actorId }, ["employeeId"]],
    [{ employeeId: "../admin", actorId }, ["employeeId"]],
    [{ employeeId: "BS-1003", actorId: "not-a-uuid" }, ["actorId"]],
    [{ employeeId: "BS-1003" }, ["actorId"]],
  ])("validates %j before calling the database", async (input, fields) => {
    const fake = archiveClient([activeMeera()]);
    for (const call of [() => createAccountsStore(() => fake.client).archive(input as never), () => createAccountsStore(() => fake.client).restore(input as never)]) {
      const error = await call().catch(e => e);
      expect(error).toBeInstanceOf(AccountValidationError);
      expect(error.fields).toEqual(fields);
    }
    expect(fake.calls).toEqual([]);
  });

  it.each(["error", "throw", "no-data"] as const)("reports AccountsUnavailableError when the database fails (%s)", async mode => {
    const fake = archiveClient([activeMeera()], mode);
    const store = createAccountsStore(() => fake.client);
    await expect(store.archive({ employeeId: "BS-1003", actorId })).rejects.toBeInstanceOf(AccountsUnavailableError);
    await expect(store.restore({ employeeId: "BS-1003", actorId })).rejects.toBeInstanceOf(AccountsUnavailableError);
  });

  it("reports AccountsUnavailableError when Supabase is not configured", async () => {
    const store = createAccountsStore(() => { throw new Error("Supabase is not configured"); });
    await expect(store.archive({ employeeId: "BS-1003", actorId })).rejects.toBeInstanceOf(AccountsUnavailableError);
    await expect(store.restore({ employeeId: "BS-1003", actorId })).rejects.toBeInstanceOf(AccountsUnavailableError);
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

describe.skipIf(!(url && anonKey && serviceKey))("Staff provisioning against the shared project", () => {
  const service = url && serviceKey ? createClient(url, serviceKey, noSession) : (undefined as never);
  const run = randomBytes(4).toString("hex");
  // BS-9999 sits outside the BS-9900..BS-9995 slots employees-rls.test.ts uses, so the files can run in parallel.
  const employeeId = "BS-9999";
  const email = `accounts-staff-${run}@example.test`;
  const password = `Staff-${randomBytes(12).toString("hex")}!`;
  const userIds: string[] = [];

  async function cleanUp() {
    const { data } = await service.from("employees").select("auth_user_id").eq("employee_id", employeeId).maybeSingle();
    await service.from("employees").delete().eq("employee_id", employeeId);
    for (const id of new Set([...userIds, data?.auth_user_id].filter(Boolean) as string[])) await service.auth.admin.deleteUser(id);
  }

  afterAll(cleanUp, 30_000);

  it("creates and links a Staff account that can sign in and read only its own row through RLS", async () => {
    await cleanUp(); // leftovers of an aborted run
    const { error: insertError } = await service.from("employees").insert({
      employee_id: employeeId, name: `Accounts Test ${run}`, title: "Test", team: "Test", employment_type: "Permanent", email,
      joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available", initials: "AT", avatar_color: "mint",
      summary: "Throwaway row created by tests/accounts-store.test.ts.",
    });
    expect(insertError).toBeNull();

    const store = createAccountsStore(() => service);
    const account = await store.create({ role: "staff", employeeId, password });
    userIds.push(account.id);
    expect(account).toMatchObject({ email, role: "staff", employeeId });

    const { data: row } = await service.from("employees").select("auth_user_id").eq("employee_id", employeeId).single();
    expect(row?.auth_user_id).toBe(account.id);

    const anon = createClient(url!, anonKey!, noSession);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    expect(data.user?.app_metadata).toMatchObject({ role: "staff", employee_id: employeeId });
    const { data: visible, error: readError } = await anon.from("employees").select("employee_id");
    expect(readError).toBeNull();
    expect(visible).toEqual([{ employee_id: employeeId }]);
    await anon.auth.signOut({ scope: "local" });

    // A second account for the same employee is refused, and no auth user is left behind.
    await expect(store.create({ role: "staff", employeeId, password })).rejects.toBeInstanceOf(AccountExistsError);
    const withEmail: string[] = [];
    for (let page = 1; ; page++) {
      const { data: listed, error: listError } = await service.auth.admin.listUsers({ page, perPage: 1000 });
      expect(listError).toBeNull();
      withEmail.push(...listed.users.filter(u => u.email === email).map(u => u.id));
      if (listed.users.length < 1000) break;
    }
    expect(withEmail).toEqual([account.id]);
  }, 30_000);
});

describe.skipIf(!(url && anonKey && serviceKey))("archive and restore against the shared project", () => {
  const service = url && serviceKey ? createClient(url, serviceKey, noSession) : (undefined as never);
  const run = randomBytes(4).toString("hex");
  // BS-9998: outside employees-rls.test.ts's BS-9900..BS-9995 slots and the Staff block's BS-9999.
  const employeeId = "BS-9998";
  // A fresh actor id per run, so this run's audit rows are told apart from earlier runs' residue.
  const actor = randomUUID();
  const userIds: string[] = [];

  async function cleanUp() {
    await service.from("employees").delete().eq("employee_id", employeeId);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  }

  afterAll(cleanUp, 30_000);

  const auditFor = async (by: string) => {
    const { data, error } = await service.from("audit_events").select("id,actor,target,action,occurred_at").eq("actor", by).order("id");
    expect(error).toBeNull();
    return data!;
  };
  const readRow = async () => {
    const { data, error } = await service.from("employees").select("*").eq("employee_id", employeeId).single();
    expect(error).toBeNull();
    return data as Record<string, unknown>;
  };

  it("archives and restores with exactly one audit row per call, keeping the rest of the row; refuses repeats, self and unknown ids", async () => {
    await service.from("employees").delete().eq("employee_id", employeeId); // leftovers of an aborted run
    const { error: insertError } = await service.from("employees").insert({
      employee_id: employeeId, name: `Archive Test ${run}`, title: "Test", team: "Test", employment_type: "Permanent",
      email: `accounts-archive-${run}@example.test`, joined_on: "2026-01-01", manager: "Test", office: "Test", status: "Available",
      initials: "AT", avatar_color: "mint", summary: "Throwaway row created by tests/accounts-store.test.ts.",
    });
    expect(insertError).toBeNull();
    const before = await readRow();
    expect(before.archived_at).toBeNull();

    const store = createAccountsStore(() => service);
    expect(await store.archive({ employeeId, actorId: actor })).toEqual({ employeeId, name: `Archive Test ${run}`, archived: true });
    const archived = await readRow();
    expect(archived.archived_at).not.toBeNull();
    expect({ ...archived, archived_at: null }).toEqual(before);
    let audit = await auditFor(actor);
    expect(audit.map(a => [a.target, a.action])).toEqual([[employeeId, "archive"]]);
    expect(Date.parse(audit[0].occurred_at)).toBeGreaterThan(Date.now() - 10 * 60 * 1000);

    await expect(store.archive({ employeeId, actorId: actor })).rejects.toMatchObject({ name: "AccountStateError", state: "archived", employeeName: `Archive Test ${run}` });
    expect(await auditFor(actor)).toHaveLength(1);

    expect(await store.restore({ employeeId, actorId: actor })).toEqual({ employeeId, name: `Archive Test ${run}`, archived: false });
    expect(await readRow()).toEqual(before);
    audit = await auditFor(actor);
    expect(audit.map(a => [a.target, a.action])).toEqual([[employeeId, "archive"], [employeeId, "restore"]]);

    await expect(store.restore({ employeeId, actorId: actor })).rejects.toBeInstanceOf(AccountStateError);
    expect(await auditFor(actor)).toHaveLength(2);

    await expect(store.archive({ employeeId: "BS-0000", actorId: actor })).rejects.toBeInstanceOf(AccountValidationError);

    // The actor's own account: link the row to a throwaway auth user and archive as that user.
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: `accounts-archive-self-${run}@example.test`, password: `Self-${randomBytes(12).toString("hex")}!`, email_confirm: true, app_metadata: {},
    });
    expect(createError).toBeNull();
    userIds.push(created.user!.id);
    const { error: linkError } = await service.from("employees").update({ auth_user_id: created.user!.id }).eq("employee_id", employeeId);
    expect(linkError).toBeNull();
    await expect(store.archive({ employeeId, actorId: created.user!.id })).rejects.toBeInstanceOf(ArchiveSelfError);
    expect((await readRow()).archived_at).toBeNull();
    expect(await auditFor(created.user!.id)).toEqual([]);
  }, 60_000);

  it("refuses to update, delete or truncate audit rows, even with the service role", async () => {
    const [first] = await auditFor(actor);
    expect(first).toBeDefined();
    const updated = await service.from("audit_events").update({ action: "restore" }).eq("id", first.id);
    expect(updated.error).not.toBeNull();
    const deleted = await service.from("audit_events").delete().eq("id", first.id);
    expect(deleted.error).not.toBeNull();
    expect((await auditFor(actor))[0]).toEqual(first);
  }, 30_000);
});
