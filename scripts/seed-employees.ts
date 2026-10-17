// Idempotent seed: upserts the fixture's basic employee fields into the Supabase `employees` table,
// then the fixture's external interviews into `external_interviews` (Story 2.1) and its completed
// training into `training_history` (Story 3.1), with the service-role client. Interview and training
// ids are the fixture's deterministic ids (interviewSeedId, trainingSeedId), so re-running never adds
// copies. In-progress training is never copied into `training_history`: it is inserted into the LMS
// stub table `lms_stub_enrolments` (Story 3.2, ids from lmsStubSeedId), which the LMS adapter stub
// reads. Departments (Story 4.1) are inserted before the employees are touched (L&D, then Central R&D
// under it, fixed ids, insert-only); afterwards every fixture employee whose department_id is still
// null is placed in Central R&D. Story 4.2: right after the departments, L&D's manager is set to the
// Administrator account (pickSeedAdministrator: the Administrator whose email is SEED_ADMIN_EMAIL, else
// the earliest-created Administrator; never a non-admin) only while
// L&D has no manager; with no Administrator yet it warns to run `npm run db:seed-admin` first and
// continues. Central R&D gets no manager. Story 4.5: after the department placement, each fixture
// employee's former "current work" becomes one open assignment (assignmentSeedRows: fixed id from
// assignmentSeedId, client "Not recorded", start date from the work period, else the join date; the
// database copies the employee's department), insert-only, skipping employees who already have an open
// assignment (a manager's own, or the seeded one); a seeded row that was closed is never re-inserted.
// The fixture's Git commit counts are not migrated. Story 7.4: after training, the fixture's skills go
// into `employee_skills` (insert-only: a skill whose (employee, lower-cased name) already exists is
// skipped, so a manager's later rating survives) and its evaluations into `employee_evaluations`
// (insert-only, one per employee), both with updated_by null. Other nested profile data stays in the
// fixture (read by employees-store); the fixture's interviews, training, current work, skills and
// evaluations are never read at runtime.
// Run with `npm run db:seed`. Credentials come from the environment or .env.local and are never printed.
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type {
  assignmentSeedRows as AssignmentSeedRows, Employee, evaluationSeedRows as EvaluationSeedRows,
  interviewSeedRows as InterviewSeedRows, lmsStubSeedRows as LmsStubSeedRows,
  missingSkillSeedRows as MissingSkillSeedRows, skillSeedRows as SkillSeedRows, trainingSeedRows as TrainingSeedRows,
} from "../src/data/employees";
import type {
  departmentSeedRows as DepartmentSeedRows, pickSeedAdministrator as PickSeedAdministrator, SeedAuthUser,
} from "../src/data/departments";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see docs/DEPLOYMENT.md).");
  process.exit(1);
}

// Loaded by URL so Node runs the fixture directly while tsc still sees a plain module path above.
const fixtureUrl = new URL("../src/data/employees.ts", import.meta.url).href;
const {
  employees, evaluationSeedRows, interviewSeedRows, lmsStubSeedRows, missingSkillSeedRows, skillSeedRows, trainingSeedRows,
  assignmentSeedRows,
} = (await import(fixtureUrl)) as {
  employees: Employee[]; interviewSeedRows: typeof InterviewSeedRows; lmsStubSeedRows: typeof LmsStubSeedRows;
  trainingSeedRows: typeof TrainingSeedRows; skillSeedRows: typeof SkillSeedRows; missingSkillSeedRows: typeof MissingSkillSeedRows; evaluationSeedRows: typeof EvaluationSeedRows;
  assignmentSeedRows: typeof AssignmentSeedRows;
};

// Loaded the same way: the seed departments and the default department for fixture employees.
const departmentsUrl = new URL("../src/data/departments.ts", import.meta.url).href;
const { departmentSeedRows, DEFAULT_EMPLOYEE_DEPARTMENT_ID, ADMIN_MANAGED_DEPARTMENT_ID, pickSeedAdministrator } = (await import(departmentsUrl)) as {
  departmentSeedRows: typeof DepartmentSeedRows; DEFAULT_EMPLOYEE_DEPARTMENT_ID: string; ADMIN_MANAGED_DEPARTMENT_ID: string;
  pickSeedAdministrator: typeof PickSeedAdministrator;
};

const rows = employees.map(e => ({
  employee_id: e.id, name: e.name, title: e.title, team: e.team, employment_type: e.type,
  email: e.email.toLowerCase(), joined_on: e.joined, manager: e.manager, office: e.location,
  status: e.status, initials: e.initials, avatar_color: e.color, summary: e.summary,
}));

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
// Departments first: employees.department_id references departments. Rows are inserted parent first
// (one statement, in order), and insert-only, so an Administrator's later rename or re-parent survives.
const departments = await supabase.from("departments")
  .upsert(departmentSeedRows(), { onConflict: "id", ignoreDuplicates: true }).select("id");
if (departments.error) {
  console.error(`Seeding departments failed: ${departments.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${departments.data?.length ?? 0} new departments (existing ones left unchanged).`);

/** Every auth user (all pages); L&D's manager is chosen from them by pickSeedAdministrator. */
async function allAuthUsers(): Promise<SeedAuthUser[]> {
  const users: SeedAuthUser[] = [];
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.error(`Reading auth users failed: ${error.message}`);
      process.exit(1);
    }
    users.push(...data.users);
    const nextPage = (data as { nextPage?: number | null }).nextPage;
    if (data.users.length === 0 || nextPage === null || (nextPage === undefined && data.users.length < 1000)) break;
  }
  return users;
}

// L&D's manager is the Administrator (AD-5), set only while L&D has no manager, so an Administrator's
// later choice survives a re-run. Central R&D gets no manager: its authority resolves to L&D's manager.
const managedBy = await supabase.from("departments").select("manager_user_id").eq("id", ADMIN_MANAGED_DEPARTMENT_ID).maybeSingle();
if (managedBy.error) {
  console.error(`Reading the L&D manager failed: ${managedBy.error.message}`);
  process.exit(1);
}
if (managedBy.data && managedBy.data.manager_user_id === null) {
  const adminId = pickSeedAdministrator(await allAuthUsers(), process.env.SEED_ADMIN_EMAIL)?.id ?? null;
  if (adminId === null) {
    console.warn(`No Administrator account found, so L&D has no manager yet. Run \`npm run db:seed-admin\` first, then re-run \`npm run db:seed\`.`);
  } else {
    const assigned = await supabase.from("departments").update({ manager_user_id: adminId })
      .eq("id", ADMIN_MANAGED_DEPARTMENT_ID).is("manager_user_id", null).select("id");
    if (assigned.error) {
      console.error(`Setting the L&D manager failed: ${assigned.error.message}`);
      process.exit(1);
    }
    console.log(`Set the Administrator account as L&D's manager (${assigned.data?.length ?? 0} department updated).`);
  }
} else if (!managedBy.data) {
  console.warn("L&D was not found, so no manager was set.");
} else {
  console.log("L&D already has a manager (left unchanged).");
}

const { data, error } = await supabase.from("employees").upsert(rows, { onConflict: "employee_id" }).select("employee_id");
if (error) {
  console.error(`Seeding failed: ${error.message}`);
  process.exit(1);
}
console.log(`Upserted ${data?.length ?? 0} employees.`);

// Fixture employees without a department go to Central R&D. Never overwrites an existing department
// (an Administrator's or a later transfer's choice), and never touches non-fixture employees.
const placed = await supabase.from("employees")
  .update({ department_id: DEFAULT_EMPLOYEE_DEPARTMENT_ID })
  .in("employee_id", employees.map(e => e.id))
  .is("department_id", null)
  .select("employee_id");
if (placed.error) {
  console.error(`Seeding employee departments failed: ${placed.error.message}`);
  process.exit(1);
}
console.log(`Placed ${placed.data?.length ?? 0} fixture employees in the default department ${DEFAULT_EMPLOYEE_DEPARTMENT_ID} (employees with a department left unchanged).`);

// Story 4.5, after the placement (the assignments trigger copies the employee's department and refuses
// an employee without one). One open assignment per fixture employee, insert-only: employees who already
// have an open assignment are skipped (the one-open index would refuse a second), and a seeded row that
// was closed keeps its id, so it is ignored rather than duplicated.
const alreadyOpen = await supabase.from("assignments").select("employee_id")
  .in("employee_id", employees.map(e => e.id)).eq("status", "open");
if (alreadyOpen.error) {
  console.error(`Reading open assignments failed: ${alreadyOpen.error.message}`);
  process.exit(1);
}
const withOpen = new Set((alreadyOpen.data ?? []).map(r => r.employee_id as string));
const assignmentRows = assignmentSeedRows(employees).filter(r => !withOpen.has(r.employee_id));
let insertedAssignments = 0;
if (assignmentRows.length > 0) {
  const assignments = await supabase.from("assignments")
    .upsert(assignmentRows, { onConflict: "id", ignoreDuplicates: true, defaultToNull: false }).select("id");
  if (assignments.error) {
    console.error(`Seeding assignments failed: ${assignments.error.message}`);
    process.exit(1);
  }
  insertedAssignments = assignments.data?.length ?? 0;
}
console.log(`Inserted ${insertedAssignments} new open assignments (${withOpen.size} employees with an open assignment skipped; existing rows left unchanged).`);

// After the employees: external_interviews.employee_id references employees (ON DELETE RESTRICT).
const interviewRows = interviewSeedRows(employees);
// Insert-only: existing interview rows are never updated, so staff edits (stage, outcome, feedback) and
// withdrawals survive a re-seed (a withdrawn row can never change: the guard trigger refuses it).
const interviews = await supabase.from("external_interviews")
  .upsert(interviewRows, { onConflict: "id", ignoreDuplicates: true }).select("id");
if (interviews.error) {
  console.error(`Seeding interviews failed: ${interviews.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${interviews.data?.length ?? 0} new external interviews (existing ones left unchanged).`);

// After the employees: training_history.employee_id references employees (ON DELETE RESTRICT).
// Completed entries only; insert-only, so existing rows are left unchanged.
const training = await supabase.from("training_history")
  .upsert(trainingSeedRows(employees), { onConflict: "id", ignoreDuplicates: true }).select("id");
if (training.error) {
  console.error(`Seeding training failed: ${training.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${training.data?.length ?? 0} new completed-training entries (existing ones left unchanged).`);

// Story 7.4, after the employees: employee_skills.employee_id references employees (ON DELETE RESTRICT).
// The skill identifier is (employee_id, lower(name)), an expression index that upsert cannot target, so the
// existing skills of the fixture employees are read first and only missing ones are inserted.
// Read page by page (PostgREST caps one response at max_rows, 1000), in a total order.
const existingSkills: { employee_id: string; name: string }[] = [];
for (let from = 0; ; from += 1000) {
  const page = await supabase.from("employee_skills").select("employee_id,name")
    .in("employee_id", employees.map(e => e.id)).order("id").range(from, from + 999);
  if (page.error) {
    console.error(`Reading existing skills failed: ${page.error.message}`);
    process.exit(1);
  }
  existingSkills.push(...(page.data ?? []) as { employee_id: string; name: string }[]);
  if ((page.data ?? []).length < 1000) break;
}
const newSkills = missingSkillSeedRows(existingSkills, skillSeedRows(employees));
if (newSkills.length > 0) {
  const skills = await supabase.from("employee_skills").insert(newSkills, { defaultToNull: false }).select("id");
  if (skills.error) {
    console.error(`Seeding skills failed: ${skills.error.message}`);
    process.exit(1);
  }
}
console.log(`Inserted ${newSkills.length} new skill assessments (existing ones left unchanged).`);

// Story 7.4, after the employees: one evaluation per employee; insert-only, so a saved evaluation survives.
const evaluations = await supabase.from("employee_evaluations")
  .upsert(evaluationSeedRows(employees), { onConflict: "employee_id", ignoreDuplicates: true }).select("employee_id");
if (evaluations.error) {
  console.error(`Seeding evaluations failed: ${evaluations.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${evaluations.data?.length ?? 0} new evaluations (existing ones left unchanged).`);

// After the employees: lms_stub_enrolments.employee_id references employees (ON DELETE RESTRICT).
// In-progress entries only; insert-only, so existing rows (and their synced_at) are left unchanged.
const enrolments = await supabase.from("lms_stub_enrolments")
  .upsert(lmsStubSeedRows(employees), { onConflict: "id", ignoreDuplicates: true }).select("id");
if (enrolments.error) {
  console.error(`Seeding LMS stub enrolments failed: ${enrolments.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${enrolments.data?.length ?? 0} new LMS stub enrolments (existing ones left unchanged).`);
