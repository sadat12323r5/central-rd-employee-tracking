import { describe, expect, it } from "vitest";
import { CENTRAL_RD_DEPARTMENT_ID } from "@/data/departments";
import {
  allocateBlock, cohortLabel, CohortError, DEFAULT_RANGE, labelledRun, provisionCohort, retireCohorts,
} from "../sim/cohort";
import { PERSONAS } from "../sim/personas";
import { fakeProvisionDeps, fakeRetireDeps } from "./support/sim-fakes";

describe("cohort block allocation (Story 9.1)", () => {
  it("takes block 00 when the range is unused", () => {
    expect(allocateBlock([])).toMatchObject({ block: 0, nn: "00", ids: ["BS-2000", "BS-2001", "BS-2002", "BS-2003", "BS-2004", "BS-2005", "BS-2006", "BS-2007", "BS-2008", "BS-2009"] });
  });

  it("takes the block after the highest block in use, ignoring ids outside the range", () => {
    const block = allocateBlock(["BS-2003", "BS-2017", "BS-1001", "BS-3999", "BS-7005"]);
    expect(block.nn).toBe("02");
    expect(block.ids[0]).toBe("BS-2020");
    expect(block.ids.at(-1)).toBe("BS-2029");
  });

  it("refuses when the range is full", () => {
    expect(() => allocateBlock(["BS-2995"])).toThrow(CohortError);
    expect(() => allocateBlock(["BS-7091"], { first: 7000, last: 7099 })).toThrow(/full/);
    expect(allocateBlock(["BS-7005"], { first: 7000, last: 7099 }).ids[0]).toBe("BS-7010");
  });
});

describe("provisionCohort (Story 9.1)", () => {
  it("provisions in order through the app's paths, with labelled employees under Central R&D", async () => {
    const { deps, calls } = fakeProvisionDeps({ used: ["BS-2003", "BS-2017"] });
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    expect(cohort.run).toBe("c02ab12");
    expect(cohort.departmentName).toBe("Simulation Cohort c02ab12");

    const kinds = calls.map(c => c.kind);
    // 1. admin account, 2. admin sign-in, 3. department, 4. employee + account per person, 5. setManager, 6. sign-ins.
    expect(kinds.slice(0, 3)).toEqual(["account", "signIn", "department"]);
    expect(kinds.slice(3, 21)).toEqual(Array.from({ length: 9 }, () => ["employee", "account"]).flat());
    expect(kinds[21]).toBe("setManager");
    expect(kinds.slice(22)).toEqual(Array(9).fill("signIn"));

    expect(calls[0]).toMatchObject({ kind: "account", role: "admin", email: "sim-c02ab12-admin@example.com" });
    expect(calls[2]).toMatchObject({ kind: "department", session: { role: "admin" }, name: "Simulation Cohort c02ab12", parentId: CENTRAL_RD_DEPARTMENT_ID });

    const employees = calls.filter(c => c.kind === "employee");
    expect(employees.map(e => e.input.employeeId)).toEqual(["BS-2020", "BS-2021", "BS-2022", "BS-2023", "BS-2024", "BS-2025", "BS-2026", "BS-2027", "BS-2028"]);
    for (const e of employees) {
      expect(e.by).toBe("sim-c02ab12-admin@example.com");
      expect(e.session).toEqual({ role: "admin" });
      expect(e.input.departmentId).toBe("dddd0000-0000-4000-8000-000000000001");
      expect(e.input.email).toMatch(/^sim-c02ab12-[a-z0-9]+@example\.com$/);
      expect(e.options?.summary?.startsWith(cohortLabel("c02ab12"))).toBe(true);
      expect(e.options!.summary!.length).toBeLessThanOrEqual(500);
    }
    // The manager is employee 0 of the block and becomes the department's manager.
    expect(employees[0].input.name).toBe(PERSONAS.find(p => p.role === "manager")!.name);
    expect(calls[21]).toMatchObject({ kind: "setManager", employeeId: "BS-2020", by: "sim-c02ab12-admin@example.com" });

    // Each persona signs in exactly once.
    const signIns = calls.filter(c => c.kind === "signIn").map(c => c.email);
    expect(signIns).toHaveLength(10);
    expect(new Set(signIns).size).toBe(10);

    expect(cohort.members.map(m => m.persona.key)).toEqual(PERSONAS.map(p => p.key));
    expect(cohort.members[0]).toMatchObject({ employeeId: null, session: { role: "admin" }, attendance: null });
    expect(cohort.members[1].session).toMatchObject({ role: "manager", employeeId: "BS-2020" });
    expect(cohort.members[2].session).toEqual({ role: "staff", employeeId: "BS-2021" });
  });

  it("uses a random password per account (12-72 characters) and never returns one", async () => {
    const { deps, calls } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    const passwords = calls.flatMap(c => (c.kind === "account" ? [c.password] : []));
    expect(passwords).toHaveLength(10);
    expect(new Set(passwords).size).toBe(10);
    expect(passwords.every(p => p.length >= 12 && p.length <= 72)).toBe(true);
    const serialised = JSON.stringify(cohort, (_k, v) => (typeof v === "function" ? undefined : v));
    for (const password of passwords) expect(serialised).not.toContain(password);
  });

  it("names the run and the failed step when a step fails after allocation, keeping the cause", async () => {
    const { deps } = fakeProvisionDeps();
    const cause = new Error("Choose an existing department.");
    const failing = {
      ...deps,
      async signIn(email: string, password: string) {
        const signedIn = await deps.signIn(email, password);
        return { ...signedIn, stores: { ...signedIn.stores, departments: { ...signedIn.stores.departments, create: async () => { throw cause; } } } };
      },
    };
    const error = await provisionCohort(failing, { personas: PERSONAS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CohortError);
    expect((error as Error).message).toBe("Cohort c00ab12 is partly provisioned: the department failed: Choose an existing department. Nothing was rolled back.");
    expect((error as Error).cause).toBe(cause);
  });

  it("provisions nothing when the range is full", async () => {
    const { deps, calls } = fakeProvisionDeps({ used: ["BS-2990"] });
    await expect(provisionCohort(deps, { personas: PERSONAS })).rejects.toThrow(/full/);
    expect(calls).toEqual([]);
  });

  it("refuses a persona list without exactly one admin and one manager", async () => {
    const { deps, calls } = fakeProvisionDeps();
    await expect(provisionCohort(deps, { personas: PERSONAS.filter(p => p.role !== "manager") })).rejects.toBeInstanceOf(CohortError);
    expect(calls).toEqual([]);
  });
});

describe("retireCohorts (Story 9.1)", () => {
  const users = [
    { id: "aaaa0000-0000-4000-8000-000000000000", email: "sim-c00aaaa-admin@example.com" },
    { id: "aaaa0000-0000-4000-8000-000000000001", email: "sim-c01bbbb-admin@example.com" },
  ];
  const employees = [
    { employeeId: "BS-2000", summary: `${cohortLabel("c00aaaa")} Trainee.`, archived: false },
    { employeeId: "BS-2001", summary: `${cohortLabel("c00aaaa")} Senior.`, archived: false },
    { employeeId: "BS-2002", summary: `${cohortLabel("c00aaaa")} Already gone.`, archived: true },
    { employeeId: "BS-2010", summary: `${cohortLabel("c01bbbb")} Manager.`, archived: false },
    { employeeId: "BS-2011", summary: `${cohortLabel("c01bbbb")} Staff.`, archived: false },
    // In the range but without the label: never touched.
    { employeeId: "BS-2015", summary: "A real person in the range.", archived: false },
    { employeeId: "BS-2016", summary: "", archived: false },
    { employeeId: "BS-2017", summary: null, archived: false },
    // Labelled but outside the range (the fake ignores the range filter): never touched.
    { employeeId: "BS-1001", summary: `${cohortLabel("c00aaaa")} Forged.`, archived: false },
  ];

  it("archives earlier cohorts with their own Administrator as actor, keeping the newest", async () => {
    const { deps, archived } = fakeRetireDeps(employees, users);
    const result = await retireCohorts(deps, { range: DEFAULT_RANGE });
    expect(archived).toEqual([
      { employeeId: "BS-2000", actorId: users[0].id },
      { employeeId: "BS-2001", actorId: users[0].id },
    ]);
    expect(result.kept).toEqual(["c01bbbb"]);
  });

  it("archives every cohort with --all, still leaving unlabelled employees alone", async () => {
    const { deps, archived } = fakeRetireDeps(employees, users);
    await retireCohorts(deps, { all: true });
    expect(archived.map(a => a.employeeId)).toEqual(["BS-2000", "BS-2001", "BS-2010", "BS-2011"]);
    expect(archived.slice(2).every(a => a.actorId === users[1].id)).toBe(true);
  });

  it("skips a cohort whose Administrator is not found, with a warning", async () => {
    const { deps, archived, warnings } = fakeRetireDeps(employees, [users[1]]);
    const result = await retireCohorts(deps, { all: true });
    expect(archived.map(a => a.employeeId)).toEqual(["BS-2010", "BS-2011"]);
    expect(result.skipped.map(s => s.run)).toEqual(["c00aaaa"]);
    expect(warnings[0]).toMatch(/c00aaaa.*not found/);
  });

  it("records a refused archive as failed with its reason and a warning, archiving the cohort's others", async () => {
    const { deps, archived, warnings } = fakeRetireDeps(employees, users, ["BS-2000"]);
    const result = await retireCohorts(deps, { all: true });
    expect(result.failed).toEqual([{ run: "c00aaaa", employeeId: "BS-2000", reason: "The employee BS-2000 could not be archived." }]);
    expect(warnings).toEqual(["Could not archive BS-2000 (cohort c00aaaa): The employee BS-2000 could not be archived."]);
    expect(archived.map(a => a.employeeId)).toEqual(["BS-2001", "BS-2010", "BS-2011"]);
  });

  it("does nothing when only the newest cohort exists", async () => {
    const { deps, archived } = fakeRetireDeps(employees.filter(e => e.employeeId.startsWith("BS-201")), users);
    expect((await retireCohorts(deps)).kept).toEqual(["c01bbbb"]);
    expect(archived).toEqual([]);
  });

  it("reads the cohort run only from a summary that starts with the label", () => {
    expect(labelledRun("Simulation cohort c03beef. Hi")).toBe("c03beef");
    expect(labelledRun("Note: Simulation cohort c03beef.")).toBeNull();
    expect(labelledRun("Simulation cohort c3beef.")).toBeNull();
    expect(labelledRun(null)).toBeNull();
  });
});
