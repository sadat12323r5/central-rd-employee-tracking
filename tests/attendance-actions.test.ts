import { beforeEach, describe, expect, it, vi } from "vitest";
import { formData as form, resetAuth, STAFF, supabase } from "./support/fake-auth";

vi.mock("next/headers", async () => (await import("./support/fake-auth")).headersModule());
vi.mock("next/navigation", async () => (await import("./support/fake-auth")).navigationModule());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../src/server/supabase", async () => (await import("./support/fake-auth")).supabaseModule());
// Staff sign-in confirms the linked employee row through employees-store; back it with the fixture so these tests stay offline.
vi.mock("../src/server/employees-store", async importOriginal => {
  const { employees } = await import("@/data/employees");
  return {
    ...(await importOriginal<typeof import("../src/server/employees-store")>()),
    employeesStore: { getFor: async (_session: unknown, id: string) => employees.find(e => e.id === id) ?? null, listFor: vi.fn(), isActive: async (session: { employeeId: string }) => employees.some(e => e.id === session.employeeId) },
  };
});

const { signIn, getSession, isSignedIn } = await import("../src/server/auth");
const { clockInAction, clockOutAction, saveLogAction } = await import("../src/server/attendance-actions");
const { attendanceStore } = await import("../src/server/attendance-store");

const blank = { error: "", message: "" };
const NADIA = { email: "nadia.rahman@example.com", password: "nadia-long-passphrase" };

function resetAccounts() {
  resetAuth();
  supabase.users.set(NADIA.email, { id: "staff-2", password: NADIA.password, app_metadata: { role: "staff", employee_id: "BS-1001" } });
}

describe("staff sign-in", () => {
  beforeEach(resetAccounts);

  it("signs a provisioned employee in as staff, not as manager", async () => {
    await signIn(blank, form({ email: "Meera.Das@example.com", password: STAFF.password }));
    expect(await getSession()).toEqual({ role: "staff", employeeId: "BS-1003" });
    expect(await isSignedIn()).toBe(false);
  });

  it.each(["Brain23Demo!", "Staff23Demo!"])("rejects a staff email with the retired demo password %s", async password => {
    const result = await signIn(blank, form({ email: "meera.das@example.com", password }));
    expect(result?.error).toMatch(/incorrect/i);
    expect(await getSession()).toBeNull();
  });
});

describe("attendance actions", () => {
  beforeEach(async () => {
    resetAccounts();
    await attendanceStore.clear();
    vi.useRealTimers();
  });

  it("refuses to record attendance without a staff session", async () => {
    const result = await clockInAction(blank, form({ workMode: "Office" }));
    expect(result.error).toMatch(/sign in/i);
    expect(await attendanceStore.listAll()).toHaveLength(0);
  });

  it("ignores any employee id in the form and records against the signed-in employee", async () => {
    await signIn(blank, form(NADIA));
    await clockInAction(blank, form({ workMode: "Remote", employeeId: "BS-1008" }));
    const all = await attendanceStore.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ employeeId: "BS-1001", workMode: "Remote" });
  });

  it("runs a full day: clock in, log, clock out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T09:00:00+06:00"));
    await signIn(blank, form(NADIA));
    expect(await clockInAction(blank, form({ workMode: "Office" }))).toEqual({ error: "", message: "Clocked in." });

    vi.setSystemTime(new Date("2026-09-28T17:30:00+06:00"));
    const saved = await saveLogAction(blank, form({
      summary: "Attendance page", blockers: "",
      taskDescription: ["Form", "Tests"], taskHours: ["4", "3"], taskLink: ["", "https://example.com/pr/2"],
    }));
    expect(saved.error).toBe("");
    expect(await clockOutAction(blank, form({ breakMinutes: "30" }))).toEqual({ error: "", message: "Clocked out." });

    const [entry] = await attendanceStore.listForEmployee("BS-1001");
    expect(entry.breakMinutes).toBe(30);
    expect(entry.log?.tasks).toHaveLength(2);
    expect((await clockInAction(blank, form({ workMode: "Office" }))).error).toMatch(/already recorded/i);
  });
});
