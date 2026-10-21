import { dhakaInstant } from "./calendar";
import type { CohortMember } from "./cohort";
import { describeError } from "./errors";

// Story 9.1: the scripted dry-run driver: a stand-in for the persona agents (Story 9.3) with no model, no
// API key and no network beyond the app's own stores. Each staff persona clocks in (09:00 to 09:40, by
// its position among the staff), saves a short daily log and clocks out at 18:00, all at simulated
// instants through its own attendance-commands. The manager and the Administrator record one "reviewed
// the team" action a day. A refused action becomes a `refusal` step carrying the app's message; it is
// never retried or forced through.
//
// Known limitation (deferred to the System Owner, not fixed here): against the shared project the attendance
// RLS policies (attendance_insert_own / attendance_update_own) accept only today's Dhaka work_date, so every
// clock-in on a past simulated date is refused (42501) and recorded as a refusal. No migration is added for it.

export type SimDay = { date: string; index: number };
export type DriverStep = {
  at: Date; kind: "action" | "refusal"; text: string; detail?: Record<string, unknown>;
  /** Story 9.3: already in the timeline (recorded by the tool layer); the runner only counts it. */
  recorded?: boolean;
};

export interface SimDriver {
  /** Story 9.3: called once per working day, after its `day` event and before any persona acts. */
  beginDay?(day: SimDay): Promise<void> | void;
  /** What the persona does on the day; `position` is its index among the personas of its role. */
  act(member: CohortMember, day: SimDay, position: number): Promise<DriverStep[]>;
}

/** Runs one app call at a simulated instant: its message as an `action`, or its error as a `refusal`. */
export async function attempt(at: Date, command: string, call: () => Promise<string>, detail: Record<string, unknown> = {}): Promise<DriverStep> {
  try {
    const message = await call();
    return { at, kind: "action", text: message, detail: { command, ...detail } };
  } catch (error) {
    // An "unavailable" error's cause (the database's own refusal) is part of the finding.
    const { message, ...described } = describeError(error);
    return { at, kind: "refusal", text: message, detail: { command, ...detail, ...described } };
  }
}

const clockInTime = (position: number) => {
  const minutes = Math.min(40, position * 5);
  return `09:${String(minutes).padStart(2, "0")}`;
};

export function createDryRunDriver(): SimDriver {
  return {
    async act(member, day, position) {
      const { persona } = member;
      if (persona.role !== "staff") {
        const at = dhakaInstant(day.date, persona.role === "manager" ? "17:00" : "17:30");
        return [{ at, kind: "action", text: "Reviewed the team.", detail: { command: "review" } }];
      }
      const commands = member.attendance;
      const employeeId = member.employeeId;
      if (!commands || !employeeId) {
        return [{ at: dhakaInstant(day.date, "09:00"), kind: "refusal", text: "This persona has no employee record to record attendance against." }];
      }
      const workMode = persona.traits.includes("client-project") ? "Client site" : position % 2 === 1 ? "Remote" : "Office";
      const steps: DriverStep[] = [];
      const inAt = dhakaInstant(day.date, clockInTime(position));
      steps.push(await attempt(inAt, "clockIn", () => commands.clockIn(employeeId, { workMode }, inAt), { workMode }));
      // A refused clock-in ends the persona's day: the log and clock-out would only repeat NOT_CLOCKED_IN.
      if (steps[0].kind === "refusal") return steps;
      const logAt = dhakaInstant(day.date, "17:45");
      steps.push(await attempt(logAt, "saveLog", () => commands.saveLog(employeeId, {
        summary: `${persona.title} work for ${day.date}.`,
        blockers: "",
        tasks: [
          { description: `Planned work: ${persona.goals[0] ?? "team tasks"}`.slice(0, 300), hours: "4", link: "" },
          { description: "Reviews and follow-ups", hours: "3", link: "" },
        ],
      }, logAt)));
      const outAt = dhakaInstant(day.date, "18:00");
      steps.push(await attempt(outAt, "clockOut", () => commands.clockOut(employeeId, { breakMinutes: 60 }, outAt), { breakMinutes: 60 }));
      return steps;
    },
  };
}
