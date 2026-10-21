import { PERSONAS, type PersonaTrait } from "../personas";

// Story 9.3: the eight weeks' deterministic event script. Each event targets personas by key or trait
// over a range of working-day indices (0 = Mon 2026-08-03; the BD-2026 period has 37 working days, with
// holidays on 08-05, 08-26 and 09-04), and carries the text that goes into those personas' daily briefs.
// The script only tells personas what is happening; whatever they do about it goes through their tools,
// where the app may refuse it. Placeholders: {run}, {cohortDepartment} and {platformDepartment}.
//
// Working-day weeks: week 1 = 0-3, week 2 = 4-8, week 3 = 9-13, week 4 = 14-17, week 5 = 18-21,
// week 6 = 22-26, week 7 = 27-31, week 8 = 32-36.

export const EVENT_KINDS = ["kickoff", "crunch", "holiday-leave", "interview-round", "closure-evaluations", "transfer", "skills-review"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type ScriptedEvent = {
  kind: EventKind;
  /** First and last working-day index (0-based, inclusive). */
  from: number;
  to: number;
  /** Personas the event targets: by key, by trait, or both (either matches). */
  targets: { keys?: readonly string[]; traits?: readonly PersonaTrait[] };
  text: string;
  /** Leave dates the event asks for (holiday-leave). */
  dates?: { startDate: string; endDate: string };
};

const name = (key: string) => {
  const persona = PERSONAS.find(p => p.key === key);
  if (!persona) throw new Error(`The event script names an unknown persona ${key}.`);
  return persona.name;
};
const first = (key: string) => name(key).split(" ")[0];

const PROJECT = "Meghna Logistics customer portal";
const CLIENT = "Meghna Logistics";

export const EVENT_SCRIPT: readonly ScriptedEvent[] = [
  // Week 1: the client project kicks off with assignments.
  {
    kind: "kickoff", from: 0, to: 1, targets: { keys: ["manager"] },
    text: `Client project kickoff: ${CLIENT} has signed for the "${PROJECT}". Use read_team to find your people, then create assignments starting today (client "${CLIENT}", project "${PROJECT}") for ${name("senior")} (tech lead), ${name("client")} (QA, at the client site) and ${name("designer")} (UX). Also give ${name("transfer")} an assignment on the internal "Data pipeline refresh" (client "Central R&D"); it will be closed before her transfer in week 5.`,
  },
  {
    kind: "kickoff", from: 0, to: 1, targets: { traits: ["client-project"] },
    text: `The "${PROJECT}" for ${CLIENT} kicks off this week. ${first("manager")} is assigning the project team; plan your first tasks and log them.`,
  },
  {
    kind: "kickoff", from: 0, to: 1, targets: { keys: ["admin"] },
    text: `A client project for ${CLIENT} kicks off in {cohortDepartment}. Check the records are complete; ${first("manager")} creates the assignments.`,
  },
  // Week 2: leave planned around the 26 August public holiday (taken in week 4).
  {
    kind: "holiday-leave", from: 5, to: 8, targets: { traits: ["holiday-leave"] },
    text: "You want a long break around the public holiday on Wednesday 26 August. Record leave from 2026-08-24 to 2026-08-28 now (the holiday itself is not counted), and hand over before you go.",
    dates: { startDate: "2026-08-24", endDate: "2026-08-28" },
  },
  {
    kind: "holiday-leave", from: 14, to: 17, targets: { traits: ["holiday-leave"] },
    text: "You are on leave this week around the 26 August holiday. Do not clock in; check your leave is on record and fix it if it is not.",
    dates: { startDate: "2026-08-24", endDate: "2026-08-28" },
  },
  // Leave clusters around the holiday: two more staff take a short break touching it.
  {
    kind: "holiday-leave", from: 6, to: 8, targets: { keys: ["trainee"] },
    text: "Several colleagues are taking time off around the 26 August public holiday. Record leave from 2026-08-25 to 2026-08-27 for a short family visit.",
    dates: { startDate: "2026-08-25", endDate: "2026-08-27" },
  },
  {
    kind: "holiday-leave", from: 6, to: 8, targets: { keys: ["intern"] },
    text: "You want a few days off around the 26 August public holiday. Record leave from 2026-08-24 to 2026-08-26.",
    dates: { startDate: "2026-08-24", endDate: "2026-08-26" },
  },
  {
    kind: "holiday-leave", from: 14, to: 15, targets: { keys: ["manager"] },
    text: `Leave clusters around the 26 August holiday: ${name("leaver")} (24-28 August), ${name("trainee")} (25-27 August) and ${name("intern")} (24-26 August). Record any that is missing with record_team_leave.`,
  },
  // Week 3: an external interview round.
  {
    kind: "interview-round", from: 9, to: 13, targets: { traits: ["job-hunting"] },
    text: "You have an external interview round this week: Monday 2026-08-17 a first-round interview with Pathao for Senior Software Engineer, and Thursday 2026-08-20 a technical interview with bKash for Backend Engineer. Report each with add_interview as policy requires, and update its stage and outcome after it happens.",
  },
  {
    kind: "interview-round", from: 22, to: 24, targets: { traits: ["job-hunting"] },
    text: "Pathao and bKash have come back to you. Update your interviews with the outcome (an offer, a rejection or a next round); withdraw any process you no longer want to pursue.",
  },
  // Weeks 4-5: the mid-run deadline crunch.
  {
    kind: "crunch", from: 16, to: 21, targets: { keys: ["manager"], traits: ["client-project"] },
    text: `Deadline crunch: the ${CLIENT} release is due on 2026-09-03. Hours are long; log your work and blockers accurately. Managers: note the crunch on the project assignments.`,
  },
  // Weeks 4-5: the transfer (a new department, then the assignment closed, then the transfer).
  {
    kind: "transfer", from: 14, to: 17, targets: { keys: ["admin"] },
    text: `${name("transfer")} is moving to a data platform team. Create the department "{platformDepartment}" under {cohortDepartment} (look up the parent's id first if needed) and keep its id in your notes; ${first("manager")} closes her assignment first.`,
  },
  {
    kind: "transfer", from: 18, to: 19, targets: { keys: ["manager"] },
    text: `${name("transfer")} transfers to "{platformDepartment}" this week. Close her open assignment now: a transfer is blocked while an assignment is open.`,
  },
  {
    kind: "transfer", from: 20, to: 21, targets: { keys: ["admin"] },
    text: `${name("transfer")}'s assignment should now be closed. Transfer her to "{platformDepartment}" with transfer_employee; if it is refused, note why.`,
  },
  {
    kind: "transfer", from: 18, to: 21, targets: { traits: ["transfer"] },
    text: `You move to the new "{platformDepartment}" team this week, once your assignment is closed. Wrap up and hand over your current work.`,
  },
  // Week 7: closure, then evaluations (some with client feedback).
  {
    kind: "closure-evaluations", from: 27, to: 31, targets: { keys: ["manager"] },
    text: `The ${PROJECT} has shipped. Close the project assignments of ${name("senior")}, ${name("client")} and ${name("designer")}, then evaluate each closed assignment. Include the client's feedback for at least two of them (${first("client")} has relayed it: "on time, few defects, clear communication").`,
  },
  {
    kind: "closure-evaluations", from: 27, to: 31, targets: { traits: ["client-project"] },
    text: `The ${PROJECT} has shipped and the assignments are being closed. Relay ${CLIENT}'s feedback in your work log and wrap up.`,
  },
  // Week 8: the skills review.
  {
    kind: "skills-review", from: 32, to: 35, targets: { keys: ["admin", "manager"] },
    text: "End-of-period skills review: for each staff member, rate one or two key skills (with evidence from the last eight weeks) and save an evaluation with strengths, development priorities and readiness.",
  },
  {
    kind: "skills-review", from: 32, to: 35, targets: { traits: ["trainee"], keys: ["intern", "senior", "jobhunter", "client", "leaver", "transfer", "designer"] },
    text: "The end-of-period skills review is this week. Make sure your record is up to date (employment history, any past project to backfill) so your managers have the evidence.",
  },
];

function targets(event: ScriptedEvent, personaKey: string): boolean {
  if (event.targets.keys?.includes(personaKey)) return true;
  const persona = PERSONAS.find(p => p.key === personaKey);
  return !!persona && !!event.targets.traits?.some(t => persona.traits.includes(t));
}

/**
 * The texts of the scripted events affecting a persona on a working day (index 0-based), with the
 * placeholders filled in from `vars`. `date` is the simulated date (used only to fill `{date}`).
 */
export function eventsFor(personaKey: string, dayIndex: number, date: string, vars: Readonly<Record<string, string>> = {}): string[] {
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (match, key: string) => (key === "date" ? date : vars[key] ?? match));
  return EVENT_SCRIPT.filter(e => dayIndex >= e.from && dayIndex <= e.to && targets(e, personaKey)).map(e => fill(e.text));
}

/** The distinct kinds the script covers, in script order. */
export function eventKinds(): EventKind[] {
  return [...new Set(EVENT_SCRIPT.map(e => e.kind))];
}
