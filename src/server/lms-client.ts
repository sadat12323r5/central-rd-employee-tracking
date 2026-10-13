import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserClient } from "./supabase";

// The LMS adapter (Story 3.2, AD-3): the only way the app learns about LMS enrolments. Its contract is
// fixed: `listCurrentEnrolments(employeeId)` resolves `{ data, asOf, stale }` and throws
// `LmsUnavailableError` only when the LMS cannot be reached. A reachable but stale answer resolves with
// `stale: true`. When real LMS access arrives, only the implementation below changes.
//
// Only `training-store` may import this module (enforced by tests/training-sources.test.ts); every
// view reads training through the store.
//
// The current implementation is a stub over the `lms_stub_enrolments` table (seeded by `npm run
// db:seed` from the fixture's in-progress training). It reads through the per-request client carrying
// the signed-in user's JWT, so RLS applies: the employee's own rows, or every row for an
// Administrator. It never uses the service role, never makes HTTP calls to a real LMS and has no
// write path.

export type Enrolment = {
  id: string;
  employeeId: string;
  programme: string;
  provider: string;
  status: "in_progress" | "completed";
  /** 0–100; below 100 while in progress. */
  progress: number;
  /** `YYYY-MM-DD`; set while in progress. */
  targetDate: string | null;
  /** `YYYY-MM-DD`; set once completed. */
  completedOn: string | null;
  result: string;
};

export type EnrolmentsResult = { data: Enrolment[]; asOf: string; stale: boolean };

export interface LmsClient {
  /**
   * The employee's LMS enrolments (in progress and completed). `asOf` is when the LMS data was last
   * synced (ISO 8601); `stale` is true when that is too long ago. Throws LmsUnavailableError only when
   * the LMS is unreachable.
   */
  listCurrentEnrolments(employeeId: string): Promise<EnrolmentsResult>;
}

/** The LMS could not be reached. Never treat this as "no enrolments". */
export class LmsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The LMS is temporarily unavailable.", options);
    this.name = "LmsUnavailableError";
  }
}

/**
 * The stub's staleness threshold: data synced longer ago than this is marked stale. The PRD sets no
 * threshold; this is the stub's own constant and is replaced when the real LMS lands.
 */
export const LMS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** A read that has not answered after this long counts as unreachable (LmsUnavailableError). */
export const LMS_TIMEOUT_MS = 10_000;

export type LmsStubRow = {
  id: string; employee_id: string; programme: string; provider: string; status: Enrolment["status"]; progress: number;
  target_date: string | null; completed_on: string | null; result: string; synced_at: string;
};

const TABLE = "lms_stub_enrolments";
const COLUMNS = "id,employee_id,programme,provider,status,progress,target_date,completed_on,result,synced_at";

export function toEnrolment(row: LmsStubRow): Enrolment {
  return {
    id: row.id, employeeId: row.employee_id, programme: row.programme, provider: row.provider, status: row.status,
    progress: row.progress, targetDate: row.target_date ?? null, completedOn: row.completed_on ?? null, result: row.result ?? "",
  };
}

type Result<T> = { data: T | null; error: unknown };

export type StubLmsClientOptions = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). */
  userClient: () => Promise<SupabaseClient>;
  /** The current time (injectable for tests). */
  now?: () => Date;
  /** How long a read may take before it counts as unreachable (injectable for tests). */
  timeoutMs?: number;
};

/** Rejects with LmsUnavailableError if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LmsUnavailableError({ cause: `no answer within ${ms} ms` })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function createStubLmsClient({ userClient, now = () => new Date(), timeoutMs = LMS_TIMEOUT_MS }: StubLmsClientOptions): LmsClient {
  return {
    async listCurrentEnrolments(employeeId) {
      let result: Result<LmsStubRow[]>;
      try {
        result = await withTimeout((async () => (await userClient()).from(TABLE).select(COLUMNS)
          .eq("employee_id", employeeId)
          .order("target_date", { ascending: true, nullsFirst: false })
          .order("completed_on", { ascending: false })
          .order("id", { ascending: true })
          .returns<LmsStubRow[]>())(), timeoutMs);
      } catch (cause) {
        if (cause instanceof LmsUnavailableError) throw cause;
        throw new LmsUnavailableError({ cause });
      }
      if (result.error) throw new LmsUnavailableError({ cause: result.error });
      if (result.data === null || result.data === undefined) throw new LmsUnavailableError({ cause: "no data returned" });

      const readAt = now();
      // Defence in depth: only the requested employee's rows.
      const rows = result.data.filter(r => r.employee_id === employeeId);
      if (rows.length === 0) return { data: [], asOf: readAt.toISOString(), stale: false };
      const synced = rows.map(r => Date.parse(r.synced_at));
      // An unreadable sync time cannot be shown as fresh: the whole answer is stale.
      const unreadable = synced.some(Number.isNaN);
      const valid = synced.filter(t => !Number.isNaN(t));
      const oldest = valid.length > 0 ? Math.min(...valid) : readAt.getTime();
      return {
        data: rows.map(toEnrolment),
        asOf: new Date(oldest).toISOString(),
        stale: unreadable || readAt.getTime() - oldest > LMS_STALE_AFTER_MS,
      };
    },
  };
}

export const lmsClient: LmsClient = createStubLmsClient({ userClient: getUserClient });
