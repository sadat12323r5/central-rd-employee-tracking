import { describe, expect, it } from "vitest";
import {
  assignmentSeedId, assignmentSeedRows, employees, fixtureCurrentWork, interviewSeedId, lmsStubSeedId, periodStartDate, trainingSeedId,
  type FixtureWork,
} from "@/data/employees";
import { isCalendarDate } from "@/domain/dates";

// Story 4.5: the fixture's former "current work" is seed-only (scripts/seed-employees.ts turns each record
// into an open assignment). The Git commit counts were dropped, and the fixture's own assignments are empty.
describe("fixture current work as assignment seed rows", () => {
  it("keeps one work record per fixture employee, without commits, and no `work` on the employees", () => {
    expect(fixtureCurrentWork.map(w => w.employeeId)).toEqual(employees.map(e => e.id));
    for (const w of fixtureCurrentWork) expect(w).not.toHaveProperty("commits");
    for (const e of employees) {
      expect(e).not.toHaveProperty("work");
      expect(e.assignments).toEqual([]);
    }
  });

  it("gives each employee a deterministic, valid UUID, distinct from the other seed ids", () => {
    expect(assignmentSeedId("BS-1001")).toBe("a5510000-0000-4000-8000-000010010000");
    const ids = employees.map(e => assignmentSeedId(e.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(assignmentSeedId("BS-1001")).not.toBe(interviewSeedId("BS-1001", 0));
    expect(assignmentSeedId("BS-1001")).not.toBe(trainingSeedId("BS-1001", 0));
    expect(assignmentSeedId("BS-1001")).not.toBe(lmsStubSeedId("BS-1001", 0));
    expect(() => assignmentSeedId("1001")).toThrow();
  });

  it("parses the first day of a work period, and nothing else", () => {
    expect(periodStartDate("14–20 Sep 2026")).toBe("2026-09-14");
    expect(periodStartDate("14-20 Sep 2026")).toBe("2026-09-14");
    expect(periodStartDate("3 Oct 2026")).toBe("2026-10-03");
    for (const bad of ["ongoing", "", "31 Feb 2026", "14–20 Foo 2026", "Sep 2026", "2026-09-14"]) expect(periodStartDate(bad)).toBeNull();
  });

  it("seeds one open-assignment row per employee: client \"Not recorded\", start date from the period, the fixture's project, role, allocation and update", () => {
    const rows = assignmentSeedRows(employees);
    expect(rows).toHaveLength(employees.length);
    expect(rows[0]).toEqual({
      id: "a5510000-0000-4000-8000-000010010000", employee_id: "BS-1001", client: "Not recorded",
      project_name: "Customer experience platform", role: "Software Engineer I", allocation: 80, start_date: "2026-09-14",
      latest_update: "Reviewed this week's deliverables and documented the next implementation steps.",
    });
    for (const row of rows) {
      expect(row.client).toBe("Not recorded");
      expect(row.start_date).toBe("2026-09-14");
      expect(isCalendarDate(row.start_date)).toBe(true);
      expect(Number.isInteger(row.allocation) && row.allocation >= 0 && row.allocation <= 100).toBe(true);
      expect(row.project_name.length).toBeGreaterThan(0);
      expect(row.project_name.length).toBeLessThanOrEqual(200);
      expect(row.role.length).toBeGreaterThan(0);
      // Never caller-chosen: the database copies the employee's department; status is always open on insert.
      expect(row).not.toHaveProperty("department_id");
      expect(row).not.toHaveProperty("status");
      expect(row).not.toHaveProperty("completion_date");
      expect(row).not.toHaveProperty("commits");
    }
    // Available employees are at 0%.
    expect(rows.find(r => r.employee_id === "BS-1004")?.allocation).toBe(0);
  });

  it("falls back to the join date when the period does not parse", () => {
    const work: FixtureWork[] = [{ employeeId: "BS-1003", project: "Capstone", role: "Supervised contributor", allocation: 50, update: "", period: "ongoing" }];
    const [row] = assignmentSeedRows(employees, work);
    expect(row.start_date).toBe(employees.find(e => e.id === "BS-1003")!.joined);
    // Employees without a work record get no row.
    expect(assignmentSeedRows(employees, work)).toHaveLength(1);
  });
});
