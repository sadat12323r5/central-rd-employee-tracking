// Pure rules for employment history entries (Story 7.3): normalising what a person types, checking it,
// and ordering entries newest first. No framework or database imports. employment-history-store is the
// load-bearing check; the server actions validate with zod first, and the table has matching checks.
//
// The period stays free text, so the demo entries ("2022-02-06 – Present", "2021 – 2022") render exactly
// as before. "Newest first" is derived from the period's start: its first four-digit year, refined by an
// ISO month/day written at that year ("2022-02-06") or a month name just before it ("Mar 2023").

export const ROLE_MAX = 200;
export const EMPLOYER_MAX = 200;
export const PERIOD_MAX = 60;
export const DETAIL_MAX = 2000;

/** What a person enters for one employment entry. The employee is never part of it. */
export type EmploymentHistoryInput = { role: string; employer: string; period: string; detail: string };

export type EmploymentHistoryField = keyof EmploymentHistoryInput;

/** A four-digit year 1900-2099 not embedded in a longer number (the table check uses the same rule). */
const YEAR = /(?<!\d)(19|20)\d{2}(?!\d)/;

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/** Trims every field and collapses inner whitespace in role, employer and period (the detail keeps its line breaks). */
export function normalizeEmploymentHistory(input: EmploymentHistoryInput): EmploymentHistoryInput {
  return {
    role: collapse(input.role ?? ""),
    employer: collapse(input.employer ?? ""),
    period: collapse(input.period ?? ""),
    detail: (input.detail ?? "").trim(),
  };
}

/** True when the period contains a four-digit year 1900-2099. */
export function hasPeriodYear(period: string): boolean {
  return YEAR.test(period);
}

/**
 * The fields of a (normalised) entry that are invalid: role and employer 1-200 characters, period 1-60
 * characters with a four-digit year 1900-2099, detail at most 2000 characters. Empty when valid.
 */
export function invalidEmploymentHistoryFields(input: EmploymentHistoryInput): EmploymentHistoryField[] {
  const invalid: EmploymentHistoryField[] = [];
  const within = (value: string, max: number) => value.trim().length >= 1 && value.length <= max;
  if (!within(input.role, ROLE_MAX)) invalid.push("role");
  if (!within(input.employer, EMPLOYER_MAX)) invalid.push("employer");
  if (!within(input.period, PERIOD_MAX) || !hasPeriodYear(input.period)) invalid.push("period");
  if (input.detail.length > DETAIL_MAX) invalid.push("detail");
  return invalid;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 1-12 for a month name or an abbreviation of at least three letters ("Mar", "Sept", "March"); 0 otherwise. */
function monthNumber(word: string): number {
  const lower = word.toLowerCase();
  if (lower.length < 3) return 0;
  const index = MONTHS.findIndex(m => m.startsWith(lower));
  return index + 1;
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A sortable key (`YYYYMMDD`) for the start of a period: the first four-digit year, with the month and day
 * from an ISO date written at that year ("2022-02-06") or the month from a name right before it
 * ("Mar 2023", "March 2023"). A missing month or day counts as 00. A period without a year gives "".
 */
export function periodStartKey(period: string): string {
  const match = YEAR.exec(period);
  if (!match) return "";
  const year = match[0];
  const at = match.index;
  const iso = /^\d{4}-(\d{2})(?:-(\d{2}))?(?!\d)/.exec(period.slice(at));
  if (iso) {
    const month = Number(iso[1]);
    const day = iso[2] === undefined ? 0 : Number(iso[2]);
    if (month >= 1 && month <= 12) return `${year}${two(month)}${day >= 1 && day <= 31 ? two(day) : "00"}`;
  }
  const named = /([A-Za-z]+)\.?,?\s*$/.exec(period.slice(0, at));
  const month = named ? monthNumber(named[1]) : 0;
  return `${year}${two(month)}00`;
}

/** Newest first: by period start (descending), then creation time, then id (both descending). Does not mutate. */
export function sortNewestFirst<T extends { id: string; period: string; createdAt: string }>(entries: readonly T[]): T[] {
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  return [...entries].sort((a, b) =>
    desc(periodStartKey(a.period), periodStartKey(b.period)) || desc(a.createdAt, b.createdAt) || desc(a.id, b.id));
}
