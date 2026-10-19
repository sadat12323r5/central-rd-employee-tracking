import { randomBytes } from "node:crypto";
import { CENTRAL_RD_DEPARTMENT_ID } from "@/data/departments";
import type { AccountsStore } from "@/server/accounts-store";
import { createAttendanceCommands, type AttendanceCommands } from "@/server/attendance-commands";
import type { AttendanceStore } from "@/server/attendance-store";
import type { DepartmentsStore } from "@/server/departments-store";
import type { EmployeesStore } from "@/server/employees-store";
import type { SessionIdentity } from "@/server/session";
import { ADMIN_KEY, type Persona } from "./personas";

// Story 9.1: a run's cohort. Each run provisions a fresh cohort through the app's own paths (leave,
// assignments and audit rows are append-only, so runs never reset data):
// - accounts only through accounts-store `create` on the service-role client (the single account-creation
//   path), and archives only through accounts-store `archive`;
// - the department, its manager and the employees through departments-store and employees-store with the
//   sim Administrator's own signed-in client (RLS applies);
// - attendance through each persona's own signed-in client (attendance-commands).
// Employee ids come from a fresh block of 10 in the cohort range (BS-2000..BS-2999 by default: block NN is
// BS-2<NN>0..BS-2<NN>9), emails are `sim-<run>-<key>@example.com`, and every employee's summary starts with
// the cohort label, which is what retire matches on. Passwords are random per run, used once to create the
// account and once to sign in, and never stored, returned or printed.

export type IdRange = { first: number; last: number };
/** The default cohort range: BS-2000 to BS-2999 (100 blocks of 10). */
export const DEFAULT_RANGE: IdRange = { first: 2000, last: 2999 };
export const BLOCK_SIZE = 10;

export const employeeIdFor = (n: number) => `BS-${String(n).padStart(4, "0")}`;
const idNumber = (id: string) => (/^BS-\d{4}$/.test(id) ? Number(id.slice(3)) : NaN);
export const inRange = (id: string, range: IdRange) => {
  const n = idNumber(id);
  return n >= range.first && n <= range.last;
};

export const cohortLabel = (run: string) => `Simulation cohort ${run}.`;
export const cohortEmail = (run: string, key: string) => `sim-${run}-${key}@example.com`;
export const cohortDepartmentName = (run: string) => `Simulation Cohort ${run}`;
const RUN_PATTERN = /^c(\d{2})[0-9a-f]{4}$/;
const LABEL_PATTERN = /^Simulation cohort (c\d{2}[0-9a-f]{4})\./;

/** The cohort run id in an employee summary's label, or null when the summary does not start with one. */
export function labelledRun(summary: string | null | undefined): string | null {
  return LABEL_PATTERN.exec(summary ?? "")?.[1] ?? null;
}

/** The cohort could not be provisioned or retired as asked. Nothing more was attempted. */
export class CohortError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CohortError";
  }
}

function checkRange(range: IdRange) {
  const size = range.last - range.first + 1;
  if (!Number.isInteger(range.first) || !Number.isInteger(range.last) || range.first < 0 || range.last > 9999
    || range.first % BLOCK_SIZE !== 0 || size % BLOCK_SIZE !== 0 || size <= 0 || size > 100 * BLOCK_SIZE) {
    throw new CohortError(`Invalid cohort range ${range.first}-${range.last}.`);
  }
}

export type Block = { block: number; nn: string; ids: string[] };

/** The next free block of 10: the one after the highest block any id in the range uses (block 00 when none). */
export function allocateBlock(usedIds: readonly string[], range: IdRange = DEFAULT_RANGE): Block {
  checkRange(range);
  let highest = -1;
  for (const id of usedIds) {
    if (!inRange(id, range)) continue;
    highest = Math.max(highest, Math.floor((idNumber(id) - range.first) / BLOCK_SIZE));
  }
  const block = highest + 1;
  const start = range.first + block * BLOCK_SIZE;
  if (start + BLOCK_SIZE - 1 > range.last) {
    throw new CohortError(`The cohort range ${employeeIdFor(range.first)}-${employeeIdFor(range.last)} is full; nothing was provisioned.`);
  }
  return { block, nn: String(block).padStart(2, "0"), ids: Array.from({ length: BLOCK_SIZE }, (_, k) => employeeIdFor(start + k)) };
}

/** The stores a signed-in persona acts through, each carrying that persona's own JWT. */
export type PersonaStores = {
  departments: Pick<DepartmentsStore, "create" | "setManager">;
  employees: Pick<EmployeesStore, "create">;
  attendance: Pick<AttendanceStore, "listForEmployee" | "save">;
};

export type SignedIn = { userId: string; stores: PersonaStores };

export type ProvisionDeps = {
  /** accounts-store on the service-role client: create only. */
  accounts: Pick<AccountsStore, "create">;
  /** Signs in once with the persona's email and password and returns its own stores. */
  signIn(email: string, password: string): Promise<SignedIn>;
  /** Every employee id in use in the range (archived ones included). */
  usedIds(range: IdRange): Promise<string[]>;
  /** 4 lower-case hex characters (default: random). */
  randomHex?: () => string;
  /** A fresh password of 12-72 characters (default: random). */
  newPassword?: () => string;
};

export type CohortMember = {
  persona: Persona;
  email: string;
  userId: string;
  /** Null for the Administrator persona (an account only, no employee row). */
  employeeId: string | null;
  session: SessionIdentity;
  /** The persona's own attendance commands; null for the Administrator. */
  attendance: AttendanceCommands | null;
};

export type Cohort = {
  run: string;
  block: number;
  ids: string[];
  departmentId: string;
  departmentName: string;
  members: CohortMember[];
};

const randomPassword = () => `Sim-${randomBytes(24).toString("base64url")}!`;
const randomHex4 = () => randomBytes(2).toString("hex");

/** Provisions a new cohort (see the module comment for the order and the paths used). */
export async function provisionCohort(
  deps: ProvisionDeps, { range = DEFAULT_RANGE, personas }: { range?: IdRange; personas: readonly Persona[] },
): Promise<Cohort> {
  const admins = personas.filter(p => p.role === "admin");
  const managers = personas.filter(p => p.role === "manager");
  const people = [...managers, ...personas.filter(p => p.role === "staff")];
  if (admins.length !== 1 || admins[0].key !== ADMIN_KEY) throw new CohortError(`A cohort needs exactly one Administrator persona keyed "${ADMIN_KEY}".`);
  if (managers.length !== 1) throw new CohortError("A cohort needs exactly one manager persona.");
  if (people.length > BLOCK_SIZE) throw new CohortError(`A cohort holds at most ${BLOCK_SIZE} employees.`);
  if (new Set(personas.map(p => p.key)).size !== personas.length) throw new CohortError("Persona keys must be unique.");

  const { block, nn, ids } = allocateBlock(await deps.usedIds(range), range);
  const hex = (deps.randomHex ?? randomHex4)();
  const run = `c${nn}${hex}`;
  if (!RUN_PATTERN.test(run)) throw new CohortError("Invalid cohort run id.");
  const newPassword = deps.newPassword ?? randomPassword;
  const label = cohortLabel(run);
  const departmentName = cohortDepartmentName(run);
  const [admin] = admins;
  const [manager] = managers;
  // From here on the run id exists: any failure names the cohort and the step, so a partly created cohort
  // can be found (nothing is rolled back; the cause is kept).
  const step = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CohortError(`Cohort ${run} is partly provisioned: ${name} failed: ${reason} Nothing was rolled back.`, { cause });
    }
  };

  // 1-2. The Administrator account, then its one sign-in.
  const adminEmail = cohortEmail(run, admin.key);
  const adminPassword = newPassword();
  await step("the Administrator account", () => deps.accounts.create({ role: "admin", email: adminEmail, password: adminPassword }));
  const adminSignedIn = await step("the Administrator sign-in", () => deps.signIn(adminEmail, adminPassword));
  const adminSession: SessionIdentity = { role: "admin" };

  // 3. The cohort's department, under Central R&D.
  const department = await step("the department", () =>
    adminSignedIn.stores.departments.create(adminSession, { name: departmentName, parentId: CENTRAL_RD_DEPARTMENT_ID }));

  // 4. Each manager and staff persona: the employee (labelled), then its Staff account.
  const passwords = new Map<string, string>();
  const employeeIds = new Map<string, string>();
  for (const [i, persona] of people.entries()) {
    const employeeId = ids[i];
    await step(`employee ${employeeId} (${persona.key})`, () => adminSignedIn.stores.employees.create(adminSession, {
      employeeId, name: persona.name, title: persona.title, team: "Simulation", email: cohortEmail(run, persona.key),
      departmentId: department.id, manager: persona.role === "manager" ? admin.name : manager.name, office: "Dhaka HQ",
      employmentType: persona.employmentType, joinedOn: persona.joinedOn,
    }, { summary: `${label} ${persona.personality}` }));
    const password = newPassword();
    await step(`the account of ${employeeId} (${persona.key})`, () => deps.accounts.create({ role: "staff", employeeId, password }));
    passwords.set(persona.key, password);
    employeeIds.set(persona.key, employeeId);
  }

  // 5. The department's manager (the account exists now).
  await step("setting the department's manager", () =>
    adminSignedIn.stores.departments.setManager(adminSession, department.id, employeeIds.get(manager.key)!));

  // 6. One sign-in per manager and staff persona.
  const members: CohortMember[] = [{
    persona: admin, email: adminEmail, userId: adminSignedIn.userId, employeeId: null, session: adminSession, attendance: null,
  }];
  for (const persona of people) {
    const email = cohortEmail(run, persona.key);
    const signedIn = await step(`the sign-in of ${persona.key}`, () => deps.signIn(email, passwords.get(persona.key)!));
    passwords.delete(persona.key);
    const employeeId = employeeIds.get(persona.key)!;
    members.push({
      persona, email, userId: signedIn.userId, employeeId,
      session: persona.role === "manager" ? { role: "manager", employeeId, userId: signedIn.userId } : { role: "staff", employeeId },
      attendance: createAttendanceCommands(signedIn.stores.attendance),
    });
  }
  return { run, block, ids, departmentId: department.id, departmentName, members };
}

export type RangeEmployee = { employeeId: string; summary: string | null; archived: boolean };

export type RetireDeps = {
  /** accounts-store on the service-role client: archive only. */
  accounts: Pick<AccountsStore, "archive">;
  /** The employees in the range (archived ones included), with their summaries. */
  rangeEmployees(range: IdRange): Promise<RangeEmployee[]>;
  /** Every auth user's id and email. */
  listUsers(): Promise<{ id: string; email: string | null | undefined }[]>;
  warn?: (message: string) => void;
};

export type RetireResult = {
  archived: { run: string; employeeId: string }[];
  kept: string[];
  skipped: { run: string; reason: string }[];
  failed: { run: string; employeeId: string; reason: string }[];
};

const blockOf = (run: string) => Number(RUN_PATTERN.exec(run)?.[1] ?? -1);

/**
 * Archives the employees of earlier cohorts (every cohort with `all`) through accounts-store `archive`, with
 * each cohort's own Administrator account as the actor. Only non-archived employees in the range whose
 * summary starts with a cohort label are touched; the newest cohort (highest block) is kept unless `all`.
 */
export async function retireCohorts(deps: RetireDeps, { range = DEFAULT_RANGE, all = false }: { range?: IdRange; all?: boolean } = {}): Promise<RetireResult> {
  checkRange(range);
  const warn = deps.warn ?? (message => console.warn(message));
  const cohorts = new Map<string, string[]>();
  for (const employee of await deps.rangeEmployees(range)) {
    if (employee.archived || !inRange(employee.employeeId, range)) continue;
    const run = labelledRun(employee.summary);
    if (!run) continue;
    cohorts.set(run, [...(cohorts.get(run) ?? []), employee.employeeId]);
  }
  const runs = [...cohorts.keys()].sort((a, b) => blockOf(a) - blockOf(b) || a.localeCompare(b));
  const kept = all ? [] : runs.slice(-1);
  const result: RetireResult = { archived: [], kept, skipped: [], failed: [] };
  const toRetire = runs.filter(run => !kept.includes(run));
  if (toRetire.length === 0) return result;

  const users = await deps.listUsers();
  for (const run of toRetire) {
    const email = cohortEmail(run, ADMIN_KEY);
    const admin = users.find(u => (u.email ?? "").toLowerCase() === email);
    if (!admin) {
      const reason = `Cohort ${run}'s Administrator account (${email}) was not found; its employees were left as they are.`;
      warn(reason);
      result.skipped.push({ run, reason });
      continue;
    }
    for (const employeeId of cohorts.get(run)!.sort()) {
      try {
        await deps.accounts.archive({ employeeId, actorId: admin.id });
        result.archived.push({ run, employeeId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warn(`Could not archive ${employeeId} (cohort ${run}): ${reason}`);
        result.failed.push({ run, employeeId, reason });
      }
    }
  }
  return result;
}
