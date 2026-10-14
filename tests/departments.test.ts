import { describe, expect, it } from "vitest";
import {
  ancestorIds, DepartmentHierarchyError, normalizeDepartmentName, sameDepartmentName, wouldCreateCycle, type Department,
} from "@/domain/departments";
import { CENTRAL_RD_DEPARTMENT_ID, DEFAULT_EMPLOYEE_DEPARTMENT_ID, departmentSeedRows, LND_DEPARTMENT_ID, seedDepartments } from "@/data/departments";

const list: Department[] = [
  { id: "lnd", name: "L&D", parentId: null },
  { id: "crd", name: "Central R&D", parentId: "lnd" },
  { id: "qa", name: "QA Lab", parentId: "crd" },
  { id: "ops", name: "Operations", parentId: null },
];

describe("normalizeDepartmentName", () => {
  it("trims and collapses inner whitespace", () => {
    expect(normalizeDepartmentName("  Central \t  R&D \n")).toBe("Central R&D");
    expect(normalizeDepartmentName("   ")).toBe("");
  });
});

describe("sameDepartmentName", () => {
  it("compares case-insensitively after normalisation", () => {
    expect(sameDepartmentName("Central R&D", "central r&d ")).toBe(true);
    expect(sameDepartmentName("Central  R&D", "CENTRAL R&D")).toBe(true);
    expect(sameDepartmentName("Central R&D", "Central RD")).toBe(false);
  });
});

describe("ancestorIds", () => {
  it("returns the ancestors nearest first", () => {
    expect(ancestorIds(list, "qa")).toEqual(["crd", "lnd"]);
    expect(ancestorIds(list, "lnd")).toEqual([]);
  });

  it("returns nothing for an unknown id and stops at an unknown parent", () => {
    expect(ancestorIds(list, "nope")).toEqual([]);
    expect(ancestorIds([{ id: "a", name: "A", parentId: "missing" }], "a")).toEqual(["missing"]);
  });

  it("throws instead of looping when the stored list already loops", () => {
    const looped: Department[] = [
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "c" },
      { id: "c", name: "C", parentId: "b" },
    ];
    expect(() => ancestorIds(looped, "a")).toThrow(DepartmentHierarchyError);
    expect(() => ancestorIds([{ id: "a", name: "A", parentId: "a" }], "a")).toThrow(DepartmentHierarchyError);
  });
});

describe("wouldCreateCycle", () => {
  it("never for the top level", () => {
    expect(wouldCreateCycle(list, "lnd", null)).toBe(false);
  });

  it("for a department placed under itself", () => {
    expect(wouldCreateCycle(list, "crd", "crd")).toBe(true);
  });

  it("for a department placed under one of its descendants", () => {
    expect(wouldCreateCycle(list, "lnd", "crd")).toBe(true);
    expect(wouldCreateCycle(list, "lnd", "qa")).toBe(true);
  });

  it("not for a sibling, an ancestor or an unrelated department", () => {
    expect(wouldCreateCycle(list, "qa", "lnd")).toBe(false);
    expect(wouldCreateCycle(list, "crd", "ops")).toBe(false);
    expect(wouldCreateCycle(list, "ops", "qa")).toBe(false);
  });
});

describe("seed departments", () => {
  it("is L&D at the top level and Central R&D under it, parents first", () => {
    expect(seedDepartments).toEqual([
      { id: LND_DEPARTMENT_ID, name: "L&D", parentId: null },
      { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parentId: LND_DEPARTMENT_ID },
    ]);
    expect(departmentSeedRows()).toEqual([
      { id: LND_DEPARTMENT_ID, name: "L&D", parent_department_id: null },
      { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parent_department_id: LND_DEPARTMENT_ID },
    ]);
  });

  it("puts fixture employees in Central R&D, with valid UUIDs", () => {
    expect(DEFAULT_EMPLOYEE_DEPARTMENT_ID).toBe(CENTRAL_RD_DEPARTMENT_ID);
    for (const id of [LND_DEPARTMENT_ID, CENTRAL_RD_DEPARTMENT_ID]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
