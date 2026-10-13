import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createStubLmsClient, LMS_STALE_AFTER_MS, LMS_TIMEOUT_MS, LmsUnavailableError, toEnrolment, type LmsStubRow,
} from "@/server/lms-client";

type Mode = "ok" | "error" | "throw" | "null";
type Call = { table: string; method: string; args: unknown[] };

/** Minimal stand-in for the supabase-js query builder: records every call and applies eq filters to rows. */
function fakeClient(rows: LmsStubRow[], mode: Mode = "ok") {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      if (mode === "throw") throw new TypeError("fetch failed");
      const query: Call[] = [];
      calls.push(query);
      const record = (method: string, args: unknown[]) => query.push({ table, method, args });
      const result = () => {
        if (mode === "error") return { data: null, error: { code: "PGRST205", message: "relation does not exist" } };
        if (mode === "null") return { data: null, error: null };
        const filters = query.filter(c => c.method === "eq").map(c => c.args as [string, unknown]);
        return { data: rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)), error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        returns: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const NOW = new Date("2026-10-12T06:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const clientFor = (client: SupabaseClient) => createStubLmsClient({ userClient: async () => client, now: () => NOW });

const inProgress = (employee_id: string, id: string, synced_at = hoursAgo(1)): LmsStubRow => ({
  id, employee_id, programme: `Programme ${id}`, provider: "BS23 Learning & Development", status: "in_progress", progress: 60,
  target_date: "2026-12-01", completed_on: null, result: "", synced_at,
});
const completed = (employee_id: string, id: string, synced_at = hoursAgo(2)): LmsStubRow => ({
  ...inProgress(employee_id, id, synced_at), status: "completed", progress: 100, target_date: null, completed_on: "2026-09-15", result: "Passed",
});

describe("lms-client stub mapping", () => {
  it("maps a stub row to the Enrolment contract", () => {
    expect(toEnrolment(inProgress("BS-1001", "a"))).toEqual({
      id: "a", employeeId: "BS-1001", programme: "Programme a", provider: "BS23 Learning & Development", status: "in_progress",
      progress: 60, targetDate: "2026-12-01", completedOn: null, result: "",
    });
    expect(toEnrolment(completed("BS-1001", "b"))).toMatchObject({ status: "completed", progress: 100, targetDate: null, completedOn: "2026-09-15", result: "Passed" });
  });

  it("uses a 24-hour staleness threshold", () => {
    expect(LMS_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("lms-client stub reads", () => {
  it("reads one employee's rows from lms_stub_enrolments, filtered in the query", async () => {
    const { client, calls } = fakeClient([inProgress("BS-1001", "a"), inProgress("BS-1002", "b")]);
    const result = await clientFor(client).listCurrentEnrolments("BS-1001");
    expect(result.data.map(e => e.id)).toEqual(["a"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].every(c => c.table === "lms_stub_enrolments")).toBe(true);
    expect(calls[0]).toContainEqual({ table: "lms_stub_enrolments", method: "eq", args: ["employee_id", "BS-1001"] });
    // Soonest target first (completed rows, with no target date, last), then newest completion, then id.
    expect(calls[0].filter(c => c.method === "order").map(c => c.args)).toEqual([
      ["target_date", { ascending: true, nullsFirst: false }],
      ["completed_on", { ascending: false }],
      ["id", { ascending: true }],
    ]);
  });

  it("is fresh when every row synced within 24 hours, dated by the oldest sync", async () => {
    const { client } = fakeClient([inProgress("BS-1001", "a", hoursAgo(1)), completed("BS-1001", "b", hoursAgo(23))]);
    const result = await clientFor(client).listCurrentEnrolments("BS-1001");
    expect(result).toMatchObject({ asOf: hoursAgo(23), stale: false });
    expect(result.data.map(e => e.status)).toEqual(["in_progress", "completed"]);
  });

  it("is stale (and does not throw) when the oldest sync is more than 24 hours ago", async () => {
    const { client } = fakeClient([inProgress("BS-1001", "a", hoursAgo(1)), inProgress("BS-1001", "b", hoursAgo(25))]);
    expect(await clientFor(client).listCurrentEnrolments("BS-1001")).toMatchObject({ asOf: hoursAgo(25), stale: true });
  });

  it("is not stale at exactly 24 hours", async () => {
    const { client } = fakeClient([inProgress("BS-1001", "a", hoursAgo(24))]);
    expect((await clientFor(client).listCurrentEnrolments("BS-1001")).stale).toBe(false);
  });

  it("returns no enrolments, as of the read time and not stale, when there are no rows", async () => {
    const { client } = fakeClient([]);
    expect(await clientFor(client).listCurrentEnrolments("BS-1001")).toEqual({ data: [], asOf: NOW.toISOString(), stale: false });
  });

  it("treats an unreadable sync time as stale, never as fresh", async () => {
    const { client } = fakeClient([inProgress("BS-1001", "a", "not a time")]);
    expect((await clientFor(client).listCurrentEnrolments("BS-1001")).stale).toBe(true);
  });

  it("never returns another employee's rows, even if the database returned them", async () => {
    // A builder that ignores filters: the stub still keeps only the requested employee's rows.
    const builder = fakeClient([inProgress("BS-1002", "x")]).client.from("lms_stub_enrolments") as unknown as Record<string, unknown>;
    builder.eq = () => builder;
    const client = { from: () => builder } as unknown as SupabaseClient;
    expect((await clientFor(client).listCurrentEnrolments("BS-1001")).data).toEqual([]);
  });

  it("has no write path", () => {
    expect(Object.keys(clientFor(fakeClient([]).client))).toEqual(["listCurrentEnrolments"]);
  });
});

describe("lms-client stub unavailability", () => {
  for (const mode of ["error", "throw", "null"] as const) {
    it(`throws LmsUnavailableError (never "no enrolments") when the read fails (${mode})`, async () => {
      const { client } = fakeClient([inProgress("BS-1001", "a")], mode);
      await expect(clientFor(client).listCurrentEnrolments("BS-1001")).rejects.toBeInstanceOf(LmsUnavailableError);
    });
  }

  it("throws LmsUnavailableError when the read never answers (timeout, 10 s by default)", async () => {
    expect(LMS_TIMEOUT_MS).toBe(10_000);
    const hung = { from: () => ({ select: () => hung.builder }), builder: {} as Record<string, unknown> };
    Object.assign(hung.builder, {
      eq: () => hung.builder, order: () => hung.builder, returns: () => hung.builder,
      then: () => new Promise(() => {}),
    });
    const lms = createStubLmsClient({ userClient: async () => hung as unknown as SupabaseClient, now: () => NOW, timeoutMs: 20 });
    await expect(lms.listCurrentEnrolments("BS-1001")).rejects.toBeInstanceOf(LmsUnavailableError);
  });

  it("throws LmsUnavailableError when the user client cannot be created", async () => {
    const lms = createStubLmsClient({ userClient: async () => { throw new Error("Supabase is not configured"); }, now: () => NOW });
    await expect(lms.listCurrentEnrolments("BS-1001")).rejects.toBeInstanceOf(LmsUnavailableError);
  });
});
