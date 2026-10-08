import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, create, createAccountsStore, revalidatePath, getServiceClient } = vi.hoisted(() => {
  const create = vi.fn();
  return {
    getSession: vi.fn(),
    create,
    createAccountsStore: vi.fn(() => ({ create, hasAdministrator: vi.fn() })),
    revalidatePath: vi.fn(),
    getServiceClient: vi.fn(() => ({ fake: "service client" })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/server/auth", () => ({ getSession }));
vi.mock("../src/server/supabase", () => ({ getServiceClient, getUserClient: vi.fn() }));
vi.mock("../src/server/accounts-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/accounts-store")>()),
  createAccountsStore,
}));

const { provisionStaffAccountAction } = await import("../src/server/account-actions");
const { AccountExistsError, AccountsUnavailableError, AccountValidationError } = await import("../src/server/accounts-store");

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
