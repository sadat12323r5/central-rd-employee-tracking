import { describe, expect, it } from "vitest";
import { BRIEF_MAX, dailyBrief, NOTES_MAX, systemPrompt } from "../sim/agents/brief";
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
});
