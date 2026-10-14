import { describe, expect, it } from "vitest";
import {
  AVATAR_COLORS, avatarColorFor, derivedFields, initialsFor, invalidNewEmployeeFields, normalizeEmail, normalizeNewEmployee, normalizeText,
  todayInDhaka, type NewEmployeeInput,
} from "@/domain/employee-input";

const valid: NewEmployeeInput = {
  employeeId: "BS-1234", name: "Nadia Rahman", title: "Software Engineer", team: "Platform", email: "nadia@example.com",
  departmentId: "de9a0000-0000-4000-8000-000000000001", manager: "Arif Khan", office: "Dhaka HQ", employmentType: "Permanent",
  joinedOn: "2026-10-01",
};

describe("normalizeText and normalizeEmail", () => {
  it("trims and collapses inner whitespace", () => {
    expect(normalizeText("  Nadia \t  Rahman \n")).toBe("Nadia Rahman");
  });

  it("trims and lower-cases an email", () => {
    expect(normalizeEmail("  Nadia.Rahman@Example.COM ")).toBe("nadia.rahman@example.com");
  });
});

describe("initialsFor", () => {
  it.each([
    ["Nadia Rahman", "NR"],
    ["nadia binte rahman", "NR"],
    ["  Meera   Das  ", "MD"],
    ["Plato", "P"],
    ["", ""],
  ])("%j → %j", (name, initials) => {
    expect(initialsFor(name)).toBe(initials);
  });
});

describe("avatarColorFor", () => {
  it("is deterministic and one of the known colours", () => {
    for (const id of ["BS-0000", "BS-1001", "BS-1234", "BS-9999"]) {
      expect(AVATAR_COLORS).toContain(avatarColorFor(id));
      expect(avatarColorFor(id)).toBe(avatarColorFor(id));
    }
  });

  it("is chosen from the digits", () => {
    expect(avatarColorFor("BS-0000")).toBe("lavender");
    expect(avatarColorFor("BS-0001")).toBe("mint");
    expect(avatarColorFor("BS-0005")).toBe("yellow");
    expect(avatarColorFor("BS-0006")).toBe("lavender");
    expect(new Set(["BS-1000", "BS-1001", "BS-1002", "BS-1003", "BS-1004", "BS-1005"].map(avatarColorFor)).size).toBe(6);
  });
});

describe("todayInDhaka", () => {
  it("uses the Asia/Dhaka calendar date (UTC+6)", () => {
    expect(todayInDhaka(new Date("2026-10-14T17:59:00Z"))).toBe("2026-10-14");
    expect(todayInDhaka(new Date("2026-10-14T18:00:00Z"))).toBe("2026-10-15");
    expect(todayInDhaka(new Date("2026-12-31T19:00:00Z"))).toBe("2027-01-01");
  });
});

describe("normalizeNewEmployee", () => {
  it("normalises every field", () => {
    expect(normalizeNewEmployee({
      ...valid, employeeId: " BS-1234 ", name: "  Nadia   Rahman ", email: " Nadia@Example.com ", office: " Dhaka  HQ ",
      employmentType: " Permanent ",
    })).toEqual({ ...valid, name: "Nadia Rahman", email: "nadia@example.com", office: "Dhaka HQ" });
  });

  it("defaults a missing or blank join date to today in Asia/Dhaka", () => {
    const now = new Date("2026-10-14T20:00:00Z");
    expect(normalizeNewEmployee({ ...valid, joinedOn: undefined }, now).joinedOn).toBe("2026-10-15");
    expect(normalizeNewEmployee({ ...valid, joinedOn: null }, now).joinedOn).toBe("2026-10-15");
    expect(normalizeNewEmployee({ ...valid, joinedOn: "  " }, now).joinedOn).toBe("2026-10-15");
  });
});

describe("invalidNewEmployeeFields", () => {
  const check = (changes: Partial<NewEmployeeInput>) => invalidNewEmployeeFields(normalizeNewEmployee({ ...valid, ...changes }));

  it("accepts a valid employee", () => {
    expect(check({})).toEqual([]);
    expect(check({ employmentType: "Trainee" })).toEqual([]);
    expect(check({ employmentType: "Intern", name: "x".repeat(120) })).toEqual([]);
  });

  it.each([
    [{ employeeId: "BS-123" }, "employeeId"],
    [{ employeeId: "bs-1234" }, "employeeId"],
    [{ employeeId: "BS-12345" }, "employeeId"],
    [{ name: "   " }, "name"],
    [{ title: "x".repeat(121) }, "title"],
    [{ team: "" }, "team"],
    [{ email: "not-an-email" }, "email"],
    [{ email: `${"a".repeat(250)}@example.com` }, "email"],
    [{ departmentId: " " }, "departmentId"],
    [{ manager: "" }, "manager"],
    [{ office: "" }, "office"],
    [{ employmentType: "Contract" }, "employmentType"],
    [{ employmentType: "permanent" }, "employmentType"],
    [{ joinedOn: "2026-02-30" }, "joinedOn"],
    [{ joinedOn: "14/10/2026" }, "joinedOn"],
  ] as [Partial<NewEmployeeInput>, string][])("rejects %j as %s", (changes, field) => {
    expect(check(changes)).toEqual([field]);
  });

  it("lists every offending field in form order", () => {
    expect(check({ employeeId: "x", email: "x", departmentId: "" })).toEqual(["employeeId", "email", "departmentId"]);
  });
});

describe("derivedFields", () => {
  it("derives status, initials, colour and an empty summary", () => {
    expect(derivedFields({ employeeId: "BS-0001", name: "Nadia Rahman" })).toEqual({
      status: "Available", initials: "NR", avatarColor: "mint", summary: "",
    });
  });
});
