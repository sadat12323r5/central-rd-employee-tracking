import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAccountsStore } from "@/server/accounts-store";
import { createAssignmentEvaluationsStore } from "@/server/assignment-evaluations-store";
import { createAssessmentsStore } from "@/server/assessments-store";
import { createAssignmentsStore } from "@/server/assignments-store";
import { createAttendanceStore } from "@/server/attendance-store";
import { createAuditStore } from "@/server/audit-store";
import { createBackfilledProjectStore } from "@/server/backfilled-project-store";
import { createDepartmentsStore } from "@/server/departments-store";
import { createEmployeesStore } from "@/server/employees-store";
import { createEmploymentHistoryStore } from "@/server/employment-history-store";
import { createHolidayCalendarStore } from "@/server/holiday-calendar-store";
import { createInterviewsStore } from "@/server/interviews-store";
import { createLeaveStore } from "@/server/leave-store";
import { createStubLmsClient } from "@/server/lms-client";
import { createManagerScope } from "@/server/manager-scope";
import { readAllPages } from "@/server/paging";
import { createTrainingStore } from "@/server/training-store";
import { SIM_START, SimSetupError } from "./calendar";
import { employeeIdFor, type IdRange, type PersonaStores, type ProvisionDeps, type RangeEmployee, type RetireDeps, type SignedIn } from "./cohort";
import { createSimClock } from "./tools/clock";
import type { ServiceAudit, SimClock, ToolStores } from "./tools/types";

// Story 9.1: the simulator's real dependencies against the shared Supabase project. Developer-only:
// loaded by scripts/sim/*.ts under tsx, never by the web app. Reads `.env.local` like the seed scripts and
// needs only the three Supabase variables (it never reads the model API key). Error messages name
// variables, never values.
//
// The service-role client is written through accounts-store only (create and archive), plus (Story 9.2) the
// export audit row through audit-store, as activity-actions.ts does. The service role
// also reads, before the cohort's Administrator exists or after its password is gone: the ids in use in
// the cohort range, the range's employees and summaries for retire, the auth users (to find a cohort's
// Administrator) and the active holiday calendar. Everything else runs as a persona's own signed-in client.

export const SUPABASE_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Loads `.env.local` when present (existing environment variables win) and checks the Supabase variables. */
export function loadSimEnv(env: Record<string, string | undefined> = process.env, envFile = ".env.local") {
  // Like process.loadEnvFile, but into `env` (the object checked below); existing variables win.
  if (existsSync(envFile)) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) env[name] ??= value;
  }
  const missing = SUPABASE_VARS.filter(name => !(env[name] ?? "").trim());
  if (missing.length > 0) throw new SimSetupError(`Set ${missing.join(", ")} (in .env.local or the environment); nothing was provisioned.`);
  return { url: env.NEXT_PUBLIC_SUPABASE_URL!, anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY! };
}

/** The app's stores on one signed-in client (its JWT, so RLS applies to every query). */
export function storesFor(client: SupabaseClient): PersonaStores {
  const userClient = async () => client;
  const scope = createManagerScope({ userClient });
  return {
    departments: createDepartmentsStore({ userClient, scope }),
    employees: createEmployeesStore({
      userClient, scope,
      interviews: createInterviewsStore({ userClient }),
      training: createTrainingStore({ userClient, scope, lms: createStubLmsClient({ userClient }) }),
      assignments: createAssignmentsStore({ userClient, scope }),
      evaluations: createAssignmentEvaluationsStore({ userClient, scope }),
      backfilled: createBackfilledProjectStore({ userClient, scope }),
      // The defaults would read the holiday calendar through the Next request client.
      leave: createLeaveStore({ userClient, scope, calendar: createHolidayCalendarStore({ userClient }) }),
    }),
    attendance: createAttendanceStore({ userClient, scope }),
  };
}

/**
 * Story 9.2: the stores a persona's tools call, all on its own signed-in client (never the Next request
 * client, never the service role) and scoped through its own manager-scope. The backfill store's "today"
 * comes from the simulated clock.
 */
export function personaStoresFor(client: SupabaseClient, clock: SimClock): ToolStores {
  const userClient = async () => client;
  const scope = createManagerScope({ userClient });
  const leave = createLeaveStore({ userClient, scope, calendar: createHolidayCalendarStore({ userClient }) });
  const interviews = createInterviewsStore({ userClient });
  const training = createTrainingStore({ userClient, scope, lms: createStubLmsClient({ userClient }) });
  const assignments = createAssignmentsStore({ userClient, scope });
  const evaluations = createAssignmentEvaluationsStore({ userClient, scope });
  const backfilled = createBackfilledProjectStore({ userClient, scope, now: () => clock.now() });
  const assessments = createAssessmentsStore({ userClient, scope });
  const history = createEmploymentHistoryStore({ userClient, scope });
  return {
    employees: createEmployeesStore({ userClient, scope, interviews, training, assignments, evaluations, backfilled, assessments, history, leave }),
    leave, interviews, backfilled, history, assignments, evaluations, assessments, training, scope,
    departments: createDepartmentsStore({ userClient, scope }),
    attendance: createAttendanceStore({ userClient, scope }),
  };
}

export type SimDeps = ProvisionDeps & RetireDeps & {
  /** Story 9.2: the run's simulated clock, which every persona's tool stores read. */
  clock: SimClock;
  /** Story 9.2: the export audit store on the service-role client (as activity-actions.ts does). */
  serviceAudit: ServiceAudit;
  activeCalendar(): ReturnType<ReturnType<typeof createHolidayCalendarStore>["active"]>;
};

export function createSimDeps(config = loadSimEnv(), clock: SimClock = createSimClock(SIM_START)): SimDeps {
  const service = createClient(config.url, config.serviceKey, noSession);
  const accounts = createAccountsStore(() => service);

  async function rangeRows(range: IdRange): Promise<{ employee_id: string; summary: string | null; archived_at: string | null }[]> {
    return readAllPages(async (from, to) => {
      const { data, error } = await service.from("employees").select("employee_id,summary,archived_at")
        .gte("employee_id", employeeIdFor(range.first)).lte("employee_id", employeeIdFor(range.last))
        .order("employee_id").range(from, to);
      if (error) throw new SimSetupError(`Could not read the cohort range (${error.code ?? "error"}).`, { cause: error });
      return data ?? [];
    });
  }

  return {
    accounts,
    clock,
    serviceAudit: createAuditStore(() => service),
    async signIn(email, password): Promise<SignedIn> {
      const client = createClient(config.url, config.anonKey, noSession);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.user) throw new SimSetupError(`Could not sign in ${email}: ${error?.message ?? "no user returned"}.`);
      return { userId: data.user.id, stores: storesFor(client), tools: personaStoresFor(client, clock) };
    },
    usedIds: async range => (await rangeRows(range)).map(r => r.employee_id),
    rangeEmployees: async (range): Promise<RangeEmployee[]> =>
      (await rangeRows(range)).map(r => ({ employeeId: r.employee_id, summary: r.summary, archived: r.archived_at !== null })),
    async listUsers() {
      const users: { id: string; email: string | undefined }[] = [];
      for (let page = 1; ; page++) {
        const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new SimSetupError(`Could not list auth users: ${error.message}.`);
        users.push(...data.users.map(u => ({ id: u.id, email: u.email })));
        const nextPage = (data as { nextPage?: number | null }).nextPage;
        if (data.users.length === 0 || nextPage === null || (nextPage === undefined && data.users.length < 1000)) return users;
      }
    },
    activeCalendar: () => createHolidayCalendarStore({ userClient: async () => service }).active({ role: "admin" }),
  };
}
