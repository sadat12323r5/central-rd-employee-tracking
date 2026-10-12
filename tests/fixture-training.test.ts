import { describe, expect, it } from "vitest";
import { employees, interviewSeedId, trainingSeedId, trainingSeedRows } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";

// The fixture's completed training is seed data for `training_history` (scripts/seed-employees.ts);
// its in-progress entries are never copied into the table (served by training-store until Story 3.2).
describe("fixture training as seed rows", () => {
  const all = employees.flatMap(e => e.training.map((training, index) => ({ employeeId: e.id, index, training })));

  it("gives each entry its deterministic seed id (stable per employee and index)", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const { employeeId, index, training } of all) expect(training.id).toBe(trainingSeedId(employeeId, index));
    expect(trainingSeedId("BS-1001", 0)).toBe("7a1a0000-0000-4000-8000-000010010000");
    expect(trainingSeedId("BS-1001", 0)).toBe(trainingSeedId("BS-1001", 0));
  });

  it("use unique, valid UUIDs, distinct from the interview seed ids", () => {
    const ids = all.map(a => a.training.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(trainingSeedId("BS-1001", 0)).not.toBe(interviewSeedId("BS-1001", 0));
    const interviewIds = new Set(employees.flatMap(e => e.interviews.map(i => i.id)));
    for (const id of ids) expect(interviewIds.has(id)).toBe(false);
  });

  it("are completed (progress 100) or in progress; every employee has at least one of each", () => {
    for (const e of employees) {
      expect(e.training.some(t => t.progress === 100)).toBe(true);
      expect(e.training.some(t => t.progress < 100)).toBe(true);
    }
  });

  it("seed completed entries only, mapped to training_history rows (what db:seed inserts)", () => {
    const rows = trainingSeedRows(employees);
    const completed = all.filter(a => a.training.progress === 100);
    expect(rows).toHaveLength(completed.length);
    expect(rows.map(r => r.id)).toEqual(completed.map(a => a.training.id));
    for (const { training } of all.filter(a => a.training.progress < 100)) expect(rows.some(r => r.id === training.id)).toBe(false);
    const nadia = employees.find(e => e.id === "BS-1001")!.training[0];
    expect(rows.filter(r => r.employee_id === "BS-1001")).toEqual([{
      id: trainingSeedId("BS-1001", 0), employee_id: "BS-1001", programme: nadia.name, provider: "BS23 Learning & Development",
      result: "Completed · assessment passed", completed_on: "2026-08-20",
    }]);
  });

  it("have no department column and fit the table's constraints", () => {
    for (const row of trainingSeedRows(employees)) {
      expect(Object.keys(row).sort()).toEqual(["completed_on", "employee_id", "id", "programme", "provider", "result"]);
      for (const value of [row.programme, row.provider, row.result]) {
        expect(value.trim().length).toBeGreaterThanOrEqual(1);
        expect(value.length).toBeLessThanOrEqual(200);
      }
      expect(isCalendarDate(row.completed_on)).toBe(true);
    }
  });

  it("refuses ids it cannot derive", () => {
    expect(() => trainingSeedId("1001", 0)).toThrow();
    expect(() => trainingSeedId("BS-1001", -1)).toThrow();
  });
});
