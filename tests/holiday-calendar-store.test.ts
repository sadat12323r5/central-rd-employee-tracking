import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { buildCalendar, HolidayCalendarInputError, type HolidayCalendar } from "@/domain/holiday-calendar";
import { countWorkingDays, LeaveValidationError } from "@/domain/leave";
import {
  createHolidayCalendarStore, HolidayCalendarForbiddenError, HolidayCalendarUnavailableError, toCalendarVersion,
  type CalendarVersionRow,
} from "@/server/holiday-calendar-store";
import type { SessionIdentity } from "@/server/session";

type DbError = { code: string; message: string };
type Call = { target: string; method: string; args: unknown[] };
type DateRow = { version_id: string; holiday_date: string; name: string; kind: string };
type Options = { throws?: boolean; readError?: DbError; rpcError?: DbError };

const V1 = "ca1e0000-0000-4000-8000-000000000001";
const V2 = "ca1e0000-0000-4000-8000-000000000002";
/** A stored row; `purpose` is the database column the store filters on (absent means live, the default). */
type StoredRow = CalendarVersionRow & { purpose?: "live" | "test" };
const versionRow = (id: string, version: number, overrides: Partial<StoredRow> = {}): StoredRow => ({
  id, version, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supported_year_start: 2026, supported_year_end: 2026,
  source: "bangladesh-2026.csv", loaded_by: "admin-user", loaded_at: "2026-10-17T04:00:00+00:00", ...overrides,
});

/** Minimal stand-in for supabase-js: records calls, keeps versions and dates in memory, and runs the RPC. */
function fakeClient(versions: StoredRow[], dates: DateRow[], options: Options = {}) {
  const calls: Call[][] = [];
  function builder(target: string, resolve: (query: Call[]) => { data: unknown; error: DbError | null }) {
    const query: Call[] = [];
    calls.push(query);
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit", "range", "maybeSingle", "single", "insert", "update", "delete"]) {
      b[method] = (...args: unknown[]) => { query.push({ target, method, args }); return b; };
    }
    b.returns = () => b;
    b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(resolve(query)).then(ok, fail);
    return b;
  }
  const client = {
    from(table: string) {
      if (options.throws) throw new TypeError("fetch failed");
      return builder(table, query => {
        if (options.readError) return { data: null, error: options.readError };
        if (table === "holiday_calendar_versions") {
          const filters = query.filter(c => c.method === "eq").map(c => c.args as [keyof StoredRow, unknown]);
          const stored = (v: StoredRow, column: keyof StoredRow) => column === "purpose" ? v.purpose ?? "live" : v[column];
          const sorted = versions.filter(v => filters.every(([column, value]) => stored(v, column) === value))
            .sort((a, b) => b.version - a.version);
          const counted = sorted.map(v => ({ ...v, holiday_calendar_dates: [{ count: dates.filter(d => d.version_id === v.id).length }] }));
          if (query.some(c => c.method === "maybeSingle")) return { data: sorted[0] ?? null, error: null };
          return { data: counted, error: null };
        }
        const id = query.find(c => c.method === "eq")?.args[1];
        return { data: dates.filter(d => d.version_id === id).map(({ version_id: _v, ...d }) => d), error: null };
      });
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (options.throws) throw new TypeError("fetch failed");
      return builder(`rpc:${fn}`, query => {
        query.unshift({ target: `rpc:${fn}`, method: "rpc", args: [args] });
        if (options.rpcError) return { data: null, error: options.rpcError };
        const next = Math.max(0, ...versions.map(v => v.version)) + 1;
        const row = versionRow(`new-${next}`, next, {
          jurisdiction: args.p_jurisdiction as string, timezone: args.p_timezone as string, source: args.p_source as string,
          supported_year_start: args.p_year_start as number, supported_year_end: args.p_year_end as number,
          purpose: args.p_purpose as "live" | "test",
        });
        versions.push(row);
        for (const h of args.p_holidays as { date: string; name: string; kind: string }[]) {
          dates.push({ version_id: row.id, holiday_date: h.date, name: h.name, kind: h.kind });
        }
        return { data: row, error: null };
      });
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const storeFor = (client: SupabaseClient) => createHolidayCalendarStore({ userClient: async () => client });
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const manager = { role: "manager", employeeId: "BS-1002", userId: "aaaa0000-0000-4000-8000-000000000001" } as const;
const csv = (...rows: string[]) => ["date,name,kind", ...rows].join("\n");
const calendar2026: HolidayCalendar = buildCalendar([{ name: "b.csv", text: csv(
  "2026-02-04,Shab-e-Barat,executive order", "2026-02-11,National election day,special", "2026-02-12,Election holiday,special",
  "2026-02-21,Shaheed Day,general", "2026-12-16,Victory Day,general",
) }]);
const input = { jurisdiction: "  Bangladesh ", source: "bangladesh-2026.csv", calendar: calendar2026 };
const queries = (calls: Call[][]) => calls.flat();

describe("holiday-calendar-store shape", () => {
  it("has no update or delete method", () => {
    expect(Object.keys(storeFor(fakeClient([], []).client)).sort()).toEqual(["active", "load", "versions"]);
  });

  it("maps a row to a version", () => {
    expect(toCalendarVersion(versionRow(V1, 1), 31)).toEqual({
      id: V1, version: 1, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026,
      source: "bangladesh-2026.csv", loadedBy: "admin-user", loadedAt: "2026-10-17T04:00:00+00:00", holidayCount: 31,
    });
  });
});

describe("holiday-calendar-store authorization", () => {
  it.each([["a staff session", staff], ["a manager session", manager], ["no session", null]])("refuses %s load and versions before any query", async (_label, session) => {
    const { client, calls } = fakeClient([], []);
    const store = storeFor(client);
    const s = session as unknown as SessionIdentity;
    await expect(store.load(s, input)).rejects.toBeInstanceOf(HolidayCalendarForbiddenError);
    await expect(store.versions(s)).rejects.toBeInstanceOf(HolidayCalendarForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("refuses active() without a session, before any query", async () => {
    const { client, calls } = fakeClient([], []);
    await expect(storeFor(client).active(null as unknown as SessionIdentity)).rejects.toBeInstanceOf(HolidayCalendarForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("maps the database's 42501 refusal to forbidden", async () => {
    const { client } = fakeClient([], [], { rpcError: { code: "42501", message: "Only an Administrator can load the holiday calendar." } });
    await expect(storeFor(client).load(admin, input)).rejects.toBeInstanceOf(HolidayCalendarForbiddenError);
  });
});

describe("holiday-calendar-store load", () => {
  it("loads the calendar through the RPC as a new version in Asia/Dhaka", async () => {
    const versions = [versionRow(V1, 1)];
    const { client, calls } = fakeClient(versions, []);
    const saved = await storeFor(client).load(admin, input);
    expect(saved).toMatchObject({ version: 2, jurisdiction: "Bangladesh", timezone: "Asia/Dhaka", supportedYearStart: 2026, supportedYearEnd: 2026, holidayCount: 5 });
    const rpc = queries(calls).filter(c => c.method === "rpc");
    expect(rpc).toEqual([{ target: "rpc:load_holiday_calendar", method: "rpc", args: [{
      p_jurisdiction: "Bangladesh", p_timezone: "Asia/Dhaka", p_year_start: 2026, p_year_end: 2026, p_source: "bangladesh-2026.csv",
      p_holidays: calendar2026.holidays, p_purpose: "live",
    }] }]);
    // Never a direct table write.
    expect(queries(calls).filter(c => ["insert", "update", "delete"].includes(c.method))).toEqual([]);
    expect(versions.find(v => v.id === V1)).toEqual(versionRow(V1, 1));
  });

  it("loads a test calendar with p_purpose 'test' (only tests do), which never becomes active or listed", async () => {
    const versions = [versionRow(V1, 1)];
    const { client, calls } = fakeClient(versions, []);
    const store = storeFor(client);
    const saved = await store.load(admin, { ...input, purpose: "test" });
    expect(saved.version).toBe(2);
    expect(queries(calls).find(c => c.method === "rpc")?.args[0]).toMatchObject({ p_purpose: "test" });
    expect((await store.active(admin))?.version.id).toBe(V1);
    expect((await store.versions(admin)).map(v => v.id)).toEqual([V1]);
  });

  it("rejects a purpose other than live or test without a query", async () => {
    const { client, calls } = fakeClient([], []);
    await expect(storeFor(client).load(admin, { ...input, purpose: "staging" as unknown as "live" }))
      .rejects.toBeInstanceOf(HolidayCalendarInputError);
    expect(calls).toHaveLength(0);
  });

  it.each([["an empty", "   "], ["a too-long", "x".repeat(101)]])("rejects %s jurisdiction without a query", async (_label, jurisdiction) => {
    const { client, calls } = fakeClient([], []);
    await expect(storeFor(client).load(admin, { ...input, jurisdiction })).rejects.toBeInstanceOf(HolidayCalendarInputError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a too-long source and more than 1000 holidays without a query", async () => {
    const { client, calls } = fakeClient([], []);
    await expect(storeFor(client).load(admin, { ...input, source: "x".repeat(2001) })).rejects.toThrow("source file names are too long");
    const start = Date.UTC(2026, 0, 1);
    const many = Array.from({ length: 1001 }, (_, i) => ({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), name: `H${i}`, kind: "general" as const,
    }));
    await expect(storeFor(client).load(admin, { ...input, calendar: { supportedYearStart: 2026, supportedYearEnd: 2028, holidays: many } }))
      .rejects.toThrow("1000 rows or fewer");
    expect(calls).toHaveLength(0);
  });

  it("rejects holidays outside the supported years without a query", async () => {
    const { client, calls } = fakeClient([], []);
    const bad = { ...calendar2026, supportedYearEnd: 2026, holidays: [...calendar2026.holidays, { date: "2027-01-01", name: "X", kind: "general" as const }] };
    await expect(storeFor(client).load(admin, { ...input, calendar: bad })).rejects.toBeInstanceOf(HolidayCalendarInputError);
    expect(calls).toHaveLength(0);
  });

  it("maps check and unique violations to input errors, and anything else to unavailable", async () => {
    await expect(storeFor(fakeClient([], [], { rpcError: { code: "23514", message: "check" } }).client).load(admin, input))
      .rejects.toBeInstanceOf(HolidayCalendarInputError);
    await expect(storeFor(fakeClient([], [], { rpcError: { code: "23505", message: "dup" } }).client).load(admin, input))
      .rejects.toBeInstanceOf(HolidayCalendarInputError);
    for (const code of ["23502", "22P02"]) {
      await expect(storeFor(fakeClient([], [], { rpcError: { code, message: "bad" } }).client).load(admin, input))
        .rejects.toThrow("The calendar was refused by the database: check its dates, names and kinds.");
    }
    await expect(storeFor(fakeClient([], [], { rpcError: { code: "PGRST202", message: "missing" } }).client).load(admin, input))
      .rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
    await expect(storeFor(fakeClient([], [], { throws: true }).client).load(admin, input)).rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
  });
});

describe("holiday-calendar-store active", () => {
  it("returns null when no calendar has been loaded", async () => {
    expect(await storeFor(fakeClient([], []).client).active(staff)).toBeNull();
  });

  it("returns the highest version and its policy, for any signed-in role", async () => {
    const versions = [versionRow(V1, 1), versionRow(V2, 2, { source: "corrected.csv" })];
    const dates: DateRow[] = [
      { version_id: V1, holiday_date: "2026-02-18", name: "Old", kind: "general" },
      ...calendar2026.holidays.map(h => ({ version_id: V2, holiday_date: h.date, name: h.name, kind: h.kind })),
    ];
    for (const session of [admin, manager, staff]) {
      const { client, calls } = fakeClient(versions, dates);
      const active = await storeFor(client).active(session);
      expect(active?.version).toMatchObject({ id: V2, version: 2, source: "corrected.csv", holidayCount: 5 });
      expect([...active!.policy.holidays]).toEqual(calendar2026.holidays.map(h => h.date));
      expect(active!.policy).toMatchObject({ supportedYearStart: 2026, supportedYearEnd: 2026 });
      expect(queries(calls)).toContainEqual({ target: "holiday_calendar_versions", method: "eq", args: ["purpose", "live"] });
      expect(queries(calls)).toContainEqual({ target: "holiday_calendar_versions", method: "order", args: ["version", { ascending: false }] });
      expect(queries(calls)).toContainEqual({ target: "holiday_calendar_dates", method: "eq", args: ["version_id", V2] });
    }
  });

  it("ignores a higher test version: the active calendar is the highest live one", async () => {
    const dates = calendar2026.holidays.map(h => ({ version_id: V1, holiday_date: h.date, name: h.name, kind: h.kind }));
    const versions = [versionRow(V1, 1), versionRow(V2, 2, { jurisdiction: "E2E Calendar x", purpose: "test" })];
    const active = await storeFor(fakeClient(versions, dates).client).active(staff);
    expect(active?.version).toMatchObject({ id: V1, jurisdiction: "Bangladesh", holidayCount: 5 });
    expect(await storeFor(fakeClient([versionRow(V2, 2, { purpose: "test" })], []).client).active(staff)).toBeNull();
  });

  it("gives a policy countWorkingDays accepts, with UNSUPPORTED_YEAR outside the years", async () => {
    const dates = calendar2026.holidays.map(h => ({ version_id: V1, holiday_date: h.date, name: h.name, kind: h.kind }));
    const active = await storeFor(fakeClient([versionRow(V1, 1)], dates).client).active(staff);
    expect(countWorkingDays("2026-02-01", "2026-02-28", active!.policy)).toBe(17);
    expect(() => countWorkingDays("2027-02-01", "2027-02-03", active!.policy)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_YEAR" }));
    expect(() => countWorkingDays("2027-02-01", "2027-02-03", active!.policy)).toThrow(LeaveValidationError);
  });

  it("reports unavailable on a read error or a network failure, never null", async () => {
    await expect(storeFor(fakeClient([], [], { readError: { code: "PGRST205", message: "missing" } }).client).active(admin))
      .rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
    await expect(storeFor(fakeClient([], [], { throws: true }).client).active(admin)).rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
  });
});

describe("holiday-calendar-store versions", () => {
  it("lists every live version newest first, with holiday counts (test versions never)", async () => {
    const dates: DateRow[] = [
      { version_id: V1, holiday_date: "2026-02-18", name: "A", kind: "general" },
      { version_id: V2, holiday_date: "2026-02-18", name: "A", kind: "general" },
      { version_id: V2, holiday_date: "2026-02-19", name: "B", kind: "special" },
    ];
    const test = versionRow("ca1e0000-0000-4000-8000-000000000003", 3, { purpose: "test" });
    const { client, calls } = fakeClient([versionRow(V1, 1), versionRow(V2, 2), test], dates);
    const list = await storeFor(client).versions(admin);
    expect(list.map(v => [v.version, v.holidayCount])).toEqual([[2, 2], [1, 1]]);
    expect(queries(calls)[0]).toEqual({
      target: "holiday_calendar_versions", method: "select",
      args: ["id,version,jurisdiction,timezone,supported_year_start,supported_year_end,source,loaded_by,loaded_at,holiday_calendar_dates(count)"],
    });
    expect(queries(calls)[1]).toEqual({ target: "holiday_calendar_versions", method: "eq", args: ["purpose", "live"] });
  });

  it("returns an empty list when none is loaded, and unavailable on an error", async () => {
    expect(await storeFor(fakeClient([], []).client).versions(admin)).toEqual([]);
    await expect(storeFor(fakeClient([], [], { readError: { code: "42P01", message: "missing" } }).client).versions(admin))
      .rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
  });
});
