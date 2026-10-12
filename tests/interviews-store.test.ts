import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createInterviewsStore, InterviewsForbiddenError, InterviewsUnavailableError, toInterview, type InterviewRow, type NewInterview,
} from "@/server/interviews-store";

type Mode = "ok" | "error" | "throw" | "foreign";
type Call = { table: string; method: string; args: unknown[] };

/** Minimal stand-in for the supabase-js query builder: records every call and applies eq filters to rows. */
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
          const row = { id: "new-id", feedback: "", ...(inserted.args[0] as object) } as InterviewRow;
          return { data: mode === "foreign" ? { ...row, employee_id: "BS-1008" } : row, error: null };
        }
        const filters = query.filter(c => c.method === "eq").map(c => c.args as [string, string]);
        return { data: rows.filter(r => filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)), error: null };
      };
      const builder = {
        select: (...args: unknown[]) => { record("select", args); return builder; },
        eq: (...args: unknown[]) => { record("eq", args); return builder; },
        order: (...args: unknown[]) => { record("order", args); return builder; },
        insert: (...args: unknown[]) => { record("insert", args); return builder; },
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
const COLUMNS = "id,employee_id,company,role,stage,interview_date,outcome,feedback";

const row = (employee_id: string, id: string): InterviewRow => ({
  id, employee_id, company: "Northstar Labs (fictional)", role: "Software Engineer I", stage: "Technical interview",
  interview_date: "2026-09-23", outcome: "Scheduled", feedback: "Prepare examples.",
});
const rows = [row("BS-1001", "a"), row("BS-1002", "b"), row("BS-1001", "c")];
const admin = { role: "admin" } as const;
const staff = { role: "staff", employeeId: "BS-1001" } as const;
const input: NewInterview = { company: "Orbit Analytics", role: "AI Engineer", date: "2026-10-20", stage: "Recruiter screen", outcome: "" };

describe("interviews-store mapping", () => {
  it("maps a row to an interview with its employee", () => {
    expect(toInterview(rows[0])).toEqual({
      id: "a", employeeId: "BS-1001", company: "Northstar Labs (fictional)", role: "Software Engineer I",
      date: "2026-09-23", stage: "Technical interview", outcome: "Scheduled", feedback: "Prepare examples.",
    });
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
    expect(saved).toEqual({ id: "new-id", employeeId: "BS-1001", ...input, feedback: "" });
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

describe("interviews-store unavailability", () => {
  const calls = (store: ReturnType<typeof createInterviewsStore>) => [
    () => store.listFor(admin), () => store.listFor(staff), () => store.listFor(admin, "BS-1001"), () => store.add(staff, input),
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
