import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createInterviewsStore, InterviewLockedError, InterviewNotFoundError, InterviewsForbiddenError, InterviewsUnavailableError,
  InterviewWithdrawnError, toInterview, type InterviewChanges, type InterviewRow, type NewInterview,
} from "@/server/interviews-store";
import { many, pagedClient } from "./support/paged-client";

type Mode = "ok" | "error" | "throw" | "foreign" | "update-error" | "update-none";
type Call = { table: string; method: string; args: unknown[] };

/**
 * Minimal stand-in for the supabase-js query builder: records every call and applies eq / is filters to
 * rows. An update applies its values to the matching rows (so tests can inspect them) and returns them.
 */
function fakeClient(rows: InterviewRow[], mode: Mode = "ok") {
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
          const row = { id: "new-id", feedback: "", withdrawn_at: null, ...(inserted.args[0] as object) } as InterviewRow;
          return { data: mode === "foreign" ? { ...row, employee_id: "BS-1008" } : row, error: null };
        }
        const filters = query.filter(c => c.method === "eq" || c.method === "is").map(c => c.args as [string, unknown]);
        const matching = rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val));
        const updated = query.find(c => c.method === "update");
        if (updated) {
          if (mode === "update-error") return { data: null, error: { code: "23514", message: "locked" } };
          if (mode === "update-none") return { data: null, error: null };
          for (const r of matching) Object.assign(r, updated.args[0]);
        }
        const one = query.some(c => c.method === "maybeSingle");
        return { data: one ? (matching[0] ?? null) : matching, error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        range: (...args: unknown[]) => { record("range", args); return builder; },
        insert: (...args: unknown[]) => { record("insert", args); return builder; },
        update: (...args: unknown[]) => { record("update", args); return builder; },
        is: (...args: unknown[]) => { record("is", args); return builder; },
        maybeSingle: () => { record("maybeSingle", []); return builder; },
        returns: () => builder,
        single: () => { record("single", []); return builder; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const storeFor = (client: SupabaseClient) => createInterviewsStore({ userClient: async () => client });
const COLUMNS = "id,employee_id,company,role,stage,interview_date,outcome,feedback,withdrawn_at";

const row = (employee_id: string, id: string): InterviewRow => ({
  id, employee_id, company: "Northstar Labs (fictional)", role: "Software Engineer I", stage: "Technical interview",
  interview_date: "2026-09-23", outcome: "Scheduled", feedback: "Prepare examples.", withdrawn_at: null,
});
const rows = [row("BS-1001", "a"), row("BS-1002", "b"), row("BS-1001", "c")];
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const input: NewInterview = { company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "" };

describe("interviews-store mapping", () => {
  it("maps a row to an interview with its employee", () => {
    expect(toInterview(rows[0])).toEqual({
      id: "a", employeeId: "BS-1001", company: "Northstar Labs (fictional)", role: "Software Engineer I",
      date: "2026-09-23", stage: "Technical interview", outcome: "Scheduled", feedback: "Prepare examples.", withdrawn: false,
    });
  });

  it("maps withdrawn_at to withdrawn", () => {
    expect(toInterview({ ...rows[0], withdrawn_at: "2026-10-12T05:00:00Z" }).withdrawn).toBe(true);
  });
});

describe("interviews-store reads", () => {
  it("lists every interview for an admin, newest first, without an employee filter", async () => {
    const { client, calls } = fakeClient(rows);
    expect((await storeFor(client).listFor(admin)).map(i => i.id)).toEqual(["a", "b", "c"]);
    expect(calls[0].every(c => c.table === "external_interviews")).toBe(true);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["select", COLUMNS],
      ["order", "interview_date", { ascending: false }],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["range", 0, 999],
    ]);
  });

  it("narrows an admin read to one employee when asked", async () => {
    const { client, calls } = fakeClient(rows);
    expect((await storeFor(client).listFor(admin, "BS-1002")).map(i => i.id)).toEqual(["b"]);
    expect(calls[0]).toContainEqual({ table: "external_interviews", method: "eq", args: ["employee_id", "BS-1002"] });
  });

  it("filters staff reads to the session's own employee in the query", async () => {
    const { client, calls } = fakeClient(rows);
    expect((await storeFor(client).listFor(staff)).map(i => i.id)).toEqual(["a", "c"]);
    expect((await storeFor(client).listFor(staff, "BS-1001")).map(i => i.id)).toEqual(["a", "c"]);
    for (const query of calls) expect(query).toContainEqual({ table: "external_interviews", method: "eq", args: ["employee_id", "BS-1001"] });
  });

  it("returns nothing, without a query, when staff ask for another employee's interviews", async () => {
    const { client, calls } = fakeClient(rows);
    expect(await storeFor(client).listFor(staff, "BS-1002")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("interviews-store add", () => {
  it("adds an interview for the session's employee, with empty feedback", async () => {
    const { client, calls } = fakeClient([]);
    const saved = await storeFor(client).add(staff, input);
    expect(saved).toEqual({ id: "new-id", employeeId: "BS-1001", ...input, feedback: "", withdrawn: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([
      ["insert", { employee_id: "BS-1001", company: "Orbit Analytics", role: "AI Engineer", stage: "Recruiter screen", interview_date: "2026-10-20", outcome: "" }],
      ["select", COLUMNS],
      ["single"],
    ]);
  });

  it("ignores any employee id smuggled into the input", async () => {
    const { client, calls } = fakeClient([]);
    const forged = { ...input, employeeId: "BS-1008", employee_id: "BS-1008" } as NewInterview;
    expect((await storeFor(client).add(staff, forged)).employeeId).toBe("BS-1001");
    expect((calls[0][0].args[0] as Record<string, unknown>).employee_id).toBe("BS-1001");
  });

  it("refuses an admin session without querying (Administrators are read-only)", async () => {
    const { client, calls } = fakeClient([]);
    await expect(storeFor(client).add(admin, input)).rejects.toBeInstanceOf(InterviewsForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("never reports a row stored for another employee as saved", async () => {
    const { client } = fakeClient([], "foreign");
    await expect(storeFor(client).add(staff, input)).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });
});

const ID = "a";
const changes: InterviewChanges = { stage: "Offer stage", outcome: "Offer received", feedback: "Strong system design round." };
const freshRows = () => [row("BS-1001", "a"), row("BS-1008", "f"), { ...row("BS-1001", "w"), withdrawn_at: "2026-10-01T00:00:00Z" }];

describe("interviews-store update (Story 2.2)", () => {
  it("updates only stage, outcome and feedback of the author's own active entry", async () => {
    const data = freshRows();
    const { client, calls } = fakeClient(data);
    const saved = await storeFor(client).update(staff, ID, changes);
    expect(saved).toMatchObject({ id: "a", employeeId: "BS-1001", company: "Northstar Labs (fictional)", date: "2026-09-23", ...changes, withdrawn: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].map(c => [c.method, ...c.args])).toEqual([["select", COLUMNS], ["eq", "id", ID], ["maybeSingle"]]);
    expect(calls[1].map(c => [c.method, ...c.args])).toEqual([
      ["update", changes],
      ["eq", "id", ID], ["eq", "employee_id", "BS-1001"], ["is", "withdrawn_at", null],
      ["select", COLUMNS], ["maybeSingle"],
    ]);
  });

  it.each([["company"], ["role"], ["date"], ["interview_date"], ["employee_id"], ["withdrawn_at"]])("refuses a locked %s key without querying", async key => {
    const { client, calls } = fakeClient(freshRows());
    await expect(storeFor(client).update(staff, ID, { ...changes, [key]: "x" } as InterviewChanges)).rejects.toBeInstanceOf(InterviewLockedError);
    expect(calls).toHaveLength(0);
  });

  it("reports another staff member's entry, or an unknown id, as not found without updating", async () => {
    for (const id of ["f", "missing"]) {
      const { client, calls } = fakeClient(freshRows());
      await expect(storeFor(client).update(staff, id, changes)).rejects.toBeInstanceOf(InterviewNotFoundError);
      expect(calls.flat().some(c => c.method === "update")).toBe(false);
    }
  });

  it("refuses a withdrawn entry without updating", async () => {
    const { client, calls } = fakeClient(freshRows());
    await expect(storeFor(client).update(staff, "w", changes)).rejects.toBeInstanceOf(InterviewWithdrawnError);
    expect(calls.flat().some(c => c.method === "update")).toBe(false);
  });

  it("reports not found when the guarded update matches no row (withdrawn in between)", async () => {
    const { client } = fakeClient(freshRows(), "update-none");
    await expect(storeFor(client).update(staff, ID, changes)).rejects.toBeInstanceOf(InterviewNotFoundError);
  });

  it("refuses an Administrator (read-only) without querying", async () => {
    const { client, calls } = fakeClient(freshRows());
    await expect(storeFor(client).update(admin, ID, changes)).rejects.toBeInstanceOf(InterviewsForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("never reports a refused write (e.g. the lock trigger) as saved", async () => {
    const { client } = fakeClient(freshRows(), "update-error");
    await expect(storeFor(client).update(staff, ID, changes)).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });
});

describe("interviews-store withdraw (Story 2.2)", () => {
  it("sets withdrawn_at on the author's own active entry and nothing else", async () => {
    const data = freshRows();
    const { client, calls } = fakeClient(data);
    const saved = await storeFor(client).withdraw(staff, ID);
    expect(saved.withdrawn).toBe(true);
    const update = calls[1].find(c => c.method === "update")!.args[0] as Record<string, unknown>;
    expect(Object.keys(update)).toEqual(["withdrawn_at"]);
    expect(Number.isNaN(Date.parse(update.withdrawn_at as string))).toBe(false);
    expect(calls[1]).toContainEqual({ table: "external_interviews", method: "is", args: ["withdrawn_at", null] });
    expect(calls.flat().some(c => c.method === "delete")).toBe(false);
  });

  it("refuses a second withdrawal: a withdrawn entry stays unchanged", async () => {
    const data = freshRows();
    const before = structuredClone(data[2]);
    const { client } = fakeClient(data);
    await expect(storeFor(client).withdraw(staff, "w")).rejects.toBeInstanceOf(InterviewWithdrawnError);
    expect(data[2]).toEqual(before);
  });

  it("a corrected entry can be added after withdrawing; the withdrawn one is unchanged", async () => {
    const data = freshRows();
    const { client } = fakeClient(data);
    const store = storeFor(client);
    await store.withdraw(staff, ID);
    const withdrawn = structuredClone(data[0]);
    const corrected = await store.add(staff, { ...input, company: "Northstar Labs (fictional)" });
    expect(corrected.withdrawn).toBe(false);
    expect(data[0]).toEqual(withdrawn);
    await expect(store.update(staff, ID, changes)).rejects.toBeInstanceOf(InterviewWithdrawnError);
  });

  it("refuses another staff member's entry and an Administrator", async () => {
    const { client, calls } = fakeClient(freshRows());
    await expect(storeFor(client).withdraw(staff, "f")).rejects.toBeInstanceOf(InterviewNotFoundError);
    await expect(storeFor(client).withdraw(admin, ID)).rejects.toBeInstanceOf(InterviewsForbiddenError);
    expect(calls.flat().some(c => c.method === "update")).toBe(false);
  });
});

describe("interviews-store unavailability", () => {
  const calls = (store: ReturnType<typeof createInterviewsStore>) => [
    () => store.listFor(admin), () => store.listFor(staff), () => store.listFor(admin, "BS-1001"), () => store.add(staff, input),
    () => store.update(staff, ID, changes), () => store.withdraw(staff, ID),
  ];

  it("throws InterviewsUnavailableError when the database returns an error (including a missing table)", async () => {
    const { client } = fakeClient(rows, "error");
    for (const call of calls(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });

  it("throws InterviewsUnavailableError on a network failure", async () => {
    const { client } = fakeClient(rows, "throw");
    for (const call of calls(storeFor(client))) await expect(call()).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });

  it("throws InterviewsUnavailableError when the user client cannot be created", async () => {
    const store = createInterviewsStore({ userClient: async () => { throw new Error("Supabase is not configured"); } });
    for (const call of calls(store)) await expect(call()).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });

  it("throws InterviewsUnavailableError when no data comes back", async () => {
    const empty = { from: () => ({ select: () => ({ order: () => ({ order: () => ({ order: () => ({ returns: async () => ({ data: null, error: null }) }) }) }) }) }) };
    await expect(storeFor(empty as unknown as SupabaseClient).listFor(admin)).rejects.toBeInstanceOf(InterviewsUnavailableError);
  });
});

describe("interviews-store paging (Story 8.2)", () => {
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
    await expect(storeFor(client).listFor(admin)).rejects.toBeInstanceOf(InterviewsUnavailableError);
    expect(requests()).toBe(2);
  });
});
