import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { employees as fixture, trainingSeedId } from "@/data/employees";
import {
  createTrainingStore, fixtureInProgress, toTraining, TrainingUnavailableError, type TrainingRow,
} from "@/server/training-store";

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
        return { data: rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)), error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
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

const storeFor = (client: SupabaseClient) => createTrainingStore({ userClient: async () => client });
const COLUMNS = "id,employee_id,programme,provider,result,completed_on";

const row = (employee_id: string, id: string, completed_on = "2026-08-20"): TrainingRow => ({
  id, employee_id, programme: `Programme ${id}`, provider: "BS23 Learning & Development", result: "Completed · assessment passed", completed_on,
});
// As the database returns them: ordered by completion date, newest first.
const rows = [row("BS-1001", "a", "2026-09-01"), row("BS-1002", "b", "2026-08-25"), row("BS-1001", "c", "2026-08-20")];
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;

const inProgressIds = (employeeId?: string) => fixture
  .filter(e => employeeId === undefined || e.id === employeeId)
  .flatMap(e => e.training.filter(t => t.progress < 100).map(t => t.id));

describe("training-store mapping", () => {
  it("maps a stored row to a completed entry dated by its completion date", () => {
    expect(toTraining(rows[0])).toEqual({
      id: "a", employeeId: "BS-1001", name: "Programme a", provider: "BS23 Learning & Development",
      progress: 100, date: "2026-09-01", result: "Completed · assessment passed",
    });
  });

  it("serves the fixture's in-progress entries only, in fixture order, with their employee", () => {
    const nadia = fixture.find(e => e.id === "BS-1001")!;
    expect(fixtureInProgress(fixture, "BS-1001")).toEqual([{ ...nadia.training[1], employeeId: "BS-1001" }]);
    expect(fixtureInProgress(fixture).every(t => t.progress < 100)).toBe(true);
    expect(fixtureInProgress(fixture).map(t => t.employeeId)).toEqual(fixture.map(e => e.id));
    expect(fixtureInProgress(fixture, "BS-9999")).toEqual([]);
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
    ]);
    // Completed entries (table order) first, then every in-progress entry in fixture order.
    expect(list.map(t => t.id)).toEqual(["a", "b", "c", ...inProgressIds()]);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient(rows);
    const list = await storeFor(client).listFor(admin, "BS-1002");
    expect(list.map(t => t.id)).toEqual(["b", trainingSeedId("BS-1002", 1)]);
    expect(calls[0]).toContainEqual({ table: "training_history", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("filters staff reads to the session's own employee in the query, and their own in-progress entries", async () => {
    const { client, calls } = fakeClient(rows);
    const expected = ["a", "c", trainingSeedId("BS-1001", 1)];
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
    expect((await storeFor(leaky).listFor(staff)).map(t => t.employeeId)).toEqual(["BS-1001", "BS-1001", "BS-1001"]);
  });

  it("returns only in-progress entries when there is no completed history, and nothing for an unknown employee", async () => {
    const { client } = fakeClient([]);
    expect((await storeFor(client).listFor(staff)).map(t => t.progress < 100)).toEqual([true]);
    expect(await storeFor(client).listFor(admin, "BS-9999")).toEqual([]);
  });

  it("gives every entry a unique id across stored and fixture entries", async () => {
    const seeded = fixture.flatMap(e => e.training.filter(t => t.progress === 100).map(t => row(e.id, t.id, t.date)));
    const { client } = fakeClient(seeded);
    const ids = (await storeFor(client).listFor(admin)).map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns copies, so callers cannot change the in-progress source", async () => {
    const { client } = fakeClient([]);
    const [first] = await storeFor(client).listFor(staff);
    first.name = "Changed";
    expect(fixture.find(e => e.id === "BS-1001")!.training[1].name).not.toBe("Changed");
  });

  it("has no write path", () => {
    const { client } = fakeClient([]);
    expect(Object.keys(storeFor(client))).toEqual(["listFor"]);
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
    const store = createTrainingStore({ userClient: async () => { throw new Error("Supabase is not configured"); } });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(TrainingUnavailableError);
  });
});
