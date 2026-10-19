import { dhakaInstant, type SimCalendar } from "./calendar";
import type { Cohort, CohortMember } from "./cohort";
import type { SimDriver } from "./dry-run-driver";
import type { Timeline } from "./timeline";

// Story 9.1: steps the simulated calendar. Records `provisioned`, then walks the period's weekdays in
// order: a holiday is a `holiday` event (no one acts), a working day is a `day` event followed by every
// persona's steps (staff first, then managers, then the Administrator). A step the app refused is a
// `refusal` event, and a driver that throws is recorded as one too: the run never crashes on an app
// refusal. `maxDays` stops after that many working days. Ends with an `end` event.

export type SimulationResult = { run: string; days: string[]; holidays: string[]; actions: number; refusals: number };

const ROLE_ORDER = ["staff", "manager", "admin"] as const;

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export async function runSimulation({ cohort, driver, calendar, timeline, maxDays }: {
  cohort: Cohort; driver: SimDriver; calendar: SimCalendar; timeline: Timeline; maxDays?: number;
}): Promise<SimulationResult> {
  const limit = maxDays === undefined ? calendar.workingDays.length : Math.max(0, Math.min(Math.floor(maxDays), calendar.workingDays.length));
  const firstDay = calendar.weekdays[0] ?? calendar.workingDays[0];
  const people = cohort.members.filter(m => m.persona.role !== "admin").length;
  timeline.record({
    day: null, at: dhakaInstant(firstDay, "08:00").toISOString(), actor: "simulator", kind: "provisioned",
    text: `Provisioned cohort ${cohort.run}: ${cohort.members.length} personas (${people} employees ${cohort.ids[0]}-${cohort.ids[people - 1] ?? cohort.ids[0]}) in ${cohort.departmentName}.`,
    detail: {
      run: cohort.run, block: cohort.block, departmentId: cohort.departmentId, departmentName: cohort.departmentName,
      members: cohort.members.map(m => ({ key: m.persona.key, name: m.persona.name, role: m.persona.role, employeeId: m.employeeId, email: m.email })),
    },
  });

  const ordered: { member: CohortMember; position: number }[] = ROLE_ORDER.flatMap(role =>
    cohort.members.filter(m => m.persona.role === role).map((member, position) => ({ member, position })));
  const holidays = new Map(calendar.holidays.map(h => [h.date, h]));
  const result: SimulationResult = { run: cohort.run, days: [], holidays: [], actions: 0, refusals: 0 };
  let lastDay = firstDay;

  for (const date of calendar.weekdays) {
    if (result.days.length >= limit) break;
    const holiday = holidays.get(date);
    if (holiday) {
      timeline.record({
        day: date, at: dhakaInstant(date, "08:00").toISOString(), actor: "simulator", kind: "holiday",
        text: `${longDate(date)}${holiday.name ? `: ${holiday.name}` : ""}. A public holiday in the active calendar; nobody works.`,
        detail: holiday.name ? { name: holiday.name } : undefined,
      });
      result.holidays.push(date);
      continue;
    }
    if (!calendar.workingDays.includes(date)) continue;
    const index = result.days.length;
    result.days.push(date);
    lastDay = date;
    timeline.record({
      day: date, at: dhakaInstant(date, "08:30").toISOString(), actor: "simulator", kind: "day",
      text: `Day ${index + 1} of ${limit}: ${longDate(date)}.`, detail: { index: index + 1 },
    });
    for (const { member, position } of ordered) {
      let steps;
      try {
        steps = await driver.act(member, { date, index }, position);
      } catch (error) {
        steps = [{
          at: dhakaInstant(date, "12:00"), kind: "refusal" as const, text: error instanceof Error ? error.message : String(error),
          detail: { error: error instanceof Error ? error.name : "Error" },
        }];
      }
      for (const step of steps) {
        timeline.record({ day: date, at: step.at.toISOString(), actor: member.persona.name, kind: step.kind, text: step.text, detail: step.detail });
        if (step.kind === "refusal") result.refusals += 1;
        else result.actions += 1;
      }
    }
  }

  timeline.record({
    day: lastDay, at: dhakaInstant(lastDay, "19:00").toISOString(), actor: "simulator", kind: "end",
    text: `Run ${cohort.run} ended after ${result.days.length} working days and ${result.holidays.length} holidays: ${result.actions} actions, ${result.refusals} refusals.`,
    detail: { days: result.days.length, holidays: result.holidays.length, actions: result.actions, refusals: result.refusals },
  });
  timeline.close();
  return result;
}
