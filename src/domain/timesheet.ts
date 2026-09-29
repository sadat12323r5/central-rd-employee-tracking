// Daily attendance (clock in / clock out) and work-log rules.
// Pure functions only: storage and sessions live in src/server.

const MINUTE_MS = 60_000;
// Bangladesh Standard Time is UTC+6 all year (no daylight saving), so a fixed offset is exact.
const DHAKA_OFFSET_MS = 6 * 60 * MINUTE_MS;
const MAX_TASKS = 8;
const MAX_SUMMARY = 2000;
const MAX_BLOCKERS = 1000;
const MAX_TASK_TEXT = 300;

export const WORK_MODES = ["Office", "Remote", "Client site"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export interface LogTask {
  description: string;
  hours: number;
  link?: string;
}

export interface DailyLog {
  summary: string;
  tasks: LogTask[];
  blockers: string;
  updatedAt: string;
}

export interface TimesheetEntry {
  id: string;
  employeeId: string;
  /** Working day in Dhaka time, YYYY-MM-DD. */
  date: string;
  /** UTC ISO timestamps. */
  clockIn: string;
  clockOut: string | null;
  breakMinutes: number;
  workMode: WorkMode;
  log: DailyLog | null;
}

export type EntryStatus = "Clocked in" | "Completed" | "Missing clock-out";

export class TimesheetValidationError extends Error {
  constructor(
    public readonly code:
      | "ALREADY_CLOCKED_IN"
      | "ALREADY_RECORDED"
      | "NOT_CLOCKED_IN"
      | "CLOCK_OUT_BEFORE_IN"
      | "INVALID_BREAK"
      | "INVALID_WORK_MODE"
      | "INVALID_LOG",
    message: string,
  ) {
    super(message);
    this.name = "TimesheetValidationError";
  }
}

/** The calendar date in Dhaka for an instant, as YYYY-MM-DD. */
export function dhakaDate(instant: Date): string {
  return new Date(instant.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

export function isWorkMode(value: string): value is WorkMode {
  return (WORK_MODES as readonly string[]).includes(value);
}

export function entryStatus(entry: TimesheetEntry, now: Date): EntryStatus {
  if (entry.clockOut) return "Completed";
  return entry.date === dhakaDate(now) ? "Clocked in" : "Missing clock-out";
}

/** The entry for today in Dhaka, if any. */
export function todaysEntry(entries: readonly TimesheetEntry[], employeeId: string, now: Date): TimesheetEntry | undefined {
  const today = dhakaDate(now);
  return entries.find(e => e.employeeId === employeeId && e.date === today);
}

/**
 * Start today's attendance. One entry per employee per Dhaka day; short absences are
 * recorded as break minutes at clock-out. An unclosed entry from an earlier day does not
 * block today — it stays flagged as "Missing clock-out" for manager review.
 */
export function clockIn(
  entries: readonly TimesheetEntry[],
  input: { id: string; employeeId: string; workMode: string; now: Date },
): TimesheetEntry {
  if (!isWorkMode(input.workMode)) {
    throw new TimesheetValidationError("INVALID_WORK_MODE", "Choose where you are working today.");
  }
  const existing = todaysEntry(entries, input.employeeId, input.now);
  if (existing && !existing.clockOut) {
    throw new TimesheetValidationError("ALREADY_CLOCKED_IN", "You are already clocked in today.");
  }
  if (existing) {
    throw new TimesheetValidationError("ALREADY_RECORDED", "Today's attendance is already recorded.");
  }
  return {
    id: input.id,
    employeeId: input.employeeId,
    date: dhakaDate(input.now),
    clockIn: input.now.toISOString(),
    clockOut: null,
    breakMinutes: 0,
    workMode: input.workMode,
    log: null,
  };
}

export function clockOut(entry: TimesheetEntry | undefined, input: { breakMinutes: number; now: Date }): TimesheetEntry {
  if (!entry || entry.clockOut) {
    throw new TimesheetValidationError("NOT_CLOCKED_IN", "You are not clocked in today.");
  }
  const elapsed = Math.floor((input.now.getTime() - Date.parse(entry.clockIn)) / MINUTE_MS);
  if (elapsed < 0) {
    throw new TimesheetValidationError("CLOCK_OUT_BEFORE_IN", "Clock-out cannot be earlier than clock-in.");
  }
  const { breakMinutes } = input;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || (breakMinutes > 0 && breakMinutes >= elapsed)) {
    throw new TimesheetValidationError("INVALID_BREAK", "Break must be whole minutes and shorter than the time you were clocked in.");
  }
  return { ...entry, clockOut: input.now.toISOString(), breakMinutes };
}

/** Minutes worked, excluding breaks. Open entries count up to `now`. */
export function workedMinutes(entry: TimesheetEntry, now: Date): number {
  const end = entry.clockOut ? Date.parse(entry.clockOut) : now.getTime();
  const total = Math.floor((end - Date.parse(entry.clockIn)) / MINUTE_MS) - entry.breakMinutes;
  return Math.max(0, total);
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validate and normalise a daily work log for an entry. */
export function buildLog(
  entry: TimesheetEntry,
  input: { summary: string; blockers: string; tasks: { description: string; hours: string; link: string }[] },
  now: Date,
): DailyLog {
  const fail = (message: string): never => {
    throw new TimesheetValidationError("INVALID_LOG", message);
  };
  const summary = input.summary.trim();
  const blockers = input.blockers.trim();
  if (!summary) fail("Add a short summary of what you worked on.");
  if (summary.length > MAX_SUMMARY) fail(`Keep the summary under ${MAX_SUMMARY} characters.`);
  if (blockers.length > MAX_BLOCKERS) fail(`Keep blockers under ${MAX_BLOCKERS} characters.`);

  const rows = input.tasks
    .map(t => ({ description: t.description.trim(), hours: t.hours.trim(), link: t.link.trim() }))
    .filter(t => t.description || t.hours || t.link);
  if (rows.length === 0) fail("Add at least one task.");
  if (rows.length > MAX_TASKS) fail(`Log up to ${MAX_TASKS} tasks per day.`);

  const tasks: LogTask[] = rows.map((row, i) => {
    const label = `Task ${i + 1}`;
    if (!row.description) fail(`${label} needs a description.`);
    if (row.description.length > MAX_TASK_TEXT) fail(`${label} description is too long.`);
    const hours = Number(row.hours);
    if (!row.hours || !Number.isFinite(hours) || hours <= 0 || Math.round(hours * 4) !== hours * 4) {
      fail(`${label} hours must be a positive number in quarter hours, like 1.5.`);
    }
    if (row.link && !isHttpUrl(row.link)) fail(`${label} link must start with http:// or https://.`);
    return row.link ? { description: row.description, hours, link: row.link } : { description: row.description, hours };
  });

  const loggedMinutes = tasks.reduce((sum, t) => sum + t.hours * 60, 0);
  // Allow rounding up to the next quarter hour.
  if (loggedMinutes > workedMinutes(entry, now) + 15) {
    fail(`Task hours (${formatDuration(loggedMinutes)}) exceed time worked (${formatDuration(workedMinutes(entry, now))}).`);
  }

  return { summary, tasks, blockers, updatedAt: now.toISOString() };
}

export function summariseEntries(entries: readonly TimesheetEntry[], now: Date) {
  return {
    daysRecorded: entries.length,
    minutesWorked: entries.reduce((sum, e) => sum + (e.clockOut ? workedMinutes(e, now) : 0), 0),
    missingClockOuts: entries.filter(e => entryStatus(e, now) === "Missing clock-out").length,
    missingLogs: entries.filter(e => e.clockOut && !e.log).length,
  };
}
