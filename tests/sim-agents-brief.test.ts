import { describe, expect, it } from "vitest";
import type { Employee } from "@/data/employees";
import { BRIEF_MAX, dailyBrief, NOTES_MAX, OPEN_ITEMS_MAX, ownOpenItems, systemPrompt, teamOpenItems } from "../sim/agents/brief";
import { PERSONAS } from "../sim/personas";

// Story 9.3: the stable system prompt and the capped daily brief. Pure.

describe("systemPrompt (Story 9.3)", () => {
  it("describes the persona and its role with no date or run id, identically every call", () => {
    for (const persona of PERSONAS) {
      const prompt = systemPrompt(persona);
      expect(prompt).toContain(persona.name);
      expect(prompt).toContain(persona.personality);
      for (const goal of persona.goals) expect(prompt).toContain(goal);
      expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}|\bc\d{2}[0-9a-f]{4}\b/);
      expect(prompt).toMatch(/NOTES:/);
      expect(systemPrompt(persona)).toBe(prompt);
    }
    expect(systemPrompt(PERSONAS[0])).toMatch(/Administrator/);
    expect(systemPrompt(PERSONAS.find(p => p.role === "staff")!)).toMatch(/clock_in/);
  });
});

describe("dailyBrief (Story 9.3)", () => {
  const base = { date: "2026-08-10", index: 4, total: 37, events: ["Kickoff."], recent: ["2026-08-07 09:00 Clocked in."], notes: "Waiting on an assignment." };

  it("holds the date, day number, events, recent activity, notes and the reminder", () => {
    const brief = dailyBrief(base);
    expect(brief).toContain("Monday, 10 August 2026");
    expect(brief).toContain("2026-08-10");
    expect(brief).toContain("working day 5 of 37");
    expect(brief).toContain("- Kickoff.");
    expect(brief).toContain("2026-08-07 09:00 Clocked in.");
    expect(brief).toContain("Waiting on an assignment.");
    expect(brief).toMatch(/only through your tools and stay in character/);
    expect(dailyBrief({ ...base, events: [], recent: [], notes: "" })).toMatch(/Nothing special is scheduled today[\s\S]*nothing recorded[\s\S]*\(none yet\)/);
  });

  it("stays within BRIEF_MAX, keeping the newest recent lines and the reminder", () => {
    const recent = Array.from({ length: 40 }, (_, i) => `event ${String(i).padStart(2, "0")} ${"x".repeat(150)}`);
    const brief = dailyBrief({ ...base, events: ["e".repeat(2000), "f".repeat(500)], recent, notes: "n".repeat(5000) });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(brief).toMatch(/End your reply with a line starting "NOTES:"\.$/);
    expect(brief).not.toContain("n".repeat(NOTES_MAX + 1));
    const short = dailyBrief({ ...base, recent });
    expect(short.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(short).toContain("event 39");
    expect(short).not.toContain("event 00");
  });

  it("says older activity was omitted when every recent line is dropped, and never cuts the notes", () => {
    const notes = "n".repeat(NOTES_MAX);
    const brief = dailyBrief({
      ...base, events: ["e".repeat(3000)], recent: ["r".repeat(170), "s".repeat(170)], notes,
      openItems: Array.from({ length: 50 }, (_, i) => `item ${i} ${"o".repeat(40)}`),
    });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(brief).toContain(notes);
    expect(brief).toContain("(older activity omitted for length)");
    expect(brief).not.toContain("(nothing recorded)");
    expect(brief).toMatch(/End your reply with a line starting "NOTES:"\.$/);
  });

  it("shows open items, capped, and says when they could not be read", () => {
    const brief = dailyBrief({ ...base, openItems: ["Open assignment a-1: Portal (Meghna), QA, since 2026-08-03"] });
    expect(brief).toContain("Open items:\n- Open assignment a-1: Portal (Meghna), QA, since 2026-08-03");
    expect(dailyBrief({ ...base, openItems: null })).toContain("Open items:\n(open items unavailable)");
    expect(dailyBrief({ ...base, openItems: [] })).toContain("Open items:\n(none)");
    const long = dailyBrief({ ...base, openItems: Array.from({ length: 50 }, (_, i) => `item ${i} ${"o".repeat(40)}`) });
    const section = long.slice(long.indexOf("Open items:"), long.indexOf("\n\nYour recent activity"));
    expect(section.length).toBeLessThanOrEqual(OPEN_ITEMS_MAX);
  });
});

describe("open items (Story 9.3)", () => {
  const assignment = (id: string, status: "open" | "closed") => ({ id, client: "Meghna", projectName: `P-${id}`, role: "QA", startDate: "2026-08-03", status });
  const employee = (over: Partial<Record<string, unknown>>) => ({
    id: "BS-2003", name: "Sadia Mahmud", assignments: [], evaluations: [], leave: [], interviews: [], ...over,
  }) as unknown as Employee;

  it("lists a staff member's open assignment, leave from today on and active interviews", () => {
    const items = ownOpenItems(employee({
      assignments: [assignment("a-1", "open"), assignment("a-0", "closed")],
      leave: [
        { id: "l-1", startDate: "2026-08-24", endDate: "2026-08-28", cancelledAt: null },
        { id: "l-0", startDate: "2026-08-03", endDate: "2026-08-04", cancelledAt: null },
        { id: "l-2", startDate: "2026-09-01", endDate: "2026-09-02", cancelledAt: "2026-08-05T00:00:00Z" },
      ],
      interviews: [
        { id: "i-1", company: "Pathao", role: "SSE", date: "2026-08-17", stage: "First round", outcome: "", withdrawn: false },
        { id: "i-0", company: "Old", role: "x", date: "2026-08-01", stage: "x", outcome: "", withdrawn: true },
      ],
    }), "2026-08-10");
    expect(items).toEqual([
      "Open assignment a-1: P-a-1 (Meghna), QA, since 2026-08-03",
      "Leave l-1: 2026-08-24 to 2026-08-28",
      "Interview i-1: Pathao, SSE, 2026-08-17, First round",
    ]);
  });

  it("lists the team's open assignments and closed ones still to evaluate", () => {
    const items = teamOpenItems([
      employee({ assignments: [assignment("a-1", "open"), assignment("a-2", "closed"), assignment("a-3", "closed")], evaluations: [{ assignmentId: "a-3" }] }),
      employee({ id: "BS-2009", name: "Archived", archived: true, assignments: [assignment("a-9", "open")] }),
    ]);
    expect(items).toEqual([
      "Sadia Mahmud (BS-2003): open assignment a-1, P-a-1",
      "Sadia Mahmud (BS-2003): closed assignment a-2 (P-a-2) not yet evaluated",
    ]);
  });
});
