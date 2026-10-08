import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE, cookieStore, formData, resetAuth, STAFF, supabase } from "./support/fake-auth";

vi.mock("next/headers", async () => (await import("./support/fake-auth")).headersModule());
vi.mock("next/navigation", async () => (await import("./support/fake-auth")).navigationModule());
vi.mock("../src/server/supabase", async () => (await import("./support/fake-auth")).supabaseModule());

const { getFor } = vi.hoisted(() => ({ getFor: vi.fn() }));
vi.mock("../src/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/employees-store")>()),
  employeesStore: { listFor: vi.fn(), getFor },
}));

const { getSession, signIn } = await import("../src/server/auth");
const { employees } = await import("@/data/employees");

const HOUR = 60 * 60 * 1000;

describe("staff sessions on Supabase Auth", () => {
  beforeEach(async () => {
    resetAuth();
    getFor.mockReset();
    getFor.mockResolvedValue(employees.find(e => e.id === STAFF.employeeId));
    await signIn({ error: "" }, formData({ email: STAFF.email, password: STAFF.password }));
    getFor.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("reads the staff identity from app_metadata without a database round trip", async () => {
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    expect(getFor).not.toHaveBeenCalled();
  });

  it("lasts 12 hours, beyond the 8-hour Administrator window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start + 9 * HOUR);
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    vi.setSystemTime(start + 11 * HOUR + 59 * 60 * 1000);
    expect(await getSession()).toEqual({ role: "staff", employeeId: STAFF.employeeId });
    vi.setSystemTime(start + 12 * HOUR + 60 * 1000);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
    expect(cookieStore.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("ends a staff session whose own password sign-in is over 12 hours old", async () => {
    supabase.amr.set(STAFF.email, Math.floor(Date.now() / 1000) - 13 * 60 * 60);
    expect(await getSession()).toBeNull();
    expect(supabase.signOuts).toBe(1);
  });

  it("ends a staff session whose account last signed in over 12 hours ago", async () => {
    supabase.users.get(STAFF.email)!.last_sign_in_at = new Date(Date.now() - 13 * HOUR).toISOString();
    expect(await getSession()).toBeNull();
  });

  it.each([undefined, "", "BS-103", "bs-1003", "../admin", 1003])("treats a staff claim with employee_id %j as signed out", async employee_id => {
    supabase.users.get(STAFF.email)!.app_metadata = { role: "staff", employee_id };
    expect(await getSession()).toBeNull();
  });
});
