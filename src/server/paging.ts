// Reads every row of a list query, page by page (Story 8.2). PostgREST caps a single response at
// `max_rows` (1000, supabase/config.toml), so a list read issued as one request would be silently
// truncated. Each store passes a function that fetches one inclusive `.range(from, to)` page of a query
// with a total order, and maps its own errors (any page error throws that store's unavailable error,
// so nothing partial is ever returned). Pages are read until one comes back shorter than PAGE_SIZE.

/** Rows per page: the PostgREST `max_rows` cap. */
export const PAGE_SIZE = 1000;

/** Every row of the query, in its order. `fetchPage(from, to)` reads the inclusive row range. */
export async function readAllPages<T>(fetchPage: (from: number, to: number) => Promise<readonly T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await fetchPage(from, from + PAGE_SIZE - 1);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
