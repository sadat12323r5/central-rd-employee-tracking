import type { AttendanceCommands } from "@/server/attendance-commands";
import type { SessionIdentity } from "@/server/session";
import type { CohortMember } from "../../sim/cohort";
import { PERSONAS } from "../../sim/personas";
import type { NewTimelineEvent } from "../../sim/timeline";
import { createSimClock } from "../../sim/tools/clock";
import type { ServiceAudit, ToolContext, ToolStores } from "../../sim/tools/types";

// Story 9.2: offline fakes for the persona tool layer. Every store method records its call (store, method,
// arguments) and answers with a canned value; a method can be made to throw instead, to stand in for an
// app refusal. No database, no network, no model.

export type StoreCall = { store: string; method: string; args: unknown[] };

export const STAFF_SESSION: SessionIdentity = { role: "staff", employeeId: "BS-2003" };
export const MANAGER_SESSION: SessionIdentity = { role: "manager", employeeId: "BS-2000", userId: "user-manager" };
export const ADMIN_SESSION: SessionIdentity = { role: "admin" };

const persona = (role: "admin" | "manager" | "staff") => PERSONAS.find(p => p.role === role)!;

export function fakeToolContext(role: "admin" | "manager" | "staff", {
  results = {} as Record<string, unknown>,
  failures = {} as Record<string, unknown>,
  withAttendance = true,
} = {}) {
  const calls: StoreCall[] = [];
  const events: NewTimelineEvent[] = [];
  const answer = (store: string, method: string) => async (...args: unknown[]) => {
    calls.push({ store, method, args });
    const key = `${store}.${method}`;
    if (key in failures) throw failures[key];
    if (key in results) return results[key];
    return store === "attendance-commands" ? `${method} done.` : { id: `${store}-1` };
  };
  const fake = (store: string, methods: string[]) => Object.fromEntries(methods.map(m => [m, answer(store, m)]));
  const stores = {
    employees: fake("employees", ["getFor", "listFor", "transfer"]),
    leave: fake("leave", ["record", "update", "cancel", "listFor"]),
    interviews: fake("interviews", ["add", "update", "withdraw", "listFor"]),
    backfilled: fake("backfilled", ["add", "listFor", "departmentOptions"]),
    history: fake("history", ["add", "update", "remove"]),
    assignments: fake("assignments", ["create", "updateNote", "close", "listFor"]),
    evaluations: fake("evaluations", ["create", "listFor"]),
    assessments: fake("assessments", ["rateSkill", "saveEvaluation"]),
    departments: fake("departments", ["create", "update", "setManager"]),
    attendance: fake("attendance", ["listFor", "listAll"]),
    training: fake("training", ["listFor", "currentFor"]),
    scope: fake("scope", ["forManager"]),
  } as unknown as ToolStores;
  const attendance = fake("attendance-commands", ["clockIn", "clockOut", "saveLog"]) as unknown as AttendanceCommands;
  const serviceAudit = fake("service-audit", ["recordActivityExport", "recordBulkActivityExport", "recordDepartmentActivityExport"]) as unknown as ServiceAudit;
  const session = role === "staff" ? STAFF_SESSION : role === "manager" ? MANAGER_SESSION : ADMIN_SESSION;
  const member: CohortMember = {
    persona: persona(role), email: `sim-c00ab12-${role}@example.com`, userId: `user-${role}`,
    employeeId: role === "admin" ? null : session.employeeId ?? null, session,
    attendance: role === "admin" || !withAttendance ? null : attendance, tools: stores,
  };
  const clock = createSimClock("2026-08-10", "10:00");
  const ctx: ToolContext = { member, stores, clock, timeline: { record: event => { events.push(event); return { seq: events.length, ...event }; } }, serviceAudit };
  return { ctx, calls, events, clock, stores, serviceAudit };
}
