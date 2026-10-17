import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { buildCalendar, toCalendarPolicy } from "@/domain/holiday-calendar";
import {
  HolidayCalendarForbiddenError, HolidayCalendarUnavailableError, type CalendarVersion, type HolidayCalendarStore,
} from "@/server/holiday-calendar-store";
import {
  createLeaveStore, LeaveCalendarMissingError, LeaveEmployeeNotFoundError, LeaveForbiddenError, LeaveOverlapError, LeaveUnavailableError,
  LeaveValidationFailedError, toLeaveRecord, type LeaveRow,
} from "@/server/leave-store";
import { ManagerScopeUnavailableError, type ManagerScope } from "@/server/manager-scope";
import { many, pagedClient } from "./support/paged-client";

type Mode = "ok" | "error" | "throw" | "foreign" | "overlap" | "overlap-bare" | "outside" | "denied" | "fk-employee" | "fk-other" | "check";
type Call = { table: string; method: string; args: unknown[] };

/**
 * Minimal stand-in for the supabase-js query builder: records every call and applies eq / in / is / lte / gte
 * filters to rows. An insert appends the row (with an id and created_at) and returns it.
 */
function fakeClient(rows: LeaveRow[], mode: Mode = "ok") {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        if (mode === "error") return { data: null, error: { code: "PGRST205", message: "relation does not exist" } };
        const inserted = query.find(c => c.method === "insert");
        if (inserted) {
          if (mode === "overlap") return { data: null, error: { code: "23514", message: "leave_overlap", details: "2026-03-01,2026-03-04" } };
          if (mode === "overlap-bare") return { data: null, error: { code: "23514", message: "leave_overlap" } };
          if (mode === "outside") return { data: null, error: { code: "23514", message: "leave_outside_calendar" } };
          if (mode === "check") return { data: null, error: { code: "23514", message: "violates check constraint" } };
          if (mode === "denied") return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
          if (mode === "fk-employee") return { data: null, error: { code: "23503", message: "violates foreign key constraint", details: "Key (employee_id)=(BS-1999) is not present in table \"employees\"." } };
          if (mode === "fk-other") return { data: null, error: { code: "23503", message: "violates foreign key constraint", details: "Key (calendar_version_id)=(x) is not present." } };
          const row = { id: "new-id", created_at: "2026-10-17T08:00:00Z", cancelled_at: null, ...(inserted.args[0] as object) } as LeaveRow;
          rows.push(row);
          return { data: mode === "foreign" ? { ...row, employee_id: "BS-1999" } : row, error: null };
        }
        const filters = query.filter(c => c.method === "eq" || c.method === "is").map(c => c.args as [string, unknown]);
        const within = query.find(c => c.method === "in")?.args as [string, string[]] | undefined;
        const lte = query.filter(c => c.method === "lte").map(c => c.args as [string, string]);
        const gte = query.filter(c => c.method === "gte").map(c => c.args as [string, string]);
        const value = (r: LeaveRow, col: string) => (r as Record<string, unknown>)[col];
        const matching = rows.filter(r => filters.every(([col, val]) => value(r, col) === val)
          && (!within || within[1].includes(value(r, within[0]) as string))
          && lte.every(([col, val]) => (value(r, col) as string) <= val)
          && gte.every(([col, val]) => (value(r, col) as string) >= val));
        const limit = query.find(c => c.method === "limit")?.args[0] as number | undefined;
        return { data: limit === undefined ? matching : matching.slice(0, limit), error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "lte", "gte", "order", "limit", "range", "insert", "update", "delete", "maybeSingle", "single"]) {
        builder[method] = (...args: unknown[]) => { record(method, args); return builder; };
      }
      builder.returns = () => builder;
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** A stand-in manager-scope returning the given employee ids (or failing), recording each call. */
function fakeScope(employeeIds: string[], fail?: Error) {
  const calls: unknown[] = [];
  const scope: ManagerScope = {
    async forManager(session) {
      calls.push(session);
      if (fail) throw fail;
      return { departmentIds: new Set(["d"]), employeeIds: new Set(employeeIds) };
    },
  };
  return { scope, calls };
}

const PROVISIONAL = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const built = buildCalendar([{ name: "bangladesh-2026.csv", text: PROVISIONAL }]);
const VERSION: CalendarVersion = {
  id: "cal-v3", version: 3, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
  source: "bangladesh-2026.csv", loadedBy: null, loadedAt: "2026-10-17T00:00:00Z", holidayCount: built.holidays.length,
};

/** A stand-in calendar store: the provisional 2026 calendar by default, or none / a failure. */
function fakeCalendar(answer: "active" | "none" | Error = "active") {
  const calls: unknown[] = [];
  const calendar: Pick<HolidayCalendarStore, "active"> = {
    async active(session) {
      calls.push(session);
      if (answer instanceof Error) throw answer;
      return answer === "none" ? null : { version: VERSION, policy: toCalendarPolicy(built) };
    },
  };
  return { calendar, calls };
}

const storeFor = (client: SupabaseClient, scope: ManagerScope = fakeScope(["BS-1002"]).scope, calendar = fakeCalendar().calendar) =>
  createLeaveStore({ userClient: async () => client, scope, calendar });
const COLUMNS = "id,employee_id,start_date,end_date,working_days,category,calendar_version_id,cancelled_at,created_at";

const row = (employee_id: string, id: string, start_date: string, end_date: string, extra: Partial<LeaveRow> = {}): LeaveRow => ({
  id, employee_id, start_date, end_date, working_days: 1, category: "ONE_TO_THREE", calendar_version_id: "cal-v1",
  cancelled_at: null, created_at: "2026-10-01T00:00:00Z", ...extra,
});
const fresh = () => [
  row("BS-1001", "a", "2026-01-05", "2026-01-06"),
  row("BS-1001", "b", "2026-03-02", "2026-03-05", { working_days: 4, category: "FOUR_TO_FOURTEEN" }),
  row("BS-1002", "m", "2026-04-06", "2026-04-07"),
  row("BS-1003", "u", "2026-05-04", "2026-05-04"),
  row("BS-1001", "x", "2026-06-01", "2026-06-02", { cancelled_at: "2026-10-10T00:00:00Z" }),
];
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const manager = { role: "manager", employeeId: "BS-1009", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const inserts = (calls: Call[][]) => calls.flat().filter(c => c.method === "insert");

describe("leave-store mapping", () => {
  it("maps a row to a leave record", () => {
    expect(toLeaveRecord(row("BS-1001", "a", "2026-01-05", "2026-01-06"))).toEqual({
      id: "a", employeeId: "BS-1001", startDate: "2026-01-05", endDate: "2026-01-06", workingDays: 1, category: "ONE_TO_THREE",
      calendarVersionId: "cal-v1", cancelledAt: null, createdAt: "2026-10-01T00:00:00Z",
    });
  });
});

describe("leave-store record", () => {
  it("stores the staff member's own leave with working days, category and the active calendar version", async () => {
    const { client, calls } = fakeClient([]);
    const saved = await storeFor(client).record(staff, "BS-1001", { startDate: "2026-03-02", endDate: "2026-03-05" });
    expect(saved).toMatchObject({
      employeeId: "BS-1001", startDate: "2026-03-02", endDate: "2026-03-05", workingDays: 4, category: "FOUR_TO_FOURTEEN",
      calendarVersionId: "cal-v3", cancelledAt: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", "start_date,end_date"], ["eq", "employee_id", "BS-1001"], ["is", "cancelled_at", null],
      ["lte", "start_date", "2026-03-05"], ["gte", "end_date", "2026-03-02"], ["order", "start_date"], ["limit", 1],
    ]);
    expect(calls[1].map(c => [c.method, ...c.args])).toEqual([
      ["insert", { employee_id: "BS-1001", start_date: "2026-03-02", end_date: "2026-03-05", working_days: 4, category: "FOUR_TO_FOURTEEN", calendar_version_id: "cal-v3" }],
      ["select", COLUMNS], ["single"],
    ]);
  });

  it("excludes calendar holidays: 25–27 Mar 2026 (26 Mar is Independence Day) is 2 working days, 1–3", async () => {
    const saved = await storeFor(fakeClient([]).client).record(staff, "BS-1001", { startDate: "2026-03-25", endDate: "2026-03-27" });
    expect(saved).toMatchObject({ workingDays: 2, category: "ONE_TO_THREE" });
  });

  it("counts through the calendar for the session (any signed-in role)", async () => {
    const cal = fakeCalendar();
    await storeFor(fakeClient([]).client, undefined, cal.calendar).record(staff, "BS-1001", { startDate: "2026-03-02", endDate: "2026-03-02" });
    expect(cal.calls).toEqual([staff]);
  });

  it("refuses staff recording another employee's leave, without a query or calendar read", async () => {
    const { client, calls } = fakeClient([]);
    const cal = fakeCalendar();
    await expect(storeFor(client, undefined, cal.calendar).record(staff, "BS-1002", { startDate: "2026-03-02", endDate: "2026-03-05" }))
      .rejects.toBeInstanceOf(LeaveForbiddenError);
    expect(calls).toHaveLength(0);
    expect(cal.calls).toHaveLength(0);
  });

  it("lets an admin record for anyone and a manager for an employee in the subtree", async () => {
    const { client } = fakeClient([]);
    expect((await storeFor(client).record(admin, "BS-1003", { startDate: "2026-03-02", endDate: "2026-03-05" })).employeeId).toBe("BS-1003");
    expect((await storeFor(client).record(manager, "BS-1002", { startDate: "2026-03-02", endDate: "2026-03-05" })).employeeId).toBe("BS-1002");
  });

  it("lets a manager record their own leave from My record, even outside the subtree", async () => {
    const { client } = fakeClient([]);
    const saved = await storeFor(client, fakeScope([]).scope).record(manager, manager.employeeId, { startDate: "2026-03-02", endDate: "2026-03-05" });
    expect(saved.employeeId).toBe(manager.employeeId);
  });

  it("refuses a manager outside the subtree without a write, and is unavailable when the scope fails", async () => {
    const { client, calls } = fakeClient([]);
    const scope = fakeScope(["BS-1002"]);
    await expect(storeFor(client, scope.scope).record(manager, "BS-1003", { startDate: "2026-03-02", endDate: "2026-03-05" }))
      .rejects.toBeInstanceOf(LeaveForbiddenError);
    expect(scope.calls).toEqual([manager]); // fresh per request
    await expect(storeFor(client, fakeScope([], new ManagerScopeUnavailableError()).scope).record(manager, "BS-1002", { startDate: "2026-03-02", endDate: "2026-03-05" }))
      .rejects.toBeInstanceOf(LeaveUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an overlap with active leave (inclusive), naming the existing period, without inserting", async () => {
    const { client, calls } = fakeClient(fresh());
    const error = await storeFor(client).record(staff, "BS-1001", { startDate: "2026-03-05", endDate: "2026-03-10" }).catch(e => e);
    expect(error).toBeInstanceOf(LeaveOverlapError);
    expect(error.existing).toEqual({ startDate: "2026-03-02", endDate: "2026-03-05" });
    expect(inserts(calls)).toEqual([]);
  });

  it("allows an adjacent period, and ignores cancelled leave and other employees' leave", async () => {
    const { client } = fakeClient(fresh());
    expect((await storeFor(client).record(staff, "BS-1001", { startDate: "2026-03-06", endDate: "2026-03-10" })).startDate).toBe("2026-03-06");
    expect((await storeFor(client).record(staff, "BS-1001", { startDate: "2026-06-01", endDate: "2026-06-02" })).startDate).toBe("2026-06-01");
    expect((await storeFor(client).record(admin, "BS-1002", { startDate: "2026-03-02", endDate: "2026-03-05" })).employeeId).toBe("BS-1002");
  });

  it.each([
    ["an invalid date", { startDate: "2026-02-30", endDate: "2026-03-02" }, "INVALID_DATE"],
    ["a reversed range", { startDate: "2026-03-05", endDate: "2026-03-02" }, "REVERSED_RANGE"],
    ["a weekend-only period", { startDate: "2026-03-07", endDate: "2026-03-08" }, "ZERO_WORKING_DAYS"],
  ])("rejects %s without a query", async (_name, input, code) => {
    const { client, calls } = fakeClient([]);
    const error = await storeFor(client).record(staff, "BS-1001", input).catch(e => e);
    expect(error).toBeInstanceOf(LeaveValidationFailedError);
    expect(error.code).toBe(code);
    expect(calls).toHaveLength(0);
  });

  it("rejects a year outside the calendar, with the offending and supported years", async () => {
    const { client, calls } = fakeClient([]);
    const error = await storeFor(client).record(staff, "BS-1001", { startDate: "2026-12-30", endDate: "2027-01-05" }).catch(e => e);
    expect(error).toBeInstanceOf(LeaveValidationFailedError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_YEAR", year: 2027, supportedYearStart: 2026, supportedYearEnd: 2026 });
    expect(calls).toHaveLength(0);
  });

  it("refuses when no calendar is loaded, and is unavailable when it cannot be read", async () => {
    const { client, calls } = fakeClient([]);
    const input = { startDate: "2026-03-02", endDate: "2026-03-05" };
    await expect(storeFor(client, undefined, fakeCalendar("none").calendar).record(staff, "BS-1001", input)).rejects.toBeInstanceOf(LeaveCalendarMissingError);
    await expect(storeFor(client, undefined, fakeCalendar(new HolidayCalendarUnavailableError()).calendar).record(staff, "BS-1001", input))
      .rejects.toBeInstanceOf(LeaveUnavailableError);
    await expect(storeFor(client, undefined, fakeCalendar(new HolidayCalendarForbiddenError()).calendar).record(staff, "BS-1001", input))
      .rejects.toBeInstanceOf(LeaveForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("maps the database overlap backstop (23514 leave_overlap) to the overlap error with the existing period", async () => {
    const input = { startDate: "2026-03-02", endDate: "2026-03-05" };
    const error = await storeFor(fakeClient([], "overlap").client).record(staff, "BS-1001", input).catch(e => e);
    expect(error).toBeInstanceOf(LeaveOverlapError);
    expect(error.existing).toEqual({ startDate: "2026-03-01", endDate: "2026-03-04" });
    const bare = await storeFor(fakeClient([], "overlap-bare").client).record(staff, "BS-1001", input).catch(e => e);
    expect(bare).toBeInstanceOf(LeaveOverlapError);
    expect(bare.existing).toEqual(input);
  });

  it("maps the other refusals: outside the calendar, RLS, unknown employee; anything else is unavailable", async () => {
    const input = { startDate: "2026-03-02", endDate: "2026-03-05" };
    await expect(storeFor(fakeClient([], "outside").client).record(admin, "BS-1001", input)).rejects.toMatchObject({ code: "UNSUPPORTED_YEAR" });
    await expect(storeFor(fakeClient([], "denied").client).record(staff, "BS-1001", input)).rejects.toBeInstanceOf(LeaveForbiddenError);
    await expect(storeFor(fakeClient([], "fk-employee").client).record(admin, "BS-1999", input)).rejects.toBeInstanceOf(LeaveEmployeeNotFoundError);
    await expect(storeFor(fakeClient([], "fk-other").client).record(admin, "BS-1001", input)).rejects.toBeInstanceOf(LeaveUnavailableError);
    await expect(storeFor(fakeClient([], "check").client).record(admin, "BS-1001", input)).rejects.toBeInstanceOf(LeaveUnavailableError);
  });

  it("never reports a row stored for another employee as saved", async () => {
    await expect(storeFor(fakeClient([], "foreign").client).record(admin, "BS-1001", { startDate: "2026-03-02", endDate: "2026-03-05" }))
      .rejects.toBeInstanceOf(LeaveUnavailableError);
  });
});

describe("leave-store reads", () => {
  it("lists every period (cancelled included), newest start first per employee, for an admin", async () => {
    const { client, calls } = fakeClient(fresh());
    const list = await storeFor(client).listFor(admin);
    expect(list.map(r => r.id)).toEqual(["x", "b", "a", "m", "u"]);
    expect(list.find(r => r.id === "x")?.cancelledAt).toBe("2026-10-10T00:00:00Z");
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", COLUMNS], ["order", "employee_id"], ["order", "start_date", { ascending: false }], ["order", "id", { ascending: false }], ["range", 0, 999],
    ]);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient(fresh());
    expect((await storeFor(client).listFor(admin, "BS-1002")).map(r => r.id)).toEqual(["m"]);
    expect(calls[0]).toContainEqual({ table: "leave_records", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("filters staff reads to the session's own employee, and returns nothing without a query for anyone else", async () => {
    const { client, calls } = fakeClient(fresh());
    expect((await storeFor(client).listFor(staff)).map(r => r.id)).toEqual(["x", "b", "a"]);
    expect(calls[0]).toContainEqual({ table: "leave_records", method: "eq", args: ["employee_id", "BS-1001"] });
    expect(await storeFor(client).listFor(staff, "BS-1002")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("filters a manager's reads to the subtree, and drops anything else returned (defence in depth)", async () => {
    const { client, calls } = fakeClient(fresh());
    expect((await storeFor(client).listFor(manager)).map(r => r.id)).toEqual(["m"]);
    expect(calls[0]).toContainEqual({ table: "leave_records", method: "in", args: ["employee_id", ["BS-1002"]] });
    const leaky = { from: (t: string) => { const b = client.from(t) as unknown as Record<string, unknown>; b.in = () => b; return b; } } as unknown as SupabaseClient;
    expect((await storeFor(leaky).listFor(manager)).map(r => r.id)).toEqual(["m"]);
  });

  it("returns nothing, without a query, for a manager outside the subtree or with an empty subtree", async () => {
    const { client, calls } = fakeClient(fresh());
    expect(await storeFor(client).listFor(manager, "BS-1003")).toEqual([]);
    expect(await storeFor(client, fakeScope([]).scope).listFor(manager)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("is unavailable on a database error, a network failure or a failed scope", async () => {
    await expect(storeFor(fakeClient(fresh(), "error").client).listFor(admin)).rejects.toBeInstanceOf(LeaveUnavailableError);
    await expect(storeFor(fakeClient(fresh(), "throw").client).listFor(staff)).rejects.toBeInstanceOf(LeaveUnavailableError);
    await expect(storeFor(fakeClient(fresh()).client, fakeScope([], new ManagerScopeUnavailableError()).scope).listFor(manager))
      .rejects.toBeInstanceOf(LeaveUnavailableError);
    const bug = new TypeError("bug");
    await expect(storeFor(fakeClient(fresh()).client, fakeScope([], bug).scope).listFor(manager)).rejects.toBe(bug);
  });

  it("is unavailable on record when the database errors or cannot be reached", async () => {
    const input = { startDate: "2026-03-02", endDate: "2026-03-05" };
    await expect(storeFor(fakeClient([], "error").client).record(staff, "BS-1001", input)).rejects.toBeInstanceOf(LeaveUnavailableError);
    await expect(storeFor(fakeClient([], "throw").client).record(staff, "BS-1001", input)).rejects.toBeInstanceOf(LeaveUnavailableError);
  });

  it("reads 1000-row pages until a short page (Story 8.2)", async () => {
    const rowAt = (i: number) => row("BS-1001", `row-${String(i).padStart(4, "0")}`, "2026-01-05", "2026-01-05");
    const { client, ranges } = pagedClient([many(1000, rowAt), many(2, rowAt, 1000)]);
    expect(await storeFor(client).listFor(admin)).toHaveLength(1002);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });
});
