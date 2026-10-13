import { describe, expect, it } from "vitest";
import { employees, interviewSeedId, lmsStubSeedId, lmsStubSeedRows, trainingSeedId, trainingSeedRows } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";

// The fixture is seed-only for training (scripts/seed-employees.ts): its completed entries seed
// `training_history`, its in-progress entries seed the LMS stub table `lms_stub_enrolments` (Story 3.2).
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

describe("fixture in-progress training as LMS stub seed rows (Story 3.2)", () => {
  const inProgress = employees.flatMap(e => e.training.flatMap((training, index) => (training.progress < 100 ? [{ employeeId: e.id, index, training }] : [])));

  it("seed in-progress entries only, as in_progress enrolments dated by their target date", () => {
    const rows = lmsStubSeedRows(employees);
    expect(rows).toHaveLength(inProgress.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.status === "in_progress" && r.progress < 100)).toBe(true);
    const nadia = employees.find(e => e.id === "BS-1001")!.training[1];
    expect(rows.filter(r => r.employee_id === "BS-1001")).toEqual([{
      id: lmsStubSeedId("BS-1001", 1), employee_id: "BS-1001", programme: nadia.name, provider: nadia.provider,
      status: "in_progress", progress: nadia.progress, target_date: "2026-09-28",
    }]);
    const completedNames = new Set(employees.flatMap(e => e.training.filter(t => t.progress === 100).map(t => `${e.id}|${t.name}`)));
    for (const row of rows) expect(completedNames.has(`${row.employee_id}|${row.programme}`)).toBe(false);
  });

  it("use deterministic ids, distinct from the training and interview seed ids", () => {
    expect(lmsStubSeedId("BS-1001", 1)).toBe("1a5b0000-0000-4000-8000-000010010001");
    const ids = lmsStubSeedRows(employees).map(r => r.id);
    expect(ids).toEqual(inProgress.map(a => lmsStubSeedId(a.employeeId, a.index)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const others = new Set([...employees.flatMap(e => e.training.map(t => t.id)), ...employees.flatMap(e => e.interviews.map(i => i.id))]);
    for (const id of ids) expect(others.has(id)).toBe(false);
  });

  it("fit the table's constraints and have no department column", () => {
    for (const row of lmsStubSeedRows(employees)) {
      expect(Object.keys(row).sort()).toEqual(["employee_id", "id", "programme", "progress", "provider", "status", "target_date"]);
      for (const value of [row.programme, row.provider]) {
        expect(value.trim().length).toBeGreaterThanOrEqual(1);
        expect(value.length).toBeLessThanOrEqual(200);
      }
      expect(Number.isInteger(row.progress) && row.progress >= 0 && row.progress < 100).toBe(true);
      expect(isCalendarDate(row.target_date)).toBe(true);
    }
  });

  it("refuses ids it cannot derive", () => {
    expect(() => lmsStubSeedId("1001", 0)).toThrow();
    expect(() => lmsStubSeedId("BS-1001", 0x10000)).toThrow();
  });
});
