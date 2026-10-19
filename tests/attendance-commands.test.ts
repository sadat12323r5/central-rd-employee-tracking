import { beforeEach, describe, expect, it } from "vitest";
import { createAttendanceCommands } from "@/server/attendance-commands";
import { createMemoryAttendanceStore } from "./support/memory-attendance-store";

// Story 9.1: the shared attendance commands take an injected `now`; the entry's date and times are that instant's.
const store = createMemoryAttendanceStore();
const commands = createAttendanceCommands(store);
const at = (iso: string) => new Date(iso);
const log = { summary: "Worked", blockers: "", tasks: [{ description: "Task", hours: "4", link: "" }] };

describe("attendance commands", () => {
  beforeEach(() => store.clear());

  it("records the clock-in at the injected instant, dated in Dhaka", async () => {
    // 01:30 in Dhaka on 4 August is still 3 August in UTC: the work date follows Dhaka.
    expect(await commands.clockIn("BS-2001", { workMode: "Office" }, at("2026-08-03T19:30:00Z"))).toBe("Clocked in.");
    const [entry] = await store.listForEmployee("BS-2001");
    expect(entry).toMatchObject({ employeeId: "BS-2001", date: "2026-08-04", clockIn: "2026-08-03T19:30:00.000Z", workMode: "Office", clockOut: null });
  });

  it("runs a simulated day: clock in, log and clock out at simulated instants", async () => {
    await commands.clockIn("BS-2001", { workMode: "Remote" }, at("2026-08-03T09:10:00+06:00"));
    expect(await commands.saveLog("BS-2001", log, at("2026-08-03T17:45:00+06:00"))).toBe("Daily log saved.");
    expect(await commands.clockOut("BS-2001", { breakMinutes: 60 }, at("2026-08-03T18:00:00+06:00"))).toBe("Clocked out.");
    const [entry] = await store.listForEmployee("BS-2001");
    expect(entry).toMatchObject({
      date: "2026-08-03", clockIn: "2026-08-03T03:10:00.000Z", clockOut: "2026-08-03T12:00:00.000Z", breakMinutes: 60,
      log: { summary: "Worked", updatedAt: "2026-08-03T11:45:00.000Z" },
    });
  });

  it("refuses a second clock-in on the same simulated day with the app's message", async () => {
    await commands.clockIn("BS-2001", { workMode: "Office" }, at("2026-08-03T09:00:00+06:00"));
    await expect(commands.clockIn("BS-2001", { workMode: "Office" }, at("2026-08-03T09:05:00+06:00")))
      .rejects.toMatchObject({ code: "ALREADY_CLOCKED_IN", message: "You are already clocked in today." });
    // The next simulated day is a new entry.
    await commands.clockIn("BS-2001", { workMode: "Office" }, at("2026-08-04T09:00:00+06:00"));
    expect((await store.listForEmployee("BS-2001")).map(e => e.date)).toEqual(["2026-08-04", "2026-08-03"]);
  });

  it("refuses a log or clock-out without today's clock-in", async () => {
    await commands.clockIn("BS-2001", { workMode: "Office" }, at("2026-08-03T09:00:00+06:00"));
    const nextDay = at("2026-08-04T17:00:00+06:00");
    await expect(commands.saveLog("BS-2001", log, nextDay)).rejects.toMatchObject({ code: "NOT_CLOCKED_IN" });
    await expect(commands.clockOut("BS-2001", { breakMinutes: 0 }, nextDay)).rejects.toMatchObject({ code: "NOT_CLOCKED_IN" });
  });

  it("refuses an invalid work mode before saving anything", async () => {
    await expect(commands.clockIn("BS-2001", { workMode: "Beach" }, at("2026-08-03T09:00:00+06:00"))).rejects.toMatchObject({ code: "INVALID_WORK_MODE" });
    expect(await store.listAll()).toEqual([]);
  });
});
