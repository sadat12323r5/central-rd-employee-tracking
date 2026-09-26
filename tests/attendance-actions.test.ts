import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    cookieStore: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
      set: (name: string, value: string) => { store.set(name, value); },
      delete: (name: string) => { store.delete(name); },
      __store: store,
    },
  };
});

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(cookieStore) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { signIn, getSession, isSignedIn } = await import("../src/server/auth");
const { clockInAction, clockOutAction, saveLogAction } = await import("../src/server/attendance-actions");
const { attendanceStore } = await import("../src/server/attendance-store");

const staffPassword = process.env.DEMO_STAFF_PASSWORD || "Staff23Demo!";
const blank = { error: "", message: "" };
function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(key, v);
  return data;
}

describe("staff sign-in", () => {
  beforeEach(() => cookieStore.__store.clear());

  it("signs a fixture employee in as staff, not as manager", async () => {
    await signIn(blank, form({ email: "Meera.Das@example.com", password: staffPassword }));
    expect(await getSession()).toEqual({ role: "staff", employeeId: "BS-1003" });
    expect(await isSignedIn()).toBe(false);
  });

  it("rejects a staff email with the manager password", async () => {
    const result = await signIn(blank, form({ email: "meera.das@example.com", password: "Brain23Demo!" }));
    expect(result?.error).toMatch(/incorrect/i);
    expect(await getSession()).toBeNull();
  });
});

describe("attendance actions", () => {
  beforeEach(async () => {
    cookieStore.__store.clear();
    await attendanceStore.clear();
    vi.useRealTimers();
  });

  it("refuses to record attendance without a staff session", async () => {
    const result = await clockInAction(blank, form({ workMode: "Office" }));
    expect(result.error).toMatch(/sign in/i);
    expect(await attendanceStore.listAll()).toHaveLength(0);
  });

  it("ignores any employee id in the form and records against the signed-in employee", async () => {
    await signIn(blank, form({ email: "nadia.rahman@example.com", password: staffPassword }));
    await clockInAction(blank, form({ workMode: "Remote", employeeId: "BS-1008" }));
    const all = await attendanceStore.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ employeeId: "BS-1001", workMode: "Remote" });
  });

  it("runs a full day: clock in, log, clock out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T09:00:00+06:00"));
    await signIn(blank, form({ email: "nadia.rahman@example.com", password: staffPassword }));
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
