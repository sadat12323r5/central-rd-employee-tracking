import type { SupabaseClient } from "@supabase/supabase-js";

// Stand-in supabase-js client for paging tests (Story 8.2): every `from()` is one request, answered by
// the next entry of `pages` (rows, or "error" for a PostgREST error). Records each request's `.range()`.
export function pagedClient<T>(pages: (T[] | "error")[]) {
  const ranges: [number, number][] = [];
  const ins: unknown[][] = [];
  let request = 0;
  const client = {
    from() {
      const answer = pages[request++] ?? [];
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "order", "returns"]) builder[method] = () => builder;
      builder.in = (_column: string, values: unknown[]) => { ins.push(values); return builder; };
      builder.range = (from: number, to: number) => { ranges.push([from, to]); return builder; };
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(
        answer === "error" ? { data: null, error: { code: "PGRST000", message: "connection refused" } } : { data: answer, error: null },
      ).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, ranges, ins, requests: () => request };
}

/** `count` copies of `make(i)`, for building full pages. */
export const many = <T>(count: number, make: (i: number) => T, offset = 0): T[] => Array.from({ length: count }, (_, i) => make(i + offset));
