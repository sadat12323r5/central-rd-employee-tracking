import { dhakaDate } from "@/domain/timesheet";
import { dhakaInstant } from "../calendar";
import type { SimClock } from "./types";

// Story 9.2: the simulated clock every persona tool reads "now" and "today" from (attendance instants,
// the export's `now`, the backfill store's `now`, default assignment dates). The orchestrator moves it;
// the tools never read the server clock.

export type MovableSimClock = SimClock & {
  /** Moves the clock forward (or back, when negative) by whole minutes. */
  advance(minutes: number): void;
  /** Sets the clock to a wall-clock time ("HH:MM", default 09:00) on an ISO date in Asia/Dhaka. */
  set(date: string, time?: string): void;
};

/** A clock fixed at `time` ("HH:MM", default 09:00) on `date` in Asia/Dhaka until it is moved. */
export function createSimClock(date: string, time = "09:00"): MovableSimClock {
  let instant = dhakaInstant(date, time);
  return {
    now: () => new Date(instant.getTime()),
    today: () => dhakaDate(instant),
    advance(minutes) {
      if (!Number.isFinite(minutes)) throw new Error(`Invalid clock advance ${minutes}.`);
      instant = new Date(instant.getTime() + Math.round(minutes) * 60_000);
    },
    set(nextDate, nextTime = "09:00") {
      instant = dhakaInstant(nextDate, nextTime);
    },
  };
}
