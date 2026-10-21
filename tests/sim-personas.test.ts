import { describe, expect, it } from "vitest";
import { ADMIN_KEY, missingCoverage, PERSONAS, REQUIRED_TRAITS } from "../sim/personas";

describe("simulation personas (Story 9.1)", () => {
  it("has 1 Administrator, 1 manager and 8 staff, with unique keys", () => {
    expect(PERSONAS.filter(p => p.role === "admin").map(p => p.key)).toEqual([ADMIN_KEY]);
    expect(PERSONAS.filter(p => p.role === "manager")).toHaveLength(1);
    expect(PERSONAS.filter(p => p.role === "staff")).toHaveLength(8);
    expect(new Set(PERSONAS.map(p => p.key)).size).toBe(PERSONAS.length);
    expect(PERSONAS.every(p => /^[a-z0-9]+$/.test(p.key))).toBe(true);
  });

  it("covers every required trait", () => {
    expect(missingCoverage(PERSONAS)).toEqual([]);
  });

  it("gives every persona a role, seniority, personality, goals and a valid profile", () => {
    for (const p of PERSONAS) {
      expect(["admin", "manager", "staff"]).toContain(p.role);
      expect(p.seniority.trim()).not.toBe("");
      expect(p.personality.trim()).not.toBe("");
      expect(p.goals.length).toBeGreaterThan(0);
      expect(p.goals.every(g => g.trim() !== "")).toBe(true);
      expect(["Permanent", "Trainee", "Intern"]).toContain(p.employmentType);
      expect(p.joinedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.name.length).toBeLessThanOrEqual(120);
      expect(p.title.length).toBeLessThanOrEqual(120);
    }
    expect(PERSONAS.find(p => p.traits.includes("trainee"))?.employmentType).toBe("Trainee");
  });

  it("reports what a cohort fails to cover", () => {
    const withoutTransfer = PERSONAS.map(p => ({ ...p, traits: p.traits.filter(t => t !== "transfer") }));
    expect(missingCoverage(withoutTransfer)).toEqual(["trait:transfer"]);
    expect(missingCoverage([])).toEqual([...REQUIRED_TRAITS.map(t => `trait:${t}`), "role:admin", "role:manager", "role:staff"]);
  });
});
