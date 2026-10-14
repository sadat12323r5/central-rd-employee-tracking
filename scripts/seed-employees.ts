// Idempotent seed: upserts the fixture's basic employee fields into the Supabase `employees` table,
// then the fixture's external interviews into `external_interviews` (Story 2.1) and its completed
// training into `training_history` (Story 3.1), with the service-role client. Interview and training
// ids are the fixture's deterministic ids (interviewSeedId, trainingSeedId), so re-running never adds
// copies. In-progress training is never copied into `training_history`: it is inserted into the LMS
// stub table `lms_stub_enrolments` (Story 3.2, ids from lmsStubSeedId), which the LMS adapter stub
// reads. Departments (Story 4.1) are inserted before the employees are touched (L&D, then Central R&D
// under it, fixed ids, insert-only); afterwards every fixture employee whose department_id is still
// null is placed in Central R&D. Other nested profile data stays in the fixture (read by employees-store); the fixture's
// interviews and training are never read at runtime.
// Run with `npm run db:seed`. Credentials come from the environment or .env.local and are never printed.
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type {
  Employee, interviewSeedRows as InterviewSeedRows, lmsStubSeedRows as LmsStubSeedRows, trainingSeedRows as TrainingSeedRows,
} from "../src/data/employees";
import type { departmentSeedRows as DepartmentSeedRows } from "../src/data/departments";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see docs/DEPLOYMENT.md).");
  process.exit(1);
}

// Loaded by URL so Node runs the fixture directly while tsc still sees a plain module path above.
const fixtureUrl = new URL("../src/data/employees.ts", import.meta.url).href;
const { employees, interviewSeedRows, lmsStubSeedRows, trainingSeedRows } = (await import(fixtureUrl)) as {
  employees: Employee[]; interviewSeedRows: typeof InterviewSeedRows; lmsStubSeedRows: typeof LmsStubSeedRows;
  trainingSeedRows: typeof TrainingSeedRows;
};

// Loaded the same way: the seed departments and the default department for fixture employees.
const departmentsUrl = new URL("../src/data/departments.ts", import.meta.url).href;
const { departmentSeedRows, DEFAULT_EMPLOYEE_DEPARTMENT_ID } = (await import(departmentsUrl)) as {
  departmentSeedRows: typeof DepartmentSeedRows; DEFAULT_EMPLOYEE_DEPARTMENT_ID: string;
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

// After the employees: lms_stub_enrolments.employee_id references employees (ON DELETE RESTRICT).
// In-progress entries only; insert-only, so existing rows (and their synced_at) are left unchanged.
const enrolments = await supabase.from("lms_stub_enrolments")
  .upsert(lmsStubSeedRows(employees), { onConflict: "id", ignoreDuplicates: true }).select("id");
if (enrolments.error) {
  console.error(`Seeding LMS stub enrolments failed: ${enrolments.error.message}`);
  process.exit(1);
}
console.log(`Inserted ${enrolments.data?.length ?? 0} new LMS stub enrolments (existing ones left unchanged).`);
