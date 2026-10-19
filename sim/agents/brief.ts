import type { Employee } from "@/data/employees";
import { SIM_END } from "../calendar";
import type { Persona, PersonaRole } from "../personas";

// Story 9.3: what a persona agent is told. The system prompt is the stable, cached prefix: it holds the
// persona and its role's ground rules and never a date, run id or anything else that changes from day to
// day. Everything per-day goes in the daily brief (the one user message of that day's conversation),
// which is capped at BRIEF_MAX characters. Both are pure.

export const BRIEF_MAX = 2500;
export const NOTES_MAX = 1200;
export const RECENT_MAX_EVENTS = 12;
const RECENT_LINE_MAX = 180;
/** Today's scripted events, together. */
const EVENTS_MAX = 900;

const ROLE_GUIDE: Record<PersonaRole, string> = {
  staff: [
    "You are a staff member. Each working day: clock in when you start (clock_in), save a short work log with tasks and hours (save_work_log) and clock out when you finish (clock_out).",
    "You also keep your own record current: leave (record_leave, edit_leave, cancel_leave), external interviews, which company policy requires you to report (add_interview, update_interview, withdraw_interview), past projects (backfill_project) and employment history. read_my_record shows your record.",
  ].join(" "),
  manager: [
    "You are the department manager. You see and act only on your own department's people (read_team).",
    "You staff client and internal work with assignments (create_assignment, update_assignment_note, close_assignment), evaluate closed assignments (evaluate_assignment, with client feedback when you have it), rate skills and write evaluations (rate_skill, save_evaluation), record leave for your team (record_team_leave), transfer people within your authority (transfer_employee) and export your department's activity.",
  ].join(" "),
  admin: [
    "You are the L&D manager and the organisation's Administrator. You can do everything a manager can, organisation-wide, plus department administration (create_department, update_department, set_department_manager) and the all-employee activity export.",
    "Use read_team to find employee ids and department ids before acting on them.",
  ].join(" "),
};

/** The persona's stable system prompt (no dates, no run id, nothing per-day). */
export function systemPrompt(persona: Persona, role: PersonaRole = persona.role): string {
  return [
    `You are ${persona.name}, ${persona.title} (${persona.seniority}, ${persona.employmentType}) at Central R&D, a software engineering organisation in Dhaka, Bangladesh.`,
    `Personality: ${persona.personality}`,
    `Goals: ${persona.goals.join("; ")}.`,
    "",
    ROLE_GUIDE[role],
    "",
    "How you work:",
    "- You act only through the tools you are given, which are the company's employee-records system. Nothing happens unless a tool call does it.",
    "- Stay in character. Do what this person would realistically do today: usually a few routine actions, sometimes nothing.",
    "- A tool error is the system's answer (validation, permissions, overlapping dates, calendar rules). Read it and adapt; never repeat the same refused call unchanged and never try to get around a rule.",
    "- You have a small number of tool calls per day; use them for what matters.",
    "- Never invent ids: read them from tool results or your notes.",
    "- End every reply with a line starting \"NOTES:\" followed by your compact notes for tomorrow (open items, ids you will need, what you are waiting on). They replace your previous notes, so keep what still matters.",
  ].join("\n");
}

export type BriefInput = {
  /** ISO date. */
  date: string;
  /** 0-based working-day index. */
  index: number;
  /** Working days in the run. */
  total: number;
  /** Scripted event texts affecting the persona today. */
  events: readonly string[];
  /** The persona's own recent timeline lines (oldest first). */
  recent: readonly string[];
  notes: string;
  /** Open items from the persona's own stores; null when they could not be read. */
  openItems?: readonly string[] | null;
};

export const OPEN_ITEMS_MAX = 600;

const cap = (text: string, max: number) => (max <= 0 ? "" : text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** A staff member's open items from its own record: open assignment, leave from today on, active interviews. */
export function ownOpenItems(employee: Employee, today: string): string[] {
  const items: string[] = [];
  const open = employee.assignments.find(a => a.status === "open");
  if (open) items.push(`Open assignment ${open.id}: ${open.projectName} (${open.client}), ${open.role}, since ${open.startDate}`);
  for (const l of employee.leave.filter(l => !l.cancelledAt && l.endDate >= today && l.startDate <= SIM_END)) {
    items.push(`Leave ${l.id}: ${l.startDate} to ${l.endDate}`);
  }
  for (const i of employee.interviews.filter(i => !i.withdrawn)) {
    items.push(`Interview ${i.id}: ${i.company}, ${i.role}, ${i.date}, ${i.stage}${i.outcome ? ` (${i.outcome})` : ""}`);
  }
  return items;
}

/** A manager's or the Administrator's open items: the team's open assignments and closed ones still to evaluate. */
export function teamOpenItems(employees: readonly Employee[]): string[] {
  const items: string[] = [];
  for (const e of employees.filter(e => !e.archived)) {
    const evaluated = new Set(e.evaluations.map(v => v.assignmentId));
    const open = e.assignments.find(a => a.status === "open");
    if (open) items.push(`${e.name} (${e.id}): open assignment ${open.id}, ${open.projectName}`);
    for (const a of e.assignments.filter(a => a.status === "closed" && !evaluated.has(a.id))) {
      items.push(`${e.name} (${e.id}): closed assignment ${a.id} (${a.projectName}) not yet evaluated`);
    }
  }
  return items;
}

/**
 * The day's brief: date and day number, today's scripted events, open items, recent events, notes and a
 * reminder. At most BRIEF_MAX characters. The header, notes (the carried state) and reminder always fit;
 * open items and events are capped; recent activity gets what is left and is cut first.
 */
export function dailyBrief({ date, index, total, events, recent, notes, openItems = [] }: BriefInput): string {
  const header = `Today is ${weekday(date)} (${date}), working day ${index + 1} of ${total}.`;
  const notesText = `Your notes from yesterday:\n${notes.trim() ? cap(notes.trim(), NOTES_MAX) : "(none yet)"}`;
  const reminder = "Act only through your tools and stay in character. End your reply with a line starting \"NOTES:\".";
  const openText = cap(`Open items:\n${openItems === null ? "(open items unavailable)" : openItems.length > 0 ? openItems.map(i => `- ${i}`).join("\n") : "(none)"}`, OPEN_ITEMS_MAX);
  const recentTitle = "Your recent activity (last 3 working days):\n";
  const omitted = "- (older activity omitted for length)";
  const separators = 5 * 2;
  const reserved = header.length + notesText.length + reminder.length + openText.length + recentTitle.length + omitted.length + separators;
  const today = events.length > 0
    ? cap(`Happening today:\n${events.map(e => `- ${e}`).join("\n")}`, Math.min(EVENTS_MAX, BRIEF_MAX - reserved))
    : "Nothing special is scheduled today.";

  // The recent events fill what is left, newest kept first.
  const room = BRIEF_MAX - (reserved - omitted.length) - today.length;
  const lines: string[] = [];
  let used = 0;
  for (const line of [...recent].slice(-RECENT_MAX_EVENTS).reverse()) {
    const item = `- ${cap(line.replace(/\s+/g, " ").trim(), RECENT_LINE_MAX)}`;
    if (used + item.length + 1 > room) break;
    lines.unshift(item);
    used += item.length + 1;
  }
  const recentBody = lines.length > 0 ? lines.join("\n") : recent.length > 0 ? omitted : "- (nothing recorded)";
  const brief = [header, today, openText, `${recentTitle}${recentBody}`, notesText, reminder].join("\n\n");
  return cap(brief, BRIEF_MAX);
}
