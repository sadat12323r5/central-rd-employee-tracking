import { describe, expect, it } from "vitest";
import { employees, interviewSeedId, interviewSeedRows } from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";

// The fixture's interviews are seed data for `external_interviews` (scripts/seed-employees.ts).
describe("fixture interviews as seed rows", () => {
  const all = employees.flatMap(e => e.interviews.map((interview, index) => ({ employeeId: e.id, index, interview })));

  it("give each interview its deterministic seed id (stable per employee and index)", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const { employeeId, index, interview } of all) expect(interview.id).toBe(interviewSeedId(employeeId, index));
    expect(interviewSeedId("BS-1001", 0)).toBe("5eed0000-0000-4000-8000-000010010000");
    expect(interviewSeedId("BS-1001", 0)).toBe(interviewSeedId("BS-1001", 0));
  });

  it("use unique, valid UUIDs", () => {
    const ids = all.map(a => a.interview.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(interviewSeedId("BS-1001", 1)).not.toBe(interviewSeedId("BS-1001", 0));
    expect(interviewSeedId("BS-1002", 0)).not.toBe(interviewSeedId("BS-1001", 0));
  });

  it("fit the table's constraints", () => {
    for (const { interview } of all) {
      for (const value of [interview.company, interview.role, interview.stage]) expect(value.trim().length).toBeGreaterThanOrEqual(1);
      for (const value of [interview.company, interview.role, interview.stage, interview.outcome]) expect(value.length).toBeLessThanOrEqual(200);
      expect(interview.feedback.length).toBeLessThanOrEqual(2000);
      expect(isCalendarDate(interview.date)).toBe(true);
    }
  });

  it("map to external_interviews rows (what db:seed upserts)", () => {
    const rows = interviewSeedRows(employees);
    expect(rows).toHaveLength(employees.reduce((n, e) => n + e.interviews.length, 0));
    const nadia = employees.find(e => e.id === "BS-1001")!.interviews[0];
    expect(rows.filter(r => r.employee_id === "BS-1001")).toEqual([{
      id: interviewSeedId("BS-1001", 0), employee_id: "BS-1001", company: "Northstar Labs (fictional)", role: nadia.role,
      stage: "Technical interview", interview_date: "2026-09-23", outcome: "Scheduled", feedback: nadia.feedback,
    }]);
    expect(nadia.feedback.length).toBeGreaterThan(0);
  });

  it("are all active (not withdrawn); seed rows leave withdrawn_at to the column default", () => {
    for (const { interview } of all) expect(interview.withdrawn).toBe(false);
    for (const row of interviewSeedRows(employees)) expect(row).not.toHaveProperty("withdrawn_at");
  });

  it("refuses ids it cannot derive", () => {
    expect(() => interviewSeedId("1001", 0)).toThrow();
    expect(() => interviewSeedId("BS-1001", -1)).toThrow();
  });
});
