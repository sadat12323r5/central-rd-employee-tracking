import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCalendar, toCalendarPolicy } from "@/domain/holiday-calendar";
import { EVENT_KINDS, EVENT_SCRIPT, eventKinds, eventsFor } from "../sim/agents/events";
import { simulatedCalendar } from "../sim/calendar";
import { PERSONAS } from "../sim/personas";

// Story 9.3: the deterministic eight-week event script over the BD-2026 calendar's 37 working days.

const csv = readFileSync(join(import.meta.dirname, "..", "docs", "holiday-calendars", "bangladesh-2026.csv"), "utf8");
const calendar = simulatedCalendar(toCalendarPolicy(buildCalendar([{ name: "bangladesh-2026.csv", text: csv }])));

describe("EVENT_SCRIPT (Story 9.3)", () => {
  it("covers all seven kinds within the 37 working days", () => {
    expect(calendar.workingDays).toHaveLength(37);
    expect(eventKinds().sort()).toEqual([...EVENT_KINDS].sort());
    expect(EVENT_KINDS).toHaveLength(7);
    for (const event of EVENT_SCRIPT) {
      expect(event.from, event.kind).toBeGreaterThanOrEqual(0);
      expect(event.to, event.kind).toBeLessThan(calendar.workingDays.length);
      expect(event.from, event.kind).toBeLessThanOrEqual(event.to);
    }
  });

  it("targets only persona keys and traits that exist, and every event reaches someone", () => {
    const keys = new Set(PERSONAS.map(p => p.key));
    const traits = new Set(PERSONAS.flatMap(p => p.traits));
    for (const event of EVENT_SCRIPT) {
      for (const key of event.targets.keys ?? []) expect(keys.has(key), key).toBe(true);
      for (const trait of event.targets.traits ?? []) expect(traits.has(trait), trait).toBe(true);
      const reached = PERSONAS.filter(p => eventsFor(p.key, event.from, calendar.workingDays[event.from]).includes(event.text));
      expect(reached.length, event.kind).toBeGreaterThan(0);
    }
  });

  it("puts each kind in the briefs of its targets over the eight weeks", () => {
    const seen = new Map<string, Set<string>>();
    calendar.workingDays.forEach((date, index) => {
      for (const persona of PERSONAS) {
        for (const text of eventsFor(persona.key, index, date)) {
          const event = EVENT_SCRIPT.find(e => e.text === text)!;
          expect(event, text).toBeDefined();
          if (!seen.has(event.kind)) seen.set(event.kind, new Set());
          seen.get(event.kind)!.add(persona.key);
        }
      }
    });
    expect([...seen.keys()].sort()).toEqual([...EVENT_KINDS].sort());
    expect(seen.get("kickoff")).toEqual(new Set(["manager", "admin", "senior", "client", "designer"]));
    expect(seen.get("interview-round")).toEqual(new Set(["jobhunter"]));
    expect(seen.get("transfer")).toEqual(new Set(["admin", "manager", "transfer"]));
    expect(seen.get("holiday-leave")).toContain("leaver");
    expect(seen.get("closure-evaluations")).toContain("manager");
    expect(seen.get("skills-review")).toEqual(new Set(PERSONAS.map(p => p.key)));
  });

  it("asks for holiday leave touching the 26 August holiday, before it", () => {
    const leave = EVENT_SCRIPT.filter(e => e.kind === "holiday-leave" && e.dates);
    expect(leave.length).toBeGreaterThan(0);
    for (const event of leave) {
      expect(event.dates!.startDate <= "2026-08-26" && event.dates!.endDate >= "2026-08-26").toBe(true);
    }
    const first = Math.min(...leave.map(e => e.from));
    expect(calendar.workingDays[first] < "2026-08-24").toBe(true);
    expect(calendar.holidays.map(h => h.date)).toContain("2026-08-26");
  });

  it("clusters leave around a public holiday: at least three staff ask for leave touching it", () => {
    const holidays = calendar.holidays.map(h => h.date);
    const touching = EVENT_SCRIPT.filter(e => e.kind === "holiday-leave" && e.dates
      && holidays.some(h => e.dates!.startDate <= h && e.dates!.endDate >= h));
    const staff = new Set(PERSONAS.filter(p => touching.some(e => e.targets.keys?.includes(p.key) || e.targets.traits?.some(t => p.traits.includes(t))))
      .filter(p => p.role === "staff").map(p => p.key));
    expect(staff.size).toBeGreaterThanOrEqual(3);
    expect([...staff]).toContain("leaver");
  });

  it("orders the transfer: department first, then the assignment closed, then the transfer", () => {
    const transfer = EVENT_SCRIPT.filter(e => e.kind === "transfer");
    const create = transfer.find(e => /Create the department/.test(e.text))!;
    const close = transfer.find(e => /Close her open assignment/.test(e.text))!;
    const move = transfer.find(e => /transfer_employee/.test(e.text))!;
    expect(create.to).toBeLessThan(close.from);
    expect(close.to).toBeLessThan(move.from);
  });

  it("fills placeholders and returns nothing for an untargeted persona", () => {
    const index = EVENT_SCRIPT.find(e => e.kind === "transfer" && e.targets.keys?.includes("admin"))!.from;
    const [text] = eventsFor("admin", index, calendar.workingDays[index], { cohortDepartment: "Simulation Cohort c00ab12", platformDepartment: "Simulation Cohort c00ab12 Platform" });
    expect(text).toContain("\"Simulation Cohort c00ab12 Platform\" under Simulation Cohort c00ab12");
    expect(eventsFor("intern", 12, calendar.workingDays[12])).toEqual([]);
  });
});
