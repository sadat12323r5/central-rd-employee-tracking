// Integration test against the shared Supabase project. Skipped unless the three Supabase env vars
// are present. Uses its own throwaway auth users, departments (names carrying this run's id) and
// employees (a per-run slot of BS-8200..BS-8247, a range no other test uses; the Story 7.4 e2e uses
// BS-8650..BS-8699), never the seeded demo data, and removes everything it created in afterAll through
// the service role.
// Rules under test (Story 7.4): public.rate_employee_skill and public.update_employee_evaluation let the
// Administrator assess anyone and a department manager the employees in their subtree. Re-rating a skill
// with a differently-cased name updates the same row (name kept). The evaluation's reviewer and date come
// from the session. Staff (even on their own record), a manager outside their subtree and a caller whose
// own row is archived get not_authorized; bad values get invalid_input; an unknown id employee_not_found.
// employee_skills and employee_evaluations have select-only RLS (Administrator, own, manages_employee):
// a direct insert is refused for everyone. assessments-store and employees-store agree.
// Fails with 42P01 / PGRST205 until the skills_and_evaluation migration is applied (and PGRST202 for the
// functions), and with the errors listed in employee-details-rls.test.ts until the Epic 4 migrations are.
import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInDhaka } from "@/domain/employee-input";
import { AssessmentForbiddenError, createAssessmentsStore } from "@/server/assessments-store";
import { createAssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import { createAssignmentsStore } from "@/server/assignments-store";
import { createBackfilledProjectStore } from "@/server/backfilled-project-store";
import { createEmployeesStore } from "@/server/employees-store";
import { createInterviewsStore } from "@/server/interviews-store";
import { createManagerScope } from "@/server/manager-scope";
import { createTrainingStore } from "@/server/training-store";
import { createStubLmsClient } from "@/server/lms-client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const run = randomBytes(4).toString("hex");
const password = `Rls-${randomBytes(12).toString("hex")}!`;
const PREFIX = `RLS Assess ${run}`;
// One per-run slot of six consecutive ids (BS-8200..BS-8247). Moved from BS-8600..BS-8647 at integration:
// earlier Story 4.8 transfer-rls runs left undeletable assignments on some BS-86xx ids in the shared project,
// which made this test's cleanup (delete the slot's employees) fail with 23503.
const base = randomInt(0, 8) * 6;
const idAt = (offset: number) => `BS-82${String(base + offset).padStart(2, "0")}`;
const managerId = idAt(0);         // manager of P (linked Staff account, no department)
const staffId = idAt(1);           // plain Staff in C, manages nothing
const childEmployee = idAt(2);     // in C (inside the P manager's subtree)
const unrelatedEmployee = idAt(3); // in U (outside it)
const archivedManagerId = idAt(4); // manager of C, own row archived
const missing = idAt(5);           // never inserted
const employeeIds = [managerId, staffId, childEmployee, unrelatedEmployee, archivedManagerId, missing];
const nameOf = (id: string) => `RLS Assess ${id}`;

const row = (employee_id: string, department_id: string | null, extra: Record<string, unknown> = {}) => ({
  employee_id, name: nameOf(employee_id), title: "Test", team: "Test", employment_type: "Permanent",
  email: `rls-assess-${employee_id.toLowerCase()}-${run}@example.com`, joined_on: "2026-10-01", manager: "Test", office: "Test",
  status: "Available", initials: "RA", avatar_color: "mint", summary: "", department_id, ...extra,
});

const skillArgs = (employeeId: string, extra: Record<string, unknown> = {}) => ({
  p_employee_id: employeeId, p_name: "React", p_level: 4, p_evidence: "Project review", ...extra,
});
const evaluationArgs = (employeeId: string, extra: Record<string, unknown> = {}) => ({
  p_employee_id: employeeId, p_strengths: "Clear reasoning", p_development_priorities: "Present more", p_readiness: "Ready", ...extra,
});

/** A table this migration adds may not exist yet (PGRST205 / 42P01): cleanup must still remove the employees. */
const missingTable = (code?: string) => code === "PGRST205" || code === "42P01";

describe.skipIf(!configured)("skills and evaluation (shared Supabase project)", () => {
  let service: SupabaseClient;
  const userIds: string[] = [];
  const adminEmail = `rls-assess-admin-${run}@example.com`;
  const managerEmail = `rls-assess-mgr-${run}@example.com`;
  const staffEmail = `rls-assess-staff-${run}@example.com`;
  const archivedEmail = `rls-assess-archived-${run}@example.com`;
  let adminUserId = "";
  let managerUserId = "";
  let staffUserId = "";

  async function createUser(address: string, app_metadata: Record<string, string>) {
    const { data, error } = await service.auth.admin.createUser({ email: address, password, email_confirm: true, app_metadata });
    if (error || !data.user) throw new Error(`Could not create test user: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  // One sign-in per test user per file (Supabase Auth rate-limits sign-ins per IP).
  const sessions = new Map<string, Promise<SupabaseClient>>();
  function signedIn(address: string): Promise<SupabaseClient> {
    let session = sessions.get(address);
    if (!session) {
      session = (async () => {
        const client = createClient(url!, anonKey!, noSession);
        const { error } = await client.auth.signInWithPassword({ email: address, password });
        if (error) throw new Error(`Could not sign in test user: ${error.message}`);
        return client;
      })();
      sessions.set(address, session);
    }
    return session;
  }

  async function cleanup() {
    for (const table of ["employee_skills", "employee_evaluations"]) {
      const removed = await service.from(table).delete().in("employee_id", employeeIds);
      if (removed.error && !missingTable(removed.error.code)) {
        throw new Error(`Could not delete test ${table} (${removed.error.code}): ${removed.error.message}`);
      }
    }
    const deleted = await service.from("employees").delete().in("employee_id", employeeIds);
    if (deleted.error) throw new Error(`Could not delete test employees (${deleted.error.code}): ${deleted.error.message}`);
    const detached = await service.from("departments").update({ parent_department_id: null }).like("name", `${PREFIX}%`);
    if (detached.error) throw new Error(`Could not detach test departments (${detached.error.code}): ${detached.error.message}`);
    const removed = await service.from("departments").delete().like("name", `${PREFIX}%`);
    if (removed.error) throw new Error(`Could not delete test departments (${removed.error.code}): ${removed.error.message}`);
  }

  async function insertDepartment(name: string, parent_department_id: string | null, manager_user_id: string | null): Promise<string> {
    const { data, error } = await service.from("departments").insert({ name, parent_department_id, manager_user_id }).select("id").single();
    if (error) throw new Error(`Could not insert test department (${error.code}): ${error.message}`);
    return data.id as string;
  }

  async function skillsOf(id: string) {
    const { data, error } = await service.from("employee_skills").select("name,level,evidence,updated_by").eq("employee_id", id).order("name");
    if (error) throw new Error(`Could not read test skills (${error.code}): ${error.message}`);
    return data;
  }

  async function evaluationOf(id: string) {
    const { data, error } = await service.from("employee_evaluations")
      .select("strengths,development_priorities,readiness,reviewer,reviewed_on,updated_by").eq("employee_id", id).maybeSingle();
    if (error) throw new Error(`Could not read test evaluation (${error.code}): ${error.message}`);
    return data;
  }

  async function seedRows() {
    // Through the service role, as the seed does: one skill and one evaluation per employee in the test.
    const skills = await service.from("employee_skills").insert(
      [staffId, childEmployee, unrelatedEmployee].map(id => ({ employee_id: id, name: `Seeded ${id}`, level: 3, evidence: "Seeded", updated_by: null })),
      { defaultToNull: false },
    );
    if (skills.error) throw new Error(`Could not insert test skills (${skills.error.code}): ${skills.error.message}`);
    const evaluations = await service.from("employee_evaluations").insert(
      [staffId, unrelatedEmployee].map(id => ({
        employee_id: id, strengths: "Seeded", development_priorities: "Seeded", readiness: "Seeded",
        reviewer: "Seed · L&D Manager", reviewed_on: "2026-09-14", updated_by: null,
      })),
      { defaultToNull: false },
    );
    if (evaluations.error) throw new Error(`Could not insert test evaluations (${evaluations.error.code}): ${evaluations.error.message}`);
  }

  beforeAll(async () => {
    service = createClient(url!, serviceKey!, noSession);
    await cleanup(); // leftovers from an aborted run in the same slot
    adminUserId = await createUser(adminEmail, { role: "admin" });
    managerUserId = await createUser(managerEmail, { role: "staff", employee_id: managerId });
    staffUserId = await createUser(staffEmail, { role: "staff", employee_id: staffId });
    const archivedUserId = await createUser(archivedEmail, { role: "staff", employee_id: archivedManagerId });
    const parentId = await insertDepartment(`${PREFIX} Parent`, null, managerUserId);
    const childId = await insertDepartment(`${PREFIX} Child`, parentId, archivedUserId);
    const unrelatedId = await insertDepartment(`${PREFIX} Unrelated`, null, null);
    const employees = await service.from("employees").insert([
      row(managerId, null, { auth_user_id: managerUserId }),
      row(staffId, childId, { auth_user_id: staffUserId }),
      row(childEmployee, childId),
      row(unrelatedEmployee, unrelatedId),
      row(archivedManagerId, null, { auth_user_id: archivedUserId, archived_at: "2026-10-01T00:00:00Z" }),
    ], { defaultToNull: false });
    if (employees.error) throw new Error(`Could not insert test employees (${employees.error.code}): ${employees.error.message}`);
    await seedRows();
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    try {
      await cleanup();
    } finally {
      for (const id of userIds) await service.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lets the Administrator rate a skill and re-rate it with another case, updating the same row", async () => {
    const admin = await signedIn(adminEmail);
    const first = await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "  React  ", p_evidence: "Project   review" }));
    expect(first.error).toBeNull();
    expect(first.data).toBe(nameOf(childEmployee));
    const again = await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "react", p_level: 5, p_evidence: "Led the rewrite" }));
    expect(again.error).toBeNull();
    const react = (await skillsOf(childEmployee)).filter(s => s.name.toLowerCase() === "react");
    expect(react).toEqual([{ name: "React", level: 5, evidence: "Led the rewrite", updated_by: adminUserId }]);
  });

  it("lets the Administrator save an evaluation, reviewer and date from the session", async () => {
    const admin = await signedIn(adminEmail);
    const { data, error } = await admin.rpc("update_employee_evaluation", evaluationArgs(childEmployee, { p_strengths: "  Clear   reasoning " }));
    expect(error).toBeNull();
    expect(data).toBe(nameOf(childEmployee));
    expect(await evaluationOf(childEmployee)).toEqual({
      strengths: "Clear reasoning", development_priorities: "Present more", readiness: "Ready",
      // This Administrator account has no linked employee.
      reviewer: "Administrator", reviewed_on: todayInDhaka(), updated_by: adminUserId,
    });
  });

  it("lets the P manager rate a skill and save the evaluation of an employee in C, as Department manager", async () => {
    const manager = await signedIn(managerEmail);
    expect((await manager.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "Go", p_level: 2, p_evidence: "Pairing" }))).error).toBeNull();
    expect((await skillsOf(childEmployee)).find(s => s.name === "Go")).toEqual({ name: "Go", level: 2, evidence: "Pairing", updated_by: managerUserId });
    expect((await manager.rpc("update_employee_evaluation", evaluationArgs(childEmployee, { p_readiness: "Ready soon" }))).error).toBeNull();
    expect(await evaluationOf(childEmployee)).toMatchObject({
      readiness: "Ready soon", reviewer: `${nameOf(managerId)} · Department manager`, updated_by: managerUserId,
    });
  });

  it("refuses the P manager an employee outside the subtree (and an unknown id), changing nothing", async () => {
    const before = [await skillsOf(unrelatedEmployee), await evaluationOf(unrelatedEmployee)];
    const manager = await signedIn(managerEmail);
    expect((await manager.rpc("rate_employee_skill", skillArgs(unrelatedEmployee))).error?.message).toBe("not_authorized");
    expect((await manager.rpc("update_employee_evaluation", evaluationArgs(unrelatedEmployee))).error?.message).toBe("not_authorized");
    expect((await manager.rpc("rate_employee_skill", skillArgs(missing))).error?.message).toBe("not_authorized");
    expect([await skillsOf(unrelatedEmployee), await evaluationOf(unrelatedEmployee)]).toEqual(before);
  });

  it("refuses plain Staff, even on their own record, and any direct table write", async () => {
    const before = [await skillsOf(staffId), await evaluationOf(staffId)];
    const staff = await signedIn(staffEmail);
    expect((await staff.rpc("rate_employee_skill", skillArgs(staffId))).error?.message).toBe("not_authorized");
    expect((await staff.rpc("update_employee_evaluation", evaluationArgs(staffId))).error?.message).toBe("not_authorized");
    const skill = await staff.from("employee_skills").insert({ employee_id: staffId, name: "Forged", level: 5, evidence: "Forged" });
    expect(skill.error?.code).toBe("42501");
    const evaluation = await staff.from("employee_evaluations").insert({
      employee_id: childEmployee, strengths: "Forged", development_priorities: "Forged", readiness: "Forged", reviewer: "Forged", reviewed_on: "2026-10-01",
    });
    expect(evaluation.error?.code).toBe("42501");
    const updated = await staff.from("employee_skills").update({ level: 5 }).eq("employee_id", staffId).select("id");
    expect(updated.data ?? []).toHaveLength(0);
    expect([await skillsOf(staffId), await evaluationOf(staffId)]).toEqual(before);
  });

  it("refuses a direct insert through a manager or admin JWT too (writes go only through the functions)", async () => {
    for (const address of [managerEmail, adminEmail]) {
      const client = await signedIn(address);
      const skill = await client.from("employee_skills").insert({ employee_id: childEmployee, name: `Direct ${address}`, level: 3, evidence: "Direct" });
      expect(skill.error?.code).toBe("42501");
    }
  });

  it("refuses a manager whose own employee row is archived", async () => {
    const archived = await signedIn(archivedEmail);
    expect((await archived.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "Archived" }))).error?.message).toBe("not_authorized");
    expect((await archived.rpc("update_employee_evaluation", evaluationArgs(childEmployee))).error?.message).toBe("not_authorized");
    expect((await skillsOf(childEmployee)).some(s => s.name === "Archived")).toBe(false);
  });

  it("refuses invalid values and reports an unknown employee to the Administrator", async () => {
    const admin = await signedIn(adminEmail);
    expect((await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "Six", p_level: 6 }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "Zero", p_level: 0 }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "Blank", p_evidence: "   " }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("rate_employee_skill", skillArgs(childEmployee, { p_name: "x".repeat(81) }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("update_employee_evaluation", evaluationArgs(childEmployee, { p_readiness: "" }))).error?.message).toBe("invalid_input");
    expect((await admin.rpc("rate_employee_skill", skillArgs(missing))).error?.message).toBe("employee_not_found");
    expect((await admin.rpc("update_employee_evaluation", evaluationArgs(missing))).error?.message).toBe("employee_not_found");
    expect((await skillsOf(childEmployee)).map(s => s.name)).not.toContain("Six");
  });

  it("scopes reads: Staff see only their own rows, the manager the subtree, the Administrator everything", async () => {
    const ids = [staffId, childEmployee, unrelatedEmployee];
    const read = async (client: SupabaseClient) => {
      const skills = await client.from("employee_skills").select("employee_id").in("employee_id", ids);
      const evaluations = await client.from("employee_evaluations").select("employee_id").in("employee_id", ids);
      expect(skills.error).toBeNull();
      expect(evaluations.error).toBeNull();
      return {
        skills: [...new Set((skills.data ?? []).map(r => r.employee_id as string))].sort(),
        evaluations: (evaluations.data ?? []).map(r => r.employee_id as string).sort(),
      };
    };
    expect(await read(await signedIn(staffEmail))).toEqual({ skills: [staffId], evaluations: [staffId] });
    const manager = await read(await signedIn(managerEmail));
    expect(manager.skills).toEqual([staffId, childEmployee].sort());
    expect(manager.skills).not.toContain(unrelatedEmployee);
    expect(manager.evaluations).not.toContain(unrelatedEmployee);
    const admin = await read(await signedIn(adminEmail));
    expect(admin.skills).toEqual([...ids].sort());
    expect(admin.evaluations).toContain(unrelatedEmployee);
  });

  it("refuses anon", async () => {
    const anon = createClient(url!, anonKey!, noSession);
    expect((await anon.rpc("rate_employee_skill", skillArgs(childEmployee))).error?.code).toBe("42501");
    expect((await anon.rpc("update_employee_evaluation", evaluationArgs(childEmployee))).error?.code).toBe("42501");
    const skills = await anon.from("employee_skills").select("id").in("employee_id", employeeIds);
    expect(skills.data ?? []).toHaveLength(0);
  });

  it("agrees at the stores: the manager rates within the subtree, is refused outside it, and sees it on the profile", async () => {
    const client = await signedIn(managerEmail);
    const userClient = async () => client;
    const scope = createManagerScope({ userClient });
    const assessments = createAssessmentsStore({ userClient, scope });
    const manager = { role: "manager", employeeId: managerId, userId: managerUserId } as const;
    expect(await assessments.rateSkill(manager, childEmployee, { name: "Store  Skill", level: 3, evidence: "Store evidence" }))
      .toEqual({ employeeId: childEmployee, name: nameOf(childEmployee) });
    await expect(assessments.rateSkill(manager, unrelatedEmployee, { name: "Nope", level: 3, evidence: "Nope" })).rejects.toBeInstanceOf(AssessmentForbiddenError);
    const employees = createEmployeesStore({
      userClient, interviews: createInterviewsStore({ userClient }),
      training: createTrainingStore({ userClient, lms: createStubLmsClient({ userClient }), scope }), assessments, scope,
      // Epic 4 merge: the store also reads assignments (4.5), their evaluations (4.6) and backfilled projects (4.7).
      assignments: createAssignmentsStore({ userClient, scope }), evaluations: createAssignmentEvaluationsStore({ userClient, scope }),
      backfilled: createBackfilledProjectStore({ userClient, scope }),
    });
    const profile = await employees.getFor(manager, childEmployee);
    expect(profile?.skills.map(s => s.name)).toContain("Store Skill");
    // Strongest first.
    expect(profile?.skills.map(s => s.level)).toEqual([...(profile?.skills ?? []).map(s => s.level)].sort((a, b) => b - a));
    expect(profile?.review.reviewer).toBe(`${nameOf(managerId)} · Department manager`);
  });
});
