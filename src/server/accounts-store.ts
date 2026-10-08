import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// The only way an account is created (AD-6). Story 1.2 uses it from scripts/seed-admin.ts to create
// the first Administrator; Story 1.3 adds the Administrator-session server action that calls it.
// There is deliberately no runtime singleton here, and this module imports nothing but types from
// other src/ modules, so `node --experimental-strip-types` can load it from the seed script.
// The client passed in must be the service-role client: only it may create users or set app_metadata.

export type AccountRole = "admin";

export type Account = { id: string; email: string; role: AccountRole };

const accountInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(12),
  role: z.literal("admin"),
});

export type AccountInput = z.input<typeof accountInput>;

export interface AccountsStore {
  /** Creates a confirmed auth user with `app_metadata.role` set. Throws a typed error on failure. */
  create(input: AccountInput): Promise<Account>;
  /** True when at least one auth user has `app_metadata.role === "admin"`. */
  hasAdministrator(): Promise<boolean>;
}

/** The input failed validation. `fields` names the offending inputs; values are never included. */
export class AccountValidationError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`Invalid account details: ${fields.join(", ")}.`);
    this.name = "AccountValidationError";
    this.fields = fields;
  }
}

/** An account with this email already exists. */
export class AccountExistsError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "AccountExistsError";
  }
}

/** Supabase Auth is unreachable or failed for another reason. Nothing was created. */
export class AccountsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Accounts are temporarily unavailable.", options);
    this.name = "AccountsUnavailableError";
  }
}

type AuthFailure = { code?: string; message?: string; status?: number } | null | undefined;

const isDuplicate = (error: AuthFailure) =>
  error?.code === "email_exists" || /already (been )?registered|already exists/i.test(error?.message ?? "");

const PAGE_SIZE = 1000;

export function createAccountsStore(getClient: () => SupabaseClient): AccountsStore {
  function admin() {
    try {
      return getClient().auth.admin;
    } catch (cause) {
      throw new AccountsUnavailableError({ cause });
    }
  }

  return {
    async create(input) {
      const parsed = accountInput.safeParse(input);
      if (!parsed.success) {
        throw new AccountValidationError([...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? "input")))]);
      }
      const { email, password, role } = parsed.data;
      let result: Awaited<ReturnType<ReturnType<typeof admin>["createUser"]>>;
      try {
        result = await admin().createUser({ email, password, email_confirm: true, app_metadata: { role } });
      } catch (cause) {
        if (cause instanceof AccountsUnavailableError) throw cause;
        throw new AccountsUnavailableError({ cause });
      }
      const { data, error } = result;
      if (error) {
        if (isDuplicate(error)) throw new AccountExistsError();
        if (error.code === "weak_password") throw new AccountValidationError(["password"]);
        throw new AccountsUnavailableError({ cause: error });
      }
      if (!data.user) throw new AccountsUnavailableError({ cause: "no user returned" });
      return { id: data.user.id, email: data.user.email ?? email, role };
    },

    async hasAdministrator() {
      for (let page = 1; ; page++) {
        let result: Awaited<ReturnType<ReturnType<typeof admin>["listUsers"]>>;
        try {
          result = await admin().listUsers({ page, perPage: PAGE_SIZE });
        } catch (cause) {
          if (cause instanceof AccountsUnavailableError) throw cause;
          throw new AccountsUnavailableError({ cause });
        }
        if (result.error) throw new AccountsUnavailableError({ cause: result.error });
        const users = result.data.users;
        if (users.some(user => user.app_metadata?.role === "admin")) return true;
        // Follow the server's pagination: it may cap perPage below what was asked for.
        const nextPage = (result.data as { nextPage?: number | null }).nextPage;
        if (nextPage === null) return false;
        if (nextPage === undefined && users.length < PAGE_SIZE) return false;
        if (users.length === 0) return false;
      }
    },
  };
}

/**
 * The one-time first-Administrator seed (AD-6's sanctioned non-runtime exception). Creates the
 * Administrator through `create()`, or returns null and creates nothing when any Administrator exists.
 */
export async function seedFirstAdministrator(store: AccountsStore, input: Omit<AccountInput, "role">): Promise<Account | null> {
  if (await store.hasAdministrator()) return null;
  return store.create({ ...input, role: "admin" });
}
