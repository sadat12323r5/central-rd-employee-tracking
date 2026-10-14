import { describe, expect, it } from "vitest";
import {
  ancestorIds, authorityChain, DepartmentHierarchyError, hasDepartmentAuthority, normalizeDepartmentName, sameDepartmentName, wouldCreateCycle, type Department,
} from "@/domain/departments";
import { ADMIN_MANAGED_DEPARTMENT_ID, CENTRAL_RD_DEPARTMENT_ID, pickSeedAdministrator, type SeedAuthUser, DEFAULT_EMPLOYEE_DEPARTMENT_ID, departmentSeedRows, LND_DEPARTMENT_ID, seedDepartments } from "@/data/departments";

const list: Department[] = [
  { id: "lnd", name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
  { id: "crd", name: "Central R&D", parentId: "lnd", managerUserId: null, managerEmployeeId: null },
  { id: "qa", name: "QA Lab", parentId: "crd", managerUserId: null, managerEmployeeId: null },
  { id: "ops", name: "Operations", parentId: null, managerUserId: null, managerEmployeeId: null },
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
    expect(ancestorIds([{ id: "a", parentId: "missing" }], "a")).toEqual(["missing"]);
  });

  it("throws instead of looping when the stored list already loops", () => {
    const looped: Department[] = [
      { id: "a", name: "A", parentId: "b", managerUserId: null, managerEmployeeId: null },
      { id: "b", name: "B", parentId: "c", managerUserId: null, managerEmployeeId: null },
      { id: "c", name: "C", parentId: "b", managerUserId: null, managerEmployeeId: null },
    ];
    expect(() => ancestorIds(looped, "a")).toThrow(DepartmentHierarchyError);
    expect(() => ancestorIds([{ id: "a", parentId: "a" }], "a")).toThrow(DepartmentHierarchyError);
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

describe("authorityChain", () => {
  const managed: Department[] = [
    { id: "lnd", name: "L&D", parentId: null, managerUserId: "u-lnd", managerEmployeeId: null },
    { id: "crd", name: "Central R&D", parentId: "lnd", managerUserId: null, managerEmployeeId: null },
    { id: "qa", name: "QA Lab", parentId: "crd", managerUserId: "u-qa", managerEmployeeId: "BS-1002" },
    { id: "qa-auto", name: "QA Automation", parentId: "qa", managerUserId: "u-lnd", managerEmployeeId: null },
    { id: "ops", name: "Operations", parentId: null, managerUserId: null, managerEmployeeId: null },
  ];

  it("lists the department's own manager, then each ancestor's, nearest first", () => {
    expect(authorityChain(managed, "qa")).toEqual(["u-qa", "u-lnd"]);
    expect(authorityChain(managed, "lnd")).toEqual(["u-lnd"]);
  });

  it("skips unmanaged departments, so Central R&D resolves to L&D's manager", () => {
    expect(authorityChain(managed, "crd")).toEqual(["u-lnd"]);
    expect(authorityChain(managed, "ops")).toEqual([]);
  });

  it("lists a manager once, at their nearest position", () => {
    expect(authorityChain(managed, "qa-auto")).toEqual(["u-lnd", "u-qa"]);
  });

  it("is empty for an unknown department", () => {
    expect(authorityChain(managed, "nope")).toEqual([]);
  });

  it("throws instead of looping when the stored list loops", () => {
    const looped: Department[] = [
      { id: "a", name: "A", parentId: "b", managerUserId: "u-a", managerEmployeeId: null },
      { id: "b", name: "B", parentId: "a", managerUserId: "u-b", managerEmployeeId: null },
    ];
    expect(() => authorityChain(looped, "a")).toThrow(DepartmentHierarchyError);
  });

  it("reflects the list it is given (computed fresh, never cached)", () => {
    const before = structuredClone(managed);
    expect(authorityChain(before, "crd")).toEqual(["u-lnd"]);
    before[1].managerUserId = "u-crd";
    expect(authorityChain(before, "crd")).toEqual(["u-crd", "u-lnd"]);
  });
});

describe("hasDepartmentAuthority", () => {
  const managed: Department[] = [
    { id: "lnd", name: "L&D", parentId: null, managerUserId: "u-lnd", managerEmployeeId: null },
    { id: "crd", name: "Central R&D", parentId: "lnd", managerUserId: null, managerEmployeeId: null },
    { id: "qa", name: "QA Lab", parentId: "crd", managerUserId: "u-qa", managerEmployeeId: "BS-1002" },
    { id: "ops", name: "Operations", parentId: null, managerUserId: null, managerEmployeeId: null },
  ];

  it("always holds for an Administrator, even with no manager anywhere in the chain", () => {
    expect(hasDepartmentAuthority({ role: "admin", userId: "u-admin" }, managed, "ops")).toBe(true);
    expect(hasDepartmentAuthority({ role: "admin", userId: "u-admin" }, managed, "nope")).toBe(true);
  });

  it("holds for the department's own manager and every ancestor's manager", () => {
    expect(hasDepartmentAuthority({ role: "manager", userId: "u-qa" }, managed, "qa")).toBe(true);
    expect(hasDepartmentAuthority({ role: "manager", userId: "u-lnd" }, managed, "qa")).toBe(true);
    expect(hasDepartmentAuthority({ role: "manager", userId: "u-lnd" }, managed, "crd")).toBe(true);
  });

  it("does not hold upwards, sideways or for staff outside the chain", () => {
    expect(hasDepartmentAuthority({ role: "manager", userId: "u-qa" }, managed, "crd")).toBe(false);
    expect(hasDepartmentAuthority({ role: "manager", userId: "u-qa" }, managed, "ops")).toBe(false);
    expect(hasDepartmentAuthority({ role: "staff", userId: "u-other" }, managed, "qa")).toBe(false);
  });

  it("never holds for a staff actor, even one whose user id is in the chain (a downgraded manager)", () => {
    expect(hasDepartmentAuthority({ role: "staff", userId: "u-qa" }, managed, "qa")).toBe(false);
    expect(hasDepartmentAuthority({ role: "staff", userId: "u-lnd" }, managed, "crd")).toBe(false);
  });

  it("throws on a looping list rather than guessing", () => {
    const looped: Department[] = [
      { id: "a", name: "A", parentId: "b", managerUserId: null, managerEmployeeId: null },
      { id: "b", name: "B", parentId: "a", managerUserId: null, managerEmployeeId: null },
    ];
    expect(() => hasDepartmentAuthority({ role: "manager", userId: "u" }, looped, "a")).toThrow(DepartmentHierarchyError);
  });
});

describe("seed departments", () => {
  it("is L&D at the top level and Central R&D under it, parents first", () => {
    expect(seedDepartments).toEqual([
      { id: LND_DEPARTMENT_ID, name: "L&D", parentId: null, managerUserId: null, managerEmployeeId: null },
      { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parentId: LND_DEPARTMENT_ID, managerUserId: null, managerEmployeeId: null },
    ]);
    expect(departmentSeedRows()).toEqual([
      { id: LND_DEPARTMENT_ID, name: "L&D", parent_department_id: null },
      { id: CENTRAL_RD_DEPARTMENT_ID, name: "Central R&D", parent_department_id: LND_DEPARTMENT_ID },
    ]);
  });

  it("leaves both without a manager in the rows (the seed sets L&D's separately)", () => {
    expect(ADMIN_MANAGED_DEPARTMENT_ID).toBe(LND_DEPARTMENT_ID);
    expect(departmentSeedRows().every(row => !("manager_user_id" in row))).toBe(true);
  });

  it("puts fixture employees in Central R&D, with valid UUIDs", () => {
    expect(DEFAULT_EMPLOYEE_DEPARTMENT_ID).toBe(CENTRAL_RD_DEPARTMENT_ID);
    for (const id of [LND_DEPARTMENT_ID, CENTRAL_RD_DEPARTMENT_ID]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe("pickSeedAdministrator (Story 4.2: L&D's seeded manager)", () => {
  const users: SeedAuthUser[] = [
    { id: "staff-old", email: "staff@example.test", created_at: "2026-01-01T00:00:00Z", app_metadata: { role: "staff", employee_id: "BS-1001" } },
    { id: "admin-new", email: "New.Admin@example.test", created_at: "2026-03-01T00:00:00Z", app_metadata: { role: "admin" } },
    { id: "admin-old", email: "old.admin@example.test", created_at: "2026-02-01T00:00:00Z", app_metadata: { role: "admin" } },
    { id: "no-role", email: "none@example.test", created_at: "2025-01-01T00:00:00Z", app_metadata: {} },
  ];

  it("picks the Administrator whose email matches, case-insensitively", () => {
    expect(pickSeedAdministrator(users, " new.admin@EXAMPLE.test ")?.id).toBe("admin-new");
  });

  it("never picks a non-admin named by the email: falls back to the earliest Administrator", () => {
    expect(pickSeedAdministrator(users, "staff@example.test")?.id).toBe("admin-old");
    expect(pickSeedAdministrator(users, "nobody@example.test")?.id).toBe("admin-old");
  });

  it("without an email, picks the earliest-created Administrator", () => {
    expect(pickSeedAdministrator(users)?.id).toBe("admin-old");
    expect(pickSeedAdministrator(users, "")?.id).toBe("admin-old");
  });

  it("is null when there is no Administrator", () => {
    expect(pickSeedAdministrator(users.filter(u => u.app_metadata?.role !== "admin"), "staff@example.test")).toBeNull();
    expect(pickSeedAdministrator([])).toBeNull();
  });
});
