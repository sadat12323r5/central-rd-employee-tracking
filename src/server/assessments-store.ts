import type { SupabaseClient } from "@supabase/supabase-js";
import {
  invalidEvaluationFields, invalidSkillRatingFields, normalizeEvaluation, normalizeSkillRating,
  type EvaluationField, type EvaluationInput, type SkillRatingField, type SkillRatingInput,
} from "@/domain/assessment-input";
import { managerScope, ManagerScopeUnavailableError, type ManagerScope } from "./manager-scope";
import type { ManagerIdentity, SessionIdentity } from "./session";
import { readAllPages } from "./paging";
import { getUserClient } from "./supabase";

// Story 7.4: the single source of skills assessments and the manager evaluation, read from the Supabase
// `employee_skills` and `employee_evaluations` tables. employees-store merges them into each profile;
// nothing reads skills or the evaluation from the fixture (`src/data/employees.ts` is seed-only for them).
//
// Every query and write goes through a per-request client carrying the signed-in user's JWT, so the RLS
// policies are the enforced rule: the Administrator reads every row, an employee only their own, a
// department manager those of employees in their subtree. The scoping here is the store-level layer
// (defence in depth): staff reads are limited to the session's own employee, manager reads to the subtree
// (manager-scope, computed fresh on each call); anything outside is empty, without a query.
//
// Writes go only through two SECURITY DEFINER functions (rate_employee_skill, update_employee_evaluation),
// which take the author and the review date from the session. The Administrator may assess anyone, a
// manager only employees in their subtree (checked here before the rpc, and again by the function); Staff
// never, not even on their own record. There is no removal path. This module never uses the service role.

/** One assessed skill: rated 1–5 with supporting evidence. */
export type SkillEntry = { employeeId: string; name: string; level: number; evidence: string };

/** One employee's evaluation summary; the reviewer label and date were set by the database at save time. */
export type EvaluationEntry = {
  employeeId: string; strengths: string; developmentPriorities: string; readiness: string; reviewer: string; reviewedOn: string;
};

export type Assessments = { skills: SkillEntry[]; evaluations: EvaluationEntry[] };

export interface AssessmentsStore {
  /**
   * The skills (per employee strongest first: level descending, then name) and evaluations the session may
   * see: everyone's for an Administrator, the department subtree's for a manager, only the session's own for
   * staff. `employeeId` narrows to one employee (staff: only their own; manager: only an in-scope id; anyone
   * else's is empty, without a query). Throws AssessmentsUnavailableError on any read failure.
   */
  listFor(session: SessionIdentity, employeeId?: string): Promise<Assessments>;
  /**
   * Rates one skill (inserting it, or updating the same name in any case). Throws AssessmentForbiddenError
   * (Staff, or outside a manager's subtree), AssessmentValidationError, AssessmentNotFoundError or
   * AssessmentsUnavailableError.
   */
  rateSkill(session: SessionIdentity, employeeId: string, input: SkillRatingInput): Promise<{ employeeId: string; name: string }>;
  /** Saves the evaluation summary. Throws the same errors as `rateSkill`. */
  saveEvaluation(session: SessionIdentity, employeeId: string, input: EvaluationInput): Promise<{ employeeId: string; name: string }>;
}

/** The caller may not assess this employee: a Staff session, or outside a manager's subtree. */
export class AssessmentForbiddenError extends Error {
  constructor() {
    super("Only an Administrator, or a manager for their own department subtree, can change skills or the evaluation.");
    this.name = "AssessmentForbiddenError";
  }
}

/**
 * The input failed validation. `fields` names the offending inputs; values are never included. `"input"`
 * means the database function refused the values without naming a field.
 */
export class AssessmentValidationError extends Error {
  readonly fields: (SkillRatingField | EvaluationField | "input")[];
  constructor(fields: (SkillRatingField | EvaluationField | "input")[]) {
    super(`Invalid assessment: ${fields.join(", ")}.`);
    this.name = "AssessmentValidationError";
    this.fields = fields;
  }
}

/** There is no employee with this Employee ID. */
export class AssessmentNotFoundError extends Error {
  constructor() {
    super("No employee has this Employee ID.");
    this.name = "AssessmentNotFoundError";
  }
}

/** The assessments database is unreachable or refused the query. Never treat this as "no assessments". */
export class AssessmentsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Skills and evaluations are temporarily unavailable.", options);
    this.name = "AssessmentsUnavailableError";
  }
}

export type SkillRow = { id: string; employee_id: string; name: string; level: number; evidence: string };
export type EvaluationRow = {
  employee_id: string; strengths: string; development_priorities: string; readiness: string; reviewer: string; reviewed_on: string;
};

const SKILLS = "employee_skills";
const EVALUATIONS = "employee_evaluations";
const SKILL_COLUMNS = "id,employee_id,name,level,evidence";
const EVALUATION_COLUMNS = "employee_id,strengths,development_priorities,readiness,reviewer,reviewed_on";

export function toSkill(row: SkillRow): SkillEntry {
  return { employeeId: row.employee_id, name: row.name, level: row.level, evidence: row.evidence };
}

export function toEvaluation(row: EvaluationRow): EvaluationEntry {
  return {
    employeeId: row.employee_id, strengths: row.strengths, developmentPriorities: row.development_priorities,
    readiness: row.readiness, reviewer: row.reviewer, reviewedOn: row.reviewed_on,
  };
}

type Result<T> = { data: T | null; error: unknown };
type DbError = { code?: string; message?: string; details?: string };

/** Maps a function refusal to the store's typed errors; anything unrecognised is "unavailable". */
function writeRefusal(error: DbError): Error {
  switch (error.message) {
    case "not_authorized": return new AssessmentForbiddenError();
    case "invalid_input": return new AssessmentValidationError(["input"]);
    case "employee_not_found": return new AssessmentNotFoundError();
    default: return new AssessmentsUnavailableError({ cause: error });
  }
}

/** Which employees a read covers: everyone (`undefined`), or exactly these ids. */
type Filter = { ids?: string[] };

export type AssessmentsStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query and rpc. */
  userClient: () => Promise<SupabaseClient>;
  /** A manager's department subtree, worked out fresh on each call (default: the real manager-scope). */
  scope?: ManagerScope;
};

export function createAssessmentsStore({ userClient, scope = managerScope }: AssessmentsStoreClients): AssessmentsStore {
  async function run<T>(table: string, query: (t: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(table));
    } catch (cause) {
      throw new AssessmentsUnavailableError({ cause });
    }
    if (result.error) throw new AssessmentsUnavailableError({ cause: result.error });
    if (result.data === null || result.data === undefined) throw new AssessmentsUnavailableError({ cause: "no data returned" });
    return result.data;
  }

  /** The employee ids in a manager's subtree; a scope that cannot be read is unavailable, never a partial list. */
  async function managedEmployeeIds(session: ManagerIdentity): Promise<Set<string>> {
    try {
      return (await scope.forManager(session)).employeeIds;
    } catch (cause) {
      if (cause instanceof ManagerScopeUnavailableError) throw new AssessmentsUnavailableError({ cause });
      throw cause;
    }
  }

  /** Both tables for the filter, each paged (Story 8.2) with a total order. */
  async function read({ ids }: Filter): Promise<Assessments> {
    const [skills, evaluations] = await Promise.all([
      readAllPages((from, to) => run<SkillRow[]>(SKILLS, t => {
        const query = t.select(SKILL_COLUMNS);
        return (ids === undefined ? query : ids.length === 1 ? query.eq("employee_id", ids[0]) : query.in("employee_id", ids))
          .order("employee_id")
          .order("level", { ascending: false })
          .order("name")
          .order("id")
          .range(from, to)
          .returns<SkillRow[]>();
      })),
      readAllPages((from, to) => run<EvaluationRow[]>(EVALUATIONS, t => {
        const query = t.select(EVALUATION_COLUMNS);
        return (ids === undefined ? query : ids.length === 1 ? query.eq("employee_id", ids[0]) : query.in("employee_id", ids))
          .order("employee_id")
          .range(from, to)
          .returns<EvaluationRow[]>();
      })),
    ]);
    // Defence in depth: only rows of the employees asked for, whatever the query returned.
    const allowed = ids === undefined ? () => true : (id: string) => ids.includes(id);
    return {
      skills: skills.filter(r => allowed(r.employee_id)).map(toSkill),
      evaluations: evaluations.filter(r => allowed(r.employee_id)).map(toEvaluation),
    };
  }

  const nothing = (): Assessments => ({ skills: [], evaluations: [] });

  /** Staff never write; a manager only within their subtree. Refused before any rpc. */
  async function authorize(session: SessionIdentity, employeeId: string) {
    if (session.role !== "admin" && session.role !== "manager") throw new AssessmentForbiddenError();
    if (session.role === "manager" && !(await managedEmployeeIds(session)).has(employeeId)) throw new AssessmentForbiddenError();
  }

  async function call(fn: string, args: Record<string, unknown>, employeeId: string) {
    let result: { data: unknown; error: DbError | null };
    try {
      result = await (await userClient()).rpc(fn, args);
    } catch (cause) {
      throw new AssessmentsUnavailableError({ cause });
    }
    if (result.error) throw writeRefusal(result.error);
    if (typeof result.data !== "string") throw new AssessmentsUnavailableError({ cause: "no employee name returned" });
    return { employeeId, name: result.data };
  }

  return {
    async listFor(session, employeeId) {
      if (session.role === "admin") return read({ ids: employeeId === undefined ? undefined : [employeeId] });
      if (session.role === "manager") {
        const ids = await managedEmployeeIds(session);
        // Out of scope (or nothing in scope): nothing, without a query.
        if (employeeId !== undefined) return ids.has(employeeId) ? read({ ids: [employeeId] }) : nothing();
        return ids.size === 0 ? nothing() : read({ ids: [...ids] });
      }
      // Staff only ever see their own; asking for anyone else's returns nothing, without a query.
      if (employeeId !== undefined && employeeId !== session.employeeId) return nothing();
      return read({ ids: [session.employeeId] });
    },

    async rateSkill(session, employeeId, input) {
      await authorize(session, employeeId);
      const rating = normalizeSkillRating(input);
      const invalid = invalidSkillRatingFields(rating);
      if (invalid.length > 0) throw new AssessmentValidationError(invalid);
      return call("rate_employee_skill", {
        p_employee_id: employeeId, p_name: rating.name, p_level: rating.level, p_evidence: rating.evidence,
      }, employeeId);
    },

    async saveEvaluation(session, employeeId, input) {
      await authorize(session, employeeId);
      const evaluation = normalizeEvaluation(input);
      const invalid = invalidEvaluationFields(evaluation);
      if (invalid.length > 0) throw new AssessmentValidationError(invalid);
      // Only the three texts are sent: the reviewer and the date come from the session, in the function.
      return call("update_employee_evaluation", {
        p_employee_id: employeeId, p_strengths: evaluation.strengths,
        p_development_priorities: evaluation.developmentPriorities, p_readiness: evaluation.readiness,
      }, employeeId);
    },
  };
}

export const assessmentsStore: AssessmentsStore = createAssessmentsStore({ userClient: getUserClient });
