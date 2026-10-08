import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, getActor, create, archive, restore, createAccountsStore, revalidatePath, getServiceClient } = vi.hoisted(() => {
  const create = vi.fn();
  const archive = vi.fn();
  const restore = vi.fn();
  return {
    getSession: vi.fn(),
    getActor: vi.fn(),
    create,
    archive,
    restore,
    createAccountsStore: vi.fn(() => ({ create, archive, restore, hasAdministrator: vi.fn() })),
    revalidatePath: vi.fn(),
    getServiceClient: vi.fn(() => ({ fake: "service client" })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession, getActor }));
vi.mock("../src/server/supabase", () => ({ getServiceClient, getUserClient: vi.fn() }));
vi.mock("../src/server/accounts-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/accounts-store")>()),
  createAccountsStore,
}));

const { archiveEmployeeAction, provisionStaffAccountAction, restoreEmployeeAction } = await import("../src/server/account-actions");
const {
  AccountExistsError, AccountStateError, AccountsUnavailableError, AccountValidationError, ArchiveSelfError,
} = await import("../src/server/accounts-store");

const blank = { error: "", message: "" };
const password = "a-long-initial-password";
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const valid = () => form({ employeeId: "BS-1003", password, confirmPassword: password });

describe("provisionStaffAccountAction", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ role: "admin" });
    create.mockResolvedValue({ id: "user-1", email: "meera.das@example.com", role: "staff", employeeId: "BS-1003", name: "Meera Das" });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it.each([[{ role: "staff", employeeId: "BS-1003" }], [null]])("rejects session %j without touching the store", async session => {
    getSession.mockResolvedValue(session);
    const result = await provisionStaffAccountAction(blank, valid());
    expect(result).toEqual({ error: "Only an Administrator can create accounts.", message: "" });
    expect(createAccountsStore).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("creates a Staff account through accounts-store for an admin, with the service client, and revalidates", async () => {
    const result = await provisionStaffAccountAction(blank, form({ employeeId: " BS-1003 ", password, confirmPassword: password, email: "attacker@example.test" }));
    expect(result).toEqual({ error: "", message: "Sign-in account created for Meera Das." });
    expect(createAccountsStore).toHaveBeenCalledWith(getServiceClient);
    expect(create).toHaveBeenCalledWith({ role: "staff", employeeId: "BS-1003", password });
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it.each([
    ["an existing account", new AccountExistsError(), "This employee already has a sign-in account."],
    ["an unknown employee", new AccountValidationError(["employeeId"]), "Choose an existing employee."],
    ["a rejected password", new AccountValidationError(["password"]), "The initial password must be 12 to 72 characters and meet the password policy."],
    ["Supabase being unavailable", new AccountsUnavailableError(), "Accounts are temporarily unavailable. Nothing was created."],
    ["an unexpected error", new Error("boom"), "Accounts are temporarily unavailable. Nothing was created."],
  ])("maps %s to its message as an error state", async (_label, error, message) => {
    create.mockRejectedValue(error);
    const result = await provisionStaffAccountAction(blank, valid());
    expect(result).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ employeeId: "BS-1003", password: "elevenchars" }, "The initial password must be 12 to 72 characters and meet the password policy."],
    [{ employeeId: "BS-1003", password: "y".repeat(73), confirmPassword: "y".repeat(73) }, "The initial password must be 12 to 72 characters and meet the password policy."],
    [{ employeeId: "BS-1003" }, "The initial password must be 12 to 72 characters and meet the password policy."],
    [{ employeeId: "not-an-id", password }, "Choose an existing employee."],
    [{ password }, "Choose an existing employee."],
    [{ employeeId: "BS-1003", password, confirmPassword: `${password}x` }, "The two passwords do not match."],
    [{ employeeId: "BS-1003", password }, "The two passwords do not match."],
  ])("validates the form %j before calling the store", async (fields, message) => {
    const result = await provisionStaffAccountAction(blank, form(fields as Record<string, string>));
    expect(result).toEqual({ error: message, message: "" });
    expect(create).not.toHaveBeenCalled();
  });

  it("never returns or logs the initial password", async () => {
    const outcomes = [
      await provisionStaffAccountAction(blank, valid()),
      ...(await Promise.all([new AccountExistsError(), new AccountsUnavailableError({ cause: password }), new Error(password)].map(async error => {
        create.mockRejectedValueOnce(error);
        return provisionStaffAccountAction(blank, valid());
      }))),
      await provisionStaffAccountAction(blank, form({ employeeId: "BS-1003", password: "short-pw" })),
    ];
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(password);
    expect(JSON.stringify(outcomes)).not.toContain("short-pw");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(password);
  });
});

describe("archiveEmployeeAction and restoreEmployeeAction", () => {
  const ADMIN_ID = "6f1d2c1e-0000-4000-8000-000000000001";
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    getActor.mockResolvedValue({ identity: { role: "admin" }, userId: ADMIN_ID });
    archive.mockResolvedValue({ employeeId: "BS-1003", name: "Meera Das", archived: true });
    restore.mockResolvedValue({ employeeId: "BS-1003", name: "Meera Das", archived: false });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const actions = [["archive", archiveEmployeeAction], ["restore", restoreEmployeeAction]] as const;

  it.each(actions.flatMap(([label, action]) => [
    [label, action, { identity: { role: "staff", employeeId: "BS-1003" }, userId: "7a2e3d4f-0000-4000-8000-000000000002" }],
    [label, action, null],
  ] as const))("%s rejects session %j without touching the store", async (_label, action, actor) => {
    getActor.mockResolvedValue(actor);
    const result = await action(blank, form({ employeeId: "BS-1003" }));
    expect(result).toEqual({ error: "Only an Administrator can archive or restore accounts.", message: "" });
    expect(createAccountsStore).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("archives through accounts-store as the session's user, ignoring any actor in the form, and revalidates", async () => {
    const result = await archiveEmployeeAction(blank, form({ employeeId: " BS-1003 ", actorId: "7a2e3d4f-0000-4000-8000-000000000002", actor: "x" }));
    expect(result).toEqual({ error: "", message: "Meera Das was archived. Their sign-in access has ended." });
    expect(createAccountsStore).toHaveBeenCalledWith(getServiceClient);
    expect(archive).toHaveBeenCalledWith({ employeeId: "BS-1003", actorId: ADMIN_ID });
    expect(restore).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("restores through accounts-store as the session's user and revalidates", async () => {
    const result = await restoreEmployeeAction(blank, form({ employeeId: "BS-1003", actorId: "7a2e3d4f-0000-4000-8000-000000000002" }));
    expect(result).toEqual({ error: "", message: "Meera Das was restored." });
    expect(restore).toHaveBeenCalledWith({ employeeId: "BS-1003", actorId: ADMIN_ID });
    expect(archive).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it.each([
    ["archive", archiveEmployeeAction, archive, new AccountStateError("archived", "Meera Das"), "Meera Das is already archived."],
    ["restore", restoreEmployeeAction, restore, new AccountStateError("active", "Meera Das"), "Meera Das is not archived."],
    ["archive", archiveEmployeeAction, archive, new AccountStateError("archived"), "BS-1003 is already archived."],
    ["archive", archiveEmployeeAction, archive, new ArchiveSelfError(), "You cannot archive your own account."],
    ["archive", archiveEmployeeAction, archive, new AccountValidationError(["employeeId"]), "Choose an existing employee."],
    ["restore", restoreEmployeeAction, restore, new AccountValidationError(["employeeId"]), "Choose an existing employee."],
    ["archive", archiveEmployeeAction, archive, new AccountValidationError(["actorId"]), "Accounts are temporarily unavailable. Nothing was changed."],
    ["archive", archiveEmployeeAction, archive, new AccountsUnavailableError(), "Accounts are temporarily unavailable. Nothing was changed."],
    ["restore", restoreEmployeeAction, restore, new AccountsUnavailableError(), "Accounts are temporarily unavailable. Nothing was changed."],
    ["restore", restoreEmployeeAction, restore, new Error("boom"), "Accounts are temporarily unavailable. Nothing was changed."],
  ] as const)("%s maps %s to its message as an error state", async (_label, action, method, error, message) => {
    method.mockRejectedValue(error);
    expect(await action(blank, form({ employeeId: "BS-1003" }))).toEqual({ error: message, message: "" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(actions.flatMap(([label, action]) => [[label, action, {}], [label, action, { employeeId: "BS-12" }], [label, action, { employeeId: "../admin" }]] as const))(
    "%s validates the Employee ID %j before calling the store",
    async (_label, action, fields) => {
      expect(await action(blank, form(fields as Record<string, string>))).toEqual({ error: "Choose an existing employee.", message: "" });
      expect(archive).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    },
  );
});
