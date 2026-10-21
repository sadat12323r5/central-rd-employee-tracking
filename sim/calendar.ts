import { isWorkingDay, type CalendarPolicy } from "@/domain/leave";

// Story 9.1: the simulated calendar. The run covers a fixed eight-week period, Mon 2026-08-03 to Fri
// 2026-09-25 (40 weekdays). Working days are Monday to Friday, skipping the holidays of the active live
// holiday calendar (the same rule leave counting uses). The org timezone is Asia/Dhaka (UTC+6 all year).

export const SIM_START = "2026-08-03";
export const SIM_END = "2026-09-25";
/** Asia/Dhaka has no daylight saving, so a fixed offset is exact. */
export const DHAKA_OFFSET = "+06:00";

export type SimHoliday = { date: string; name?: string };
export type SimCalendar = {
  /** Every Monday-to-Friday date of the period, in order. */
  weekdays: string[];
  /** The weekdays that are working days (not holidays), in order. */
  workingDays: string[];
  /** The weekdays that are holidays in the active calendar, in order. */
  holidays: SimHoliday[];
};

/** The setup could not start: say why and provision nothing. */
export class SimSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SimSetupError";
  }
}

export const NO_ACTIVE_CALENDAR =
  "No active holiday calendar is loaded in the shared project. Load the Bangladesh 2026 calendar (Admin, Holiday calendar, or npm run db:seed) before running the simulation; nothing was provisioned.";

const DAY_MS = 86_400_000;
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The period's weekdays, working days and holidays under `policy`. Throws SimSetupError when the policy does not cover the period's year. */
export function simulatedCalendar(
  policy: CalendarPolicy, names: ReadonlyMap<string, string> = new Map(), period = { start: SIM_START, end: SIM_END },
): SimCalendar {
  const weekdays: string[] = [];
  const workingDays: string[] = [];
  const holidays: SimHoliday[] = [];
  for (let time = Date.parse(`${period.start}T00:00:00Z`); time <= Date.parse(`${period.end}T00:00:00Z`); time += DAY_MS) {
    const weekday = new Date(time).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = iso(time);
    weekdays.push(date);
    let working: boolean;
    try {
      working = isWorkingDay(date, policy);
    } catch (cause) {
      throw new SimSetupError(
        `The active holiday calendar covers ${policy.supportedYearStart}-${policy.supportedYearEnd}, not the simulated period ${period.start} to ${period.end}; load a calendar for that year first. Nothing was provisioned.`,
        { cause },
      );
    }
    if (working) workingDays.push(date);
    else holidays.push(names.has(date) ? { date, name: names.get(date) } : { date });
  }
  return { weekdays, workingDays, holidays };
}

/** The simulated calendar from the holiday-calendar store's `active()` result. Null (no calendar) is a SimSetupError. */
export function calendarFromActive(active: { policy: CalendarPolicy } | null): SimCalendar {
  if (!active) throw new SimSetupError(NO_ACTIVE_CALENDAR);
  return simulatedCalendar(active.policy);
}

/** The instant of a wall-clock time ("HH:MM") on an ISO date in Asia/Dhaka. */
export function dhakaInstant(isoDate: string, time: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid simulated time ${isoDate} ${time}.`);
  const instant = new Date(`${isoDate}T${time}:00${DHAKA_OFFSET}`);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invalid simulated time ${isoDate} ${time}.`);
  return instant;
}

/** "HH:MM" in Asia/Dhaka for an instant. */
export function dhakaClock(instant: Date | string): string {
  const time = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  return new Date(time + 6 * 3_600_000).toISOString().slice(11, 16);
}
