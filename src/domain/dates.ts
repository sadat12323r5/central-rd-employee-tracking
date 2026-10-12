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
