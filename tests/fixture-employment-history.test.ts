import { describe, expect, it } from "vitest";
import { employees, employmentHistorySeedId, employmentHistorySeedRows } from "@/data/employees";
import { invalidEmploymentHistoryFields, normalizeEmploymentHistory, sortNewestFirst } from "@/domain/employment-history";

// Story 7.3: the fixture's employment history is seed data for `employment_history` (scripts/seed-employees.ts).
describe("fixture employment history as seed rows", () => {
  const all = employees.flatMap(e => e.history.map((entry, index) => ({ employeeId: e.id, index, entry })));

  it("gives each entry its deterministic seed id (stable per employee and index)", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const { employeeId, index, entry } of all) expect(entry.id).toBe(employmentHistorySeedId(employeeId, index));
    expect(employmentHistorySeedId("BS-1001", 0)).toBe("e4b10000-0000-4000-8000-000010010000");
    expect(employmentHistorySeedId("BS-1008", 1)).toBe("e4b10000-0000-4000-8000-000010080001");
  });

  it("uses unique, valid UUIDs", () => {
    const ids = all.map(a => a.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("fits the table's constraints (already normalised)", () => {
    for (const { entry } of all) {
      const input = { role: entry.role, employer: entry.company, period: entry.period, detail: entry.detail };
      expect(normalizeEmploymentHistory(input)).toEqual(input);
      expect(invalidEmploymentHistoryFields(input)).toEqual([]);
    }
  });

  it("is already newest first, so the Employment tab keeps its order after the move", () => {
    for (const e of employees) {
      const sorted = sortNewestFirst(e.history.map(h => ({ ...h, createdAt: "2026-10-15T00:00:00Z" })));
      expect(sorted.map(h => h.id)).toEqual(e.history.map(h => h.id));
    }
  });

  it("maps to employment_history rows (what db:seed inserts), leaving author, timestamps and removed_at to the table", () => {
    const rows = employmentHistorySeedRows(employees);
    expect(rows).toHaveLength(all.length);
    const fahim = employees.find(e => e.id === "BS-1008")!;
    expect(rows.filter(r => r.employee_id === "BS-1008")).toEqual([
      { id: employmentHistorySeedId("BS-1008", 0), employee_id: "BS-1008", role: fahim.title, employer: "Brain Station 23", period: "2022-02-06 – Present", detail: fahim.history[0].detail },
      { id: employmentHistorySeedId("BS-1008", 1), employee_id: "BS-1008", role: fahim.history[1].role, employer: "Example Digital Ltd. (fictional)", period: "2021 – 2022", detail: fahim.history[1].detail },
    ]);
    for (const row of rows) for (const key of ["removed_at", "created_at", "created_by", "updated_at"]) expect(row).not.toHaveProperty(key);
  });

  it("refuses ids it cannot derive", () => {
    expect(() => employmentHistorySeedId("1001", 0)).toThrow();
    expect(() => employmentHistorySeedId("BS-1001", -1)).toThrow();
  });
});
