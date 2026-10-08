import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// The only way an account is created (AD-6). scripts/seed-admin.ts uses it to create the first
// Administrator, scripts/seed-demo-staff.ts the demo Staff account, and the Administrator-only server
// action in account-actions.ts provisions Staff accounts through it at runtime.
// archive()/restore() (Story 1.4) are likewise the only way an employee's access is ended or given
// back: both call the Postgres function `set_employee_archived`, which changes `employees.archived_at`
// and writes one append-only `audit_events` row in the same transaction.
// There is deliberately no runtime singleton here, and this module imports nothing but types from
// other src/ modules, so `node --experimental-strip-types` can load it from the seed scripts.
// The client passed in must be the service-role client: only it may create users, set app_metadata
// or link `employees.auth_user_id`.

export type AccountRole = "admin" | "staff";

export type Account = { id: string; email: string; role: AccountRole; employeeId?: string; name?: string };

// 72 is the bcrypt input limit Supabase Auth enforces; longer passwords are rejected upstream.
const password = z.string().min(12).max(72);

const adminInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password,
  role: z.literal("admin"),
});

// A Staff account's email is always the employee's primary email from the employees row, never input.
const staffInput = z.object({
  employeeId: z.string().trim().regex(/^BS-\d{4}$/),
  password,
  role: z.literal("staff"),
});

const archiveInput = z.object({
  employeeId: z.string().trim().regex(/^BS-\d{4}$/),
  actorId: z.uuid(),
});

export type ArchiveInput = z.input<typeof archiveInput>;

/** The outcome of an archive or restore: the employee's name (for the message) and the new state. */
export type ArchiveResult = { employeeId: string; name: string; archived: boolean };

const accountInput = z.discriminatedUnion("role", [adminInput, staffInput]);

export type AccountInput = z.input<typeof accountInput>;

export interface AccountsStore {
  /**
   * Creates a confirmed auth user with `app_metadata.role` set. For `staff`, the user gets the linked
   * employee's email and `app_metadata.employee_id`, and `employees.auth_user_id` is linked. Throws a
   * typed error on failure. If the link fails after the user was created, the user is deleted again;
   * that compensating delete is best effort, and a failure to delete is logged.
   */
  create(input: AccountInput): Promise<Account>;
  /** True when at least one auth user has `app_metadata.role === "admin"`. */
  hasAdministrator(): Promise<boolean>;
  /**
   * Archives the employee (sets `archived_at`) and records one `audit_events` row for `actorId`, in one
   * transaction. Throws AccountValidationError(["employeeId"]) for an unknown employee, AccountStateError
   * when already archived, ArchiveSelfError when the employee's account is the actor's own.
   */
  archive(input: ArchiveInput): Promise<ArchiveResult>;
  /** Restores an archived employee and records one `audit_events` row. AccountStateError when not archived. */
  restore(input: ArchiveInput): Promise<ArchiveResult>;
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

/** An account with this email already exists, or the employee already has a sign-in account. */
export class AccountExistsError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "AccountExistsError";
  }
}

/** The employee is already in the requested state: `archived` (archive refused) or `active` (restore refused). */
export class AccountStateError extends Error {
  readonly state: "archived" | "active";
  /** The employee's name, when the database reported it. */
  readonly employeeName?: string;
  constructor(state: "archived" | "active", employeeName?: string) {
    super(state === "archived" ? "The employee is already archived." : "The employee is not archived.");
    this.name = "AccountStateError";
    this.state = state;
    this.employeeName = employeeName;
  }
}

/** The actor tried to archive the employee linked to their own account. Nothing changed. */
export class ArchiveSelfError extends Error {
  constructor() {
    super("An account cannot be archived by its own user.");
    this.name = "ArchiveSelfError";
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

type EmployeeLink = { employee_id: string; email: string; name: string; auth_user_id: string | null };

function validationFields(issues: { path: PropertyKey[] }[]): string[] {
  return [...new Set(issues.map(issue => String(issue.path[0] ?? "input")))];
}

export function createAccountsStore(getClient: () => SupabaseClient): AccountsStore {
  function client() {
    try {
      return getClient();
    } catch (cause) {
      throw new AccountsUnavailableError({ cause });
    }
  }

  const admin = () => client().auth.admin;

  async function createUser(args: { email: string; password: string; app_metadata: Record<string, string> }) {
    let result: Awaited<ReturnType<ReturnType<typeof admin>["createUser"]>>;
    try {
      result = await admin().createUser({ ...args, email_confirm: true });
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
    return data.user;
  }

  /** Best-effort compensation: removes an auth user whose employee link failed. */
  async function removeUser(id: string) {
    try {
      const { error } = await admin().deleteUser(id);
      if (error) console.error("Could not remove an unlinked auth user.", { name: error.name, status: error.status });
    } catch (error) {
      console.error("Could not remove an unlinked auth user.", error instanceof Error ? error.name : "unknown error");
    }
  }

  async function readEmployee(employeeId: string): Promise<EmployeeLink | null> {
    let result: { data: EmployeeLink | null; error: unknown };
    try {
      result = await client().from("employees").select("employee_id,email,name,auth_user_id").eq("employee_id", employeeId).maybeSingle<EmployeeLink>();
    } catch (cause) {
      if (cause instanceof AccountsUnavailableError) throw cause;
      throw new AccountsUnavailableError({ cause });
    }
    if (result.error) throw new AccountsUnavailableError({ cause: result.error });
    return result.data;
  }

  /** Links the employee row to the auth user only if it is still unlinked. Returns the rows touched. */
  async function link(employeeId: string, userId: string): Promise<number> {
    const result = await client().from("employees").update({ auth_user_id: userId })
      .eq("employee_id", employeeId).is("auth_user_id", null).select("employee_id");
    if (result.error) throw result.error;
    return result.data?.length ?? 0;
  }

  async function createStaff(employeeId: string, password: string): Promise<Account> {
    const employee = await readEmployee(employeeId);
    if (!employee) throw new AccountValidationError(["employeeId"]);
    if (employee.auth_user_id) throw new AccountExistsError();
    const email = employee.email.trim().toLowerCase();
    const user = await createUser({ email, password, app_metadata: { role: "staff", employee_id: employee.employee_id } });
    let linked: number;
    try {
      linked = await link(employee.employee_id, user.id);
    } catch (cause) {
      await removeUser(user.id);
      throw new AccountsUnavailableError({ cause });
    }
    if (linked === 0) {
      // Another account was linked to this employee in the meantime: undo ours.
      await removeUser(user.id);
      throw new AccountExistsError();
    }
    return { id: user.id, email: user.email ?? email, role: "staff", employeeId: employee.employee_id, name: employee.name };
  }

  /** One rpc() call = one transaction: the state change and its audit row commit together or not at all. */
  async function setArchived(input: ArchiveInput, archived: boolean): Promise<ArchiveResult> {
    const parsed = archiveInput.safeParse(input);
    if (!parsed.success) throw new AccountValidationError(validationFields(parsed.error.issues));
    const { employeeId, actorId } = parsed.data;
    let result: { data: unknown; error: { message?: string; details?: string | null } | null };
    try {
      result = await client().rpc("set_employee_archived", { p_employee_id: employeeId, p_archived: archived, p_actor: actorId });
    } catch (cause) {
      if (cause instanceof AccountsUnavailableError) throw cause;
      throw new AccountsUnavailableError({ cause });
    }
    if (result.error) {
      switch (result.error.message) {
        case "employee_not_found": throw new AccountValidationError(["employeeId"]);
        case "already_archived": throw new AccountStateError("archived", result.error.details || undefined);
        case "not_archived": throw new AccountStateError("active", result.error.details || undefined);
        case "cannot_archive_self": throw new ArchiveSelfError();
        default: throw new AccountsUnavailableError({ cause: result.error });
      }
    }
    if (typeof result.data !== "string") throw new AccountsUnavailableError({ cause: "no employee name returned" });
    return { employeeId, name: result.data, archived };
  }

  return {
    archive: input => setArchived(input, true),
    restore: input => setArchived(input, false),

    async create(input) {
      const schema = (input as { role?: unknown } | null)?.role === "staff" ? staffInput : adminInput;
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new AccountValidationError(validationFields(parsed.error.issues));
      const data = parsed.data;
      if (data.role === "staff") return createStaff(data.employeeId, data.password);
      const user = await createUser({ email: data.email, password: data.password, app_metadata: { role: data.role } });
      return { id: user.id, email: user.email ?? data.email, role: data.role };
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
export async function seedFirstAdministrator(store: AccountsStore, input: Omit<Extract<AccountInput, { role: "admin" }>, "role">): Promise<Account | null> {
  if (await store.hasAdministrator()) return null;
  return store.create({ ...input, role: "admin" });
}
