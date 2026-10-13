import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { LmsUnavailableError, type Enrolment, type EnrolmentsResult, type LmsClient } from "@/server/lms-client";
import {
  courseKey, createTrainingStore, dedupeLmsCompleted, enrolmentToTraining, toTraining, TrainingUnavailableError,
  type TrainingEntry, type TrainingRow,
} from "@/server/training-store";
import { many, pagedClient } from "./support/paged-client";

type Mode = "ok" | "error" | "throw" | "null";
type Call = { table: string; method: string; args: unknown[] };

/** Minimal stand-in for the supabase-js query builder: records every call and applies eq filters to rows. */
function fakeClient(rows: TrainingRow[], mode: Mode = "ok") {
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
        const inFilters = query.filter(c => c.method === "in").map(c => c.args as [string, unknown[]]);
        return {
          data: rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)
            && inFilters.every(([col, vals]) => vals.includes((r as Record<string, unknown>)[col]))),
          error: null,
        };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        in: (...args: unknown[]) => { record("in", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        range: (...args: unknown[]) => { record("range", args); return builder; },
        insert: (...args: unknown[]) => { record("insert", args); return builder; },
        update: (...args: unknown[]) => { record("update", args); return builder; },
        delete: (...args: unknown[]) => { record("delete", args); return builder; },
        returns: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** Stand-in for lms-client: per-employee answers (or a failure), recording every call. */
function fakeLms(answers: Record<string, EnrolmentsResult | Error> = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const lms: Pick<LmsClient, "listCurrentEnrolments"> = {
    async listCurrentEnrolments(employeeId) {
      calls.push(employeeId);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      const answer = answers[employeeId] ?? { data: [], asOf: FRESH, stale: false };
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
  };
  return { lms, calls, maxInFlight: () => maxInFlight };
}

const NOW = new Date("2026-10-12T06:00:00.000Z");
const FRESH = "2026-10-12T05:00:00.000Z";
const storeFor = (client: SupabaseClient, lms = fakeLms().lms) => createTrainingStore({ userClient: async () => client, lms, now: () => NOW });
const COLUMNS = "id,employee_id,programme,provider,result,completed_on";

const row = (employee_id: string, id: string, completed_on = "2026-08-20"): TrainingRow => ({
  id, employee_id, programme: `Programme ${id}`, provider: "BS23 Learning & Development", result: "Completed · assessment passed", completed_on,
});
// As the database returns them: ordered by completion date, newest first.
const rows = [row("BS-1001", "a", "2026-09-01"), row("BS-1002", "b", "2026-08-25"), row("BS-1001", "c", "2026-08-20")];
const admin = { role: "admin" } as const;

function enrolment(employeeId: string, id: string, status: Enrolment["status"], extra: Partial<Enrolment> = {}): Enrolment {
  return status === "in_progress"
    ? { id, employeeId, programme: `Programme ${id}`, provider: "BS23 Learning & Development", status, progress: 60, targetDate: "2026-12-01", completedOn: null, result: "", ...extra }
    : { id, employeeId, programme: `Programme ${id}`, provider: "BS23 Learning & Development", status, progress: 100, targetDate: null, completedOn: "2026-09-15", result: "Passed", ...extra };
}
const answer = (data: Enrolment[], asOf = FRESH, stale = false): EnrolmentsResult => ({ data, asOf, stale });
const staff = { role: "staff", employeeId: "BS-1001" } as const;


describe("training-store mapping", () => {
  it("maps a stored row to a completed entry dated by its completion date", () => {
    expect(toTraining(rows[0])).toEqual({
      id: "a", employeeId: "BS-1001", name: "Programme a", provider: "BS23 Learning & Development",
      progress: 100, date: "2026-09-01", result: "Completed · assessment passed",
    });
  });

  it("maps an in-progress enrolment to its progress, dated by the target date, result In progress", () => {
    expect(enrolmentToTraining(enrolment("BS-1001", "p", "in_progress"))).toEqual({
      id: "p", employeeId: "BS-1001", name: "Programme p", provider: "BS23 Learning & Development", progress: 60, date: "2026-12-01", result: "In progress",
    });
  });

  it("maps a completed enrolment to progress 100, dated by the completion date, with the LMS result", () => {
    expect(enrolmentToTraining(enrolment("BS-1001", "c", "completed"))).toEqual({
      id: "c", employeeId: "BS-1001", name: "Programme c", provider: "BS23 Learning & Development", progress: 100, date: "2026-09-15", result: "Passed",
    });
  });
});

describe("training-store reads", () => {
  it("lists every employee's completed training for an admin, newest first, without an employee filter", async () => {
    const { client, calls } = fakeClient(rows);
    const list = await storeFor(client).listFor(admin);
    expect(calls).toHaveLength(1);
    expect(calls[0].every(c => c.table === "training_history")).toBe(true);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", COLUMNS],
      ["order", "completed_on", { ascending: false }],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["range", 0, 999],
    ]);
    // Stored completed entries only, in table order: nothing comes from the fixture any more.
    expect(list.map(t => t.id)).toEqual(["a", "b", "c"]);
    expect(list.every(t => t.progress === 100)).toBe(true);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient(rows);
    const list = await storeFor(client).listFor(admin, "BS-1002");
    expect(list.map(t => t.id)).toEqual(["b"]);
    expect(calls[0]).toContainEqual({ table: "training_history", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("filters staff reads to the session's own employee in the query", async () => {
    const { client, calls } = fakeClient(rows);
    const expected = ["a", "c"];
    expect((await storeFor(client).listFor(staff)).map(t => t.id)).toEqual(expected);
    expect((await storeFor(client).listFor(staff, "BS-1001")).map(t => t.id)).toEqual(expected);
    for (const query of calls) expect(query).toContainEqual({ table: "training_history", method: "eq", args: ["employee_id", "BS-1001"] });
  });

  it("returns nothing, without a query, when staff ask for another employee's training", async () => {
    const { client, calls } = fakeClient(rows);
    expect(await storeFor(client).listFor(staff, "BS-1002")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("never hands staff another employee's row, even if the database returned one", async () => {
    const { client } = fakeClient(rows);
    // A client that ignores filters: the store still keeps only the session's own rows.
    const leaky = { from: () => { const b = (client.from("training_history") as unknown as Record<string, unknown>); b.eq = () => b; return b; } } as unknown as SupabaseClient;
    expect((await storeFor(leaky).listFor(staff)).map(t => t.employeeId)).toEqual(["BS-1001", "BS-1001"]);
  });

  it("returns nothing when there is no completed history (no fixture fallback)", async () => {
    const { client } = fakeClient([]);
    expect(await storeFor(client).listFor(staff)).toEqual([]);
    expect(await storeFor(client).listFor(admin, "BS-9999")).toEqual([]);
  });

  it("has no write path", () => {
    const { client } = fakeClient([]);
    expect(Object.keys(storeFor(client))).toEqual(["listFor", "currentFor"]);
  });
});

describe("training-store unavailability", () => {
  const calls = (store: ReturnType<typeof createTrainingStore>) => [
    () => store.listFor(admin), () => store.listFor(admin, "BS-1001"), () => store.listFor(staff),
  ];

  for (const mode of ["error", "throw", "null"] as const) {
    it(`throws TrainingUnavailableError (never "no training") when the read fails (${mode})`, async () => {
      const { client } = fakeClient(rows, mode);
      for (const call of calls(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(TrainingUnavailableError);
    });
  }

  it("throws TrainingUnavailableError when the user client cannot be created", async () => {
    const store = createTrainingStore({ userClient: async () => { throw new Error("Supabase is not configured"); }, lms: fakeLms().lms });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(TrainingUnavailableError);
  });
});

describe("training-store current (LMS) enrolments", () => {
  it("splits one employee's enrolments into in progress (Current) and LMS-completed (history)", async () => {
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "p", "in_progress"), enrolment("BS-1001", "c", "completed")]) });
    const { client } = fakeClient([]);
    const current = await storeFor(client, lms).currentFor(staff, ["BS-1001"]);
    expect(current).toEqual({
      status: "ok", asOf: FRESH, stale: false, freshness: { "BS-1001": { asOf: FRESH, stale: false } },
      inProgress: [enrolmentToTraining(enrolment("BS-1001", "p", "in_progress"))],
      lmsCompleted: [enrolmentToTraining(enrolment("BS-1001", "c", "completed"))],
    });
  });

  it("calls the LMS only for the staff member's own id; any other id is dropped without a call", async () => {
    const { lms, calls } = fakeLms({ "BS-1002": answer([enrolment("BS-1002", "x", "in_progress")]) });
    const { client } = fakeClient([]);
    const current = await storeFor(client, lms).currentFor(staff, ["BS-1002", "BS-1001", "BS-1003"]);
    expect(calls).toEqual(["BS-1001"]);
    expect(current).toMatchObject({ status: "ok", inProgress: [] });
    const none = fakeLms();
    expect(await storeFor(client, none.lms).currentFor(staff, ["BS-1002"])).toMatchObject({ status: "ok", inProgress: [], lmsCompleted: [], stale: false });
    expect(none.calls).toEqual([]);
  });

  it("makes one call per employee for an admin, in parallel, and returns everyone's in-progress entries", async () => {
    const ids = ["BS-1001", "BS-1002", "BS-1003"];
    const fake = fakeLms(Object.fromEntries(ids.map(id => [id, answer([enrolment(id, `p-${id}`, "in_progress")])])));
    const { client } = fakeClient([]);
    const current = await storeFor(client, fake.lms).currentFor(admin, [...ids, "BS-1001"]);
    expect(fake.calls).toEqual(ids);
    expect(fake.maxInFlight()).toBe(3);
    expect(current.status === "ok" && current.inProgress.map(t => t.employeeId)).toEqual(ids);
  });

  it("reports the oldest asOf and is stale when any employee's answer is stale", async () => {
    const { lms } = fakeLms({
      "BS-1001": answer([], "2026-10-12T05:00:00.000Z"),
      "BS-1002": answer([enrolment("BS-1002", "p", "in_progress")], "2026-10-10T08:00:00.000Z", true),
      "BS-1003": answer([], "2026-10-11T09:00:00.000Z"),
    });
    const { client } = fakeClient([]);
    expect(await storeFor(client, lms).currentFor(admin, ["BS-1001", "BS-1002", "BS-1003"]))
      .toMatchObject({ status: "ok", asOf: "2026-10-10T08:00:00.000Z", stale: true });
  });

  it("keeps each employee's own freshness alongside the aggregate (mixed fresh and stale)", async () => {
    const { lms } = fakeLms({
      "BS-1001": answer([], "2026-10-12T05:00:00.000Z"),
      "BS-1002": answer([], "2026-10-10T08:00:00.000Z", true),
    });
    const { client } = fakeClient([]);
    const current = await storeFor(client, lms).currentFor(admin, ["BS-1001", "BS-1002"]);
    expect(current).toMatchObject({
      status: "ok", asOf: "2026-10-10T08:00:00.000Z", stale: true,
      freshness: {
        "BS-1001": { asOf: "2026-10-12T05:00:00.000Z", stale: false },
        "BS-1002": { asOf: "2026-10-10T08:00:00.000Z", stale: true },
      },
    });
  });

  it("dates the aggregate by the oldest parseable asOf and is stale when any asOf is unparseable", async () => {
    const { lms } = fakeLms({
      "BS-1001": answer([], "garbage", false),
      "BS-1002": answer([], "2026-10-12T05:00:00.000Z", false),
    });
    const { client } = fakeClient([]);
    const current = await storeFor(client, lms).currentFor(admin, ["BS-1001", "BS-1002"]);
    expect(current).toMatchObject({ status: "ok", asOf: "2026-10-12T05:00:00.000Z", stale: true });
    expect(current.status === "ok" && current.freshness["BS-1001"].stale).toBe(true);
  });

  it("is fresh, as of now, with nothing to list when no employee is in scope", async () => {
    const { client } = fakeClient([]);
    expect(await storeFor(client).currentFor(admin, [])).toEqual({ status: "ok", asOf: NOW.toISOString(), stale: false, inProgress: [], lmsCompleted: [], freshness: {} });
  });

  it("is unavailable (never empty) when any LMS call is unreachable", async () => {
    const { lms } = fakeLms({ "BS-1002": new LmsUnavailableError({ cause: "timeout" }) });
    const { client } = fakeClient([]);
    expect(await storeFor(client, lms).currentFor(admin, ["BS-1001", "BS-1002"])).toEqual({ status: "unavailable" });
    expect(await storeFor(client, lms).currentFor({ role: "staff", employeeId: "BS-1002" }, ["BS-1002"])).toEqual({ status: "unavailable" });
  });

  it("rethrows unexpected errors (the page turns them into unavailable)", async () => {
    const { lms } = fakeLms({ "BS-1001": new TypeError("bug") });
    const { client } = fakeClient([]);
    await expect(storeFor(client, lms).currentFor(staff, ["BS-1001"])).rejects.toBeInstanceOf(TypeError);
  });

  it("leaves out an LMS-completed course already stored in training_history (trimmed, case-insensitive)", async () => {
    const stored = { ...row("BS-1001", "s"), programme: "  react · Practical Foundations ", provider: "bs23 learning & development" };
    const { lms } = fakeLms({
      "BS-1001": answer([
        enrolment("BS-1001", "dup", "completed", { programme: "React · practical foundations" }),
        enrolment("BS-1001", "new", "completed", { programme: "Secure coding" }),
      ]),
    });
    const { client, calls } = fakeClient([stored]);
    const current = await storeFor(client, lms).currentFor(staff, ["BS-1001"]);
    expect(current.status === "ok" && current.lmsCompleted.map(t => t.id)).toEqual(["new"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContainEqual({ table: "training_history", method: "in", args: ["employee_id", ["BS-1001"]] });
  });

  it("deduplicates per employee: the same course stored for someone else does not hide it", async () => {
    const { lms } = fakeLms({ "BS-1002": answer([enrolment("BS-1002", "c", "completed", { programme: "Programme a" })]) });
    const { client } = fakeClient([row("BS-1001", "a")]);
    const current = await storeFor(client, lms).currentFor(admin, ["BS-1001", "BS-1002"]);
    expect(current.status === "ok" && current.lmsCompleted.map(t => t.id)).toEqual(["c"]);
  });

  it("does not read training_history when the LMS reports nothing completed", async () => {
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "p", "in_progress")]) });
    const { client, calls } = fakeClient([], "error");
    expect((await storeFor(client, lms).currentFor(staff, ["BS-1001"])).status).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  for (const mode of ["error", "throw", "null"] as const) {
    it(`is unavailable when the history read used to deduplicate fails (${mode})`, async () => {
      const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "c", "completed")]) });
      const { client } = fakeClient([], mode);
      expect(await storeFor(client, lms).currentFor(staff, ["BS-1001"])).toEqual({ status: "unavailable" });
    });
  }

  it("never puts an entry in both Current and history", async () => {
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "p", "in_progress"), enrolment("BS-1001", "c", "completed")]) });
    const { client } = fakeClient([]);
    const current = await storeFor(client, lms).currentFor(staff, ["BS-1001"]);
    if (current.status !== "ok") throw new Error("expected ok");
    expect(current.inProgress.every(t => t.progress < 100)).toBe(true);
    expect(current.lmsCompleted.every(t => t.progress === 100)).toBe(true);
    const ids = [...current.inProgress, ...current.lmsCompleted].map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops enrolments the LMS returned for an employee that was not asked for", async () => {
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1002", "leak", "in_progress")]) });
    const { client } = fakeClient([]);
    expect(await storeFor(client, lms).currentFor(staff, ["BS-1001"])).toMatchObject({ inProgress: [] });
  });
});

describe("training-store dedupe helper", () => {
  const entry = (employeeId: string, id: string, name: string, provider = "Provider"): TrainingEntry => ({
    id, employeeId, name, provider, progress: 100, date: "2026-09-15", result: "Passed",
  });

  it("keys a course by employee and trimmed, case-insensitive programme and provider", () => {
    expect(courseKey("BS-1001", " Cloud ", "AWS ")).toBe(courseKey("BS-1001", "cloud", "aws"));
    expect(courseKey("BS-1001", "Cloud", "AWS")).not.toBe(courseKey("BS-1002", "Cloud", "AWS"));
    expect(courseKey("BS-1001", "Cloud", "AWS")).not.toBe(courseKey("BS-1001", "Cloud", "Azure"));
  });

  it("keeps the stored entry and shows each LMS-completed course once", () => {
    const lms = [entry("BS-1001", "1", "Cloud"), entry("BS-1001", "2", "CLOUD "), entry("BS-1001", "3", "Docker"), entry("BS-1001", "4", "Kubernetes")];
    const stored = [{ employeeId: "BS-1001", programme: "docker", provider: "provider" }];
    expect(dedupeLmsCompleted(lms, stored).map(t => t.id)).toEqual(["1", "4"]);
  });
});

describe("training-store paging (Story 8.2)", () => {
  const rowAt = (i: number) => row("BS-1001", `row-${i}`);

  it("reads 1000-row pages until a short page, using every row", async () => {
    const { client, ranges } = pagedClient([many(1000, rowAt), many(1000, rowAt, 1000), many(3, rowAt, 2000)]);
    const all = await storeFor(client).listFor(admin);
    expect(all).toHaveLength(2003);
    expect(all[2002].id).toBe("row-2002");
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("throws the unavailable error when a later page fails", async () => {
    const { client, requests } = pagedClient([many(1000, rowAt), "error", many(3, rowAt)]);
    await expect(storeFor(client).listFor(admin)).rejects.toBeInstanceOf(TrainingUnavailableError);
    expect(requests()).toBe(2);
  });
});

describe("training-store currentFor at bulk scale (Story 8.2)", () => {
  it("dedupes LMS-completed courses against stored history that spans pages", async () => {
    const stored = (i: number) => ({ employee_id: "BS-1001", programme: `Programme s${i}`, provider: "BS23 Learning & Development" });
    const { client, ranges, ins } = pagedClient([many(1000, stored), many(3, stored, 1000)]);
    // Both courses are stored only on the second page (indices 1000 and 1002).
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "s1000", "completed"), enrolment("BS-1001", "s1002", "completed")]) });
    const result = await storeFor(client, lms).currentFor(admin, ["BS-1001"]);
    expect(result).toMatchObject({ status: "ok", lmsCompleted: [] });
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(ins).toEqual([["BS-1001"], ["BS-1001"]]);
  });

  it("reads stored history for the owners in batches of 100", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `BS-${String(2000 + i)}`);
    const { client, ins } = pagedClient<never>([[], []]);
    const { lms } = fakeLms(Object.fromEntries(ids.map(id => [id, answer([enrolment(id, `c-${id}`, "completed")])])));
    const result = await storeFor(client, lms).currentFor(admin, ids);
    expect(result.status === "ok" && result.lmsCompleted).toHaveLength(150);
    expect(ins.map(batch => batch.length)).toEqual([100, 50]);
    expect(ins.flat()).toEqual(ids);
  });

  it("maps a failed later dedupe page to unavailable", async () => {
    const stored = (i: number) => ({ employee_id: "BS-1001", programme: `Programme s${i}`, provider: "x" });
    const { client } = pagedClient([many(1000, stored), "error"]);
    const { lms } = fakeLms({ "BS-1001": answer([enrolment("BS-1001", "z", "completed")]) });
    expect(await storeFor(client, lms).currentFor(admin, ["BS-1001"])).toEqual({ status: "unavailable" });
  });

  it("keeps at most 8 LMS calls in flight, with results in id order", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `BS-${String(3000 + i)}`);
    const fake = fakeLms(Object.fromEntries(ids.map(id => [id, answer([enrolment(id, `p-${id}`, "in_progress")])])));
    const result = await storeFor(fakeClient([]).client, fake.lms).currentFor(admin, ids);
    expect(fake.calls).toHaveLength(20);
    expect(fake.maxInFlight()).toBe(8);
    expect(result.status === "ok" && result.inProgress.map(e => e.employeeId)).toEqual(ids);
    expect(result.status === "ok" && Object.keys(result.freshness)).toEqual(ids);
  });

  it("still reports the LMS as unavailable when one bounded call fails", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `BS-${String(3000 + i)}`);
    const fake = fakeLms({ "BS-3005": new LmsUnavailableError() });
    expect(await storeFor(fakeClient([]).client, fake.lms).currentFor(admin, ids)).toEqual({ status: "unavailable" });
  });
});
