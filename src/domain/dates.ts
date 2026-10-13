// Calendar dates (`YYYY-MM-DD`, no time or timezone) and their display as `D MMM YYYY`.
// Date-only values carry no instant, so the Asia/Dhaka org timezone never shifts them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form (so `2026-02-30` and `2026-13-01` are rejected). */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day); // unlike Date.UTC, never maps years 0–99 to 1900–1999
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** `2026-09-23` → `23 Sep 2026`; anything that is not a calendar date → `Not recorded`. */
export function formatDisplayDate(value: string): string {
  if (!isCalendarDate(value)) return "Not recorded";
  const [year, month, day] = value.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const DHAKA_PARTS = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Dhaka",
});

/**
 * An instant (ISO 8601 timestamp) as `D MMM YYYY, HH:mm` in the Asia/Dhaka org timezone, e.g.
 * `2026-10-12T03:30:00Z` → `12 Oct 2026, 09:30`; anything unparseable → `Not recorded`.
 */
export function formatDisplayDateTime(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "Not recorded";
  const parts = Object.fromEntries(DHAKA_PARTS.formatToParts(new Date(time)).map(p => [p.type, p.value]));
  return `${formatDisplayDate(`${parts.year}-${parts.month}-${parts.day}`)}, ${parts.hour}:${parts.minute}`;
}
