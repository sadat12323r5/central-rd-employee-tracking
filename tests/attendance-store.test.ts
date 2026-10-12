import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { TimesheetValidationError, type TimesheetEntry } from "@/domain/timesheet";
import { AttendanceUnavailableError, createAttendanceStore, toEntry, toRow, type AttendanceRow } from "@/server/attendance-store";

type Mode = "ok" | "error" | "throw" | "duplicate";
type Call = { table: string; method: string; args: unknown[] };

/** Minimal stand-in for the supabase-js query builder: records every call and applies eq filters to rows. */
function fakeClient(rows: AttendanceRow[], mode: Mode = "ok") {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        if (mode === "error") return { data: null, error: { code: "PGRST000", message: "connection refused" } };
        if (mode === "duplicate") return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        const filters = query.filter(c => c.method === "eq").map(c => c.args as [string, string]);
        return { data: rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)), error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        returns: () => builder,
        upsert: (...args: unknown[]) => { record("upsert", args); return builder; },
        delete: (...args: unknown[]) => { record("delete", args); return builder; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const storeFor = (client: SupabaseClient) => createAttendanceStore({ userClient: async () => client });

const row: AttendanceRow = {
  id: "0d9c7a52-6f43-4a39-9a1e-3c6f1c5b2a01", employee_id: "BS-1001", work_date: "2026-09-28",
  clock_in: "2026-09-28T03:00:00+00:00", clock_out: "2026-09-28T11:30:00.250+00:00", break_minutes: 30, work_mode: "Remote",
  log: { summary: "Attendance page", blockers: "", tasks: [{ description: "Form", hours: 4, link: "https://example.com/pr/1" }], updatedAt: "2026-09-28T11:00:00.000Z" },
};
const entry: TimesheetEntry = {
  id: row.id, employeeId: "BS-1001", date: "2026-09-28", clockIn: "2026-09-28T03:00:00.000Z", clockOut: "2026-09-28T11:30:00.250Z",
  breakMinutes: 30, workMode: "Remote", log: row.log,
};

describe("attendance-store mapping", () => {
  it("maps a row to an entry, normalising timestamps to UTC ISO", () => {
    expect(toEntry(row)).toEqual(entry);
  });

  it("maps an open entry with no log", () => {
    expect(toEntry({ ...row, clock_out: null, log: null })).toMatchObject({ clockOut: null, log: null });
  });

  it("maps an entry to a row", () => {
    expect(toRow(entry)).toEqual({ ...row, clock_in: entry.clockIn, clock_out: entry.clockOut });
    expect(toRow({ ...entry, clockOut: null, log: null })).toMatchObject({ clock_out: null, log: null });
  });

  it("round-trips an entry", () => {
    expect(toEntry(toRow(entry))).toEqual(entry);
  });
});

describe("attendance-store queries", () => {
  it("lists one employee's entries newest first, filtering by employee in the query", async () => {
    const other = { ...row, id: "other", employee_id: "BS-1002" };
    const { client, calls } = fakeClient([row, other]);
    expect(await storeFor(client).listForEmployee("BS-1001")).toEqual([entry]);
    expect(calls).toHaveLength(1);
    expect(calls[0].every(c => c.table === "attendance_entries")).toBe(true);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", "id,employee_id,work_date,clock_in,clock_out,break_minutes,work_mode,log"],
      ["eq", "employee_id", "BS-1001"],
      ["order", "work_date", { ascending: false }],
      ["order", "clock_in", { ascending: false }],
    ]);
  });

  it("lists all entries newest first without an employee filter (RLS scopes the rows)", async () => {
    const other = { ...row, id: "other", employee_id: "BS-1002" };
    const { client, calls } = fakeClient([row, other]);
    expect((await storeFor(client).listAll()).map(e => e.employeeId)).toEqual(["BS-1001", "BS-1002"]);
    expect(calls[0].map(c => c.method)).toEqual(["select", "order", "order"]);
  });

  it("saves by upserting the row on id, with a fresh updated_at", async () => {
    const { client, calls } = fakeClient([]);
    await storeFor(client).save(entry);
    expect(calls[0]).toHaveLength(1);
    const [{ method, args }] = calls[0];
    expect(method).toBe("upsert");
    const [payload, options] = args as [Record<string, unknown>, unknown];
    expect(options).toEqual({ onConflict: "id" });
    expect(payload).toMatchObject(toRow(entry));
    expect(Number.isNaN(Date.parse(String(payload.updated_at)))).toBe(false);
    expect(payload).not.toHaveProperty("created_at");
  });

  it("maps a same-day unique violation (23505) to ALREADY_RECORDED", async () => {
    const { client } = fakeClient([], "duplicate");
    const error = await storeFor(client).save(entry).catch(e => e);
    expect(error).toBeInstanceOf(TimesheetValidationError);
    expect(error).toMatchObject({ code: "ALREADY_RECORDED", message: "Today's attendance is already recorded." });
  });

  it("never deletes: clear() throws without touching the database", async () => {
    const { client, calls } = fakeClient([row]);
    await expect(storeFor(client).clear()).rejects.toThrow(/never deleted/);
    expect(calls).toHaveLength(0);
  });
});

describe("attendance-store unavailability", () => {
  const actions = (store: ReturnType<typeof createAttendanceStore>) => [
    () => store.listForEmployee("BS-1001"), () => store.listAll(), () => store.save(entry),
  ];

  it("throws AttendanceUnavailableError when the database returns an error (including an RLS refusal)", async () => {
    const { client } = fakeClient([row], "error");
    for (const call of actions(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(AttendanceUnavailableError);
    const rls = { from: () => ({ upsert: async () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } }) }) };
    await expect(storeFor(rls as unknown as SupabaseClient).save(entry)).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });

  it("throws AttendanceUnavailableError when the client throws (network failure)", async () => {
    const { client } = fakeClient([row], "throw");
    for (const call of actions(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });

  it("throws AttendanceUnavailableError when the user client cannot be created (unconfigured)", async () => {
    const store = createAttendanceStore({ userClient: async () => { throw new Error("Supabase is not configured"); } });
    for (const call of actions(store)) await expect(call()).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });

  it("treats a list with no data as unavailable, never as empty", async () => {
    const empty = { from: () => { const b = { select: () => b, eq: () => b, order: () => b, returns: async () => ({ data: null, error: null }) }; return b; } };
    await expect(storeFor(empty as unknown as SupabaseClient).listAll()).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });
});
