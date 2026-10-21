// Story 9.1: the simulator against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own id range BS-7000..BS-7099 (never BS-2xxx, the real cohort range), a cohort of the
// Administrator, the manager and 2 staff personas, and 2 simulated days. It provisions through the real deps
// (accounts-store on the service role; departments-, employees- and attendance-store under each persona's
// own sign-in, once each), runs the dry-run driver, then retires with --all semantics.
// Attendance RLS (attendance_insert_own) only accepts today's Dhaka work_date, so the dry run's past-dated
// clock-ins are refused (recorded as refusals); the injected clock is proven live with an instant from today.
//
// Teardown (service role, test-only): deletes the range's attendance rows and employees, the cohort
// departments and the cohort's auth users, so the next run starts again at block 00.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CENTRAL_RD_DEPARTMENT_ID } from "@/data/departments";
import { dhakaDate } from "@/domain/timesheet";
import { calendarFromActive, type SimCalendar } from "../sim/calendar";
import { cohortDepartmentName, cohortLabel, labelledRun, provisionCohort, retireCohorts, type Cohort } from "../sim/cohort";
import { createDryRunDriver } from "../sim/dry-run-driver";
import { createSimDeps, type SimDeps } from "../sim/env";
import { PERSONAS } from "../sim/personas";
import { runSimulation } from "../sim/runner";
import { createTimeline } from "../sim/timeline";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const RANGE = { first: 7000, last: 7099 };
const personas = [
  ...PERSONAS.filter(p => p.role !== "staff"),
  ...PERSONAS.filter(p => p.role === "staff").slice(0, 2),
];

describe.skipIf(!configured)("simulation foundations (shared Supabase project)", () => {
  let service: SupabaseClient;
  let deps: SimDeps;
  let calendar: SimCalendar;
  let cohort: Cohort | undefined;
  const outDir = mkdtempSync(join(tmpdir(), "sim-live-"));
  const runs = new Set<string>();

  /** Deletes everything in the test range (test-only teardown, service role). */
  async function purge() {
    const rows = await service.from("employees").select("employee_id,summary,department_id").gte("employee_id", "BS-7000").lte("employee_id", "BS-7099");
    if (rows.error) throw new Error(`Could not read the test range (${rows.error.code}): ${rows.error.message}`);
    const ids = (rows.data ?? []).map(r => r.employee_id as string);
    for (const r of rows.data ?? []) {
      const run = labelledRun(r.summary as string | null);
      if (run) runs.add(run);
    }
    if (ids.length > 0) {
      const attendance = await service.from("attendance_entries").delete().in("employee_id", ids);
      if (attendance.error) throw new Error(`Could not delete test attendance (${attendance.error.code}): ${attendance.error.message}`);
      const employees = await service.from("employees").delete().in("employee_id", ids);
      if (employees.error) throw new Error(`Could not delete test employees (${employees.error.code}): ${employees.error.message}`);
    }
    for (const run of runs) {
      const department = await service.from("departments").delete().eq("name", cohortDepartmentName(run));
      if (department.error) throw new Error(`Could not delete the test department (${department.error.code}): ${department.error.message}`);
    }
    if (runs.size > 0) {
      const prefixes = [...runs].map(run => `sim-${run}-`);
      for (const user of await deps.listUsers()) {
        if (prefixes.some(p => (user.email ?? "").startsWith(p))) await service.auth.admin.deleteUser(user.id);
      }
    }
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    deps = createSimDeps({ url: url!, anonKey: anonKey!, serviceKey: serviceKey! });
    await purge(); // leftovers of an aborted run
    calendar = calendarFromActive(await deps.activeCalendar());
  });

  afterAll(async () => {
    if (cohort) runs.add(cohort.run);
    try {
      if (service) await purge();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("provisions a labelled cohort under Central R&D, steps the simulated days and stores the injected clock-in instant", async () => {
    cohort = await provisionCohort(deps, { range: RANGE, personas });
    runs.add(cohort.run);
    expect(cohort.run).toMatch(/^c00[0-9a-f]{4}$/);
    expect(cohort.ids[0]).toBe("BS-7000");

    const department = await service.from("departments").select("id,name,parent_department_id,manager_user_id").eq("id", cohort.departmentId).single();
    expect(department.error).toBeNull();
    expect(department.data).toMatchObject({ name: `Simulation Cohort ${cohort.run}`, parent_department_id: CENTRAL_RD_DEPARTMENT_ID });
    const manager = cohort.members.find(m => m.persona.role === "manager")!;
    expect(department.data!.manager_user_id).toBe(manager.userId);

    const employees = await service.from("employees").select("employee_id,summary,department_id,email,auth_user_id")
      .in("employee_id", cohort.ids.slice(0, 3)).order("employee_id");
    expect(employees.error).toBeNull();
    expect(employees.data).toHaveLength(3);
    for (const row of employees.data!) {
      expect(row.summary.startsWith(cohortLabel(cohort.run))).toBe(true);
      expect(row.department_id).toBe(cohort.departmentId);
      expect(row.email).toMatch(new RegExp(`^sim-${cohort.run}-[a-z0-9]+@example\\.com$`));
      expect(row.auth_user_id).not.toBeNull();
    }

    const timeline = createTimeline(join(outDir, cohort.run));
    const result = await runSimulation({ cohort, driver: createDryRunDriver(), calendar, timeline, maxDays: 2 });
    const days = calendar.workingDays.slice(0, 2);
    expect(result.days).toEqual(days);
    const staff = cohort.members.filter(m => m.persona.role === "staff");

    // The attendance RLS policies only accept today's Dhaka work_date, so every clock-in on a past simulated
    // date is refused by the app (a finding, recorded as a refusal carrying the app's message and the 42501
    // cause) and nothing is written; the run carries on to its end event.
    const refusals = timeline.events().filter(e => e.kind === "refusal");
    const clockIns = refusals.filter(e => e.detail?.command === "clockIn");
    expect(clockIns).toHaveLength(staff.length * days.length);
    for (const refusal of clockIns) {
      expect(refusal.text).toBe("Attendance records are temporarily unavailable.");
      expect(String(refusal.detail?.cause)).toMatch(/^42501 /);
    }
    expect(timeline.events().at(-1)!.kind).toBe("end");
    const none = await service.from("attendance_entries").select("id").in("employee_id", staff.map(m => m.employeeId!));
    expect(none.error).toBeNull();
    expect(none.data).toEqual([]);

    // A simulated instant on today's Dhaka date is accepted, and the entry carries that instant, not the server's time.
    let instant = new Date(Date.now() - 5 * 60_000);
    if (dhakaDate(instant) !== dhakaDate(new Date())) instant = new Date();
    instant.setUTCMilliseconds(0);
    const [first] = staff;
    expect(await first.attendance!.clockIn(first.employeeId!, { workMode: "Remote" }, instant)).toBe("Clocked in.");
    const saved = await service.from("attendance_entries").select("work_date,clock_in,work_mode").eq("employee_id", first.employeeId!).single();
    expect(saved.error).toBeNull();
    expect(saved.data!.work_date).toBe(dhakaDate(instant));
    expect(new Date(saved.data!.clock_in).toISOString()).toBe(instant.toISOString());
    const lines = readFileSync(join(outDir, cohort.run, "timeline.jsonl"), "utf8").trim().split("\n");
    expect(readFileSync(join(outDir, cohort.run, "timeline.md"), "utf8").trim().split("\n")).toHaveLength(lines.length);
  });

  it("retires the cohort through accounts-store archive, leaving an unlabelled range employee untouched", async () => {
    expect(cohort).toBeDefined();
    const c = cohort!;
    const unlabelled = c.ids[9];
    const inserted = await service.from("employees").insert({
      employee_id: unlabelled, name: "Unlabelled Range Employee", title: "Test", team: "Test", employment_type: "Permanent",
      email: `sim-live-unlabelled-${c.run}@example.com`, joined_on: "2026-01-01", manager: "Test", office: "Test",
      status: "Available", initials: "UR", avatar_color: "mint", summary: "Not a cohort member.", department_id: null,
    });
    expect(inserted.error).toBeNull();

    const result = await retireCohorts(deps, { range: RANGE, all: true });
    const people = c.members.filter(m => m.employeeId).map(m => m.employeeId!).sort();
    expect(result.archived.map(a => a.employeeId).sort()).toEqual(people);
    expect(result.skipped).toEqual([]);

    const rows = await service.from("employees").select("employee_id,archived_at").in("employee_id", [...people, unlabelled]);
    expect(rows.error).toBeNull();
    for (const row of rows.data!) {
      if (row.employee_id === unlabelled) expect(row.archived_at).toBeNull();
      else expect(row.archived_at).not.toBeNull();
    }
    const admin = c.members.find(m => m.persona.role === "admin")!;
    const audit = await service.from("audit_events").select("actor,target,action").in("target", people).eq("action", "archive").eq("actor", admin.userId);
    expect(audit.error).toBeNull();
    expect(audit.data!.map(a => a.target).sort()).toEqual(people);
  });
});
