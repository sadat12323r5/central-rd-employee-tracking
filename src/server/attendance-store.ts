import type { SupabaseClient } from "@supabase/supabase-js";
import { TimesheetValidationError, type DailyLog, type TimesheetEntry, type WorkMode } from "@/domain/timesheet";
import { getUserClient } from "./supabase";

// The only way the app reads and writes staff attendance (Story 1.5). Entries live in the Supabase
// `attendance_entries` table, so they survive restarts and are shared between Vercel instances.
//
// Every query goes through a per-request client carrying the signed-in user's Supabase JWT, so the
// attendance RLS policies are the enforced rule: staff read and write only entries of the employee
// linked to their auth user, administrators read every entry, and nobody deletes. The queries here
// are role-agnostic and never widen what RLS allows. This module never uses the service role.
export interface AttendanceStore {
  listForEmployee(employeeId: string): Promise<TimesheetEntry[]>;
  listAll(): Promise<TimesheetEntry[]>;
  save(entry: TimesheetEntry): Promise<void>;
  clear(): Promise<void>;
}

/** The attendance database is unreachable or refused the query. Never treat this as "no entries" or "saved". */
export class AttendanceUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Attendance records are temporarily unavailable.", options);
    this.name = "AttendanceUnavailableError";
  }
}

export type AttendanceRow = {
  id: string; employee_id: string; work_date: string; clock_in: string; clock_out: string | null;
  break_minutes: number; work_mode: WorkMode; log: DailyLog | null;
};

const TABLE = "attendance_entries";
const COLUMNS = "id,employee_id,work_date,clock_in,clock_out,break_minutes,work_mode,log";
/** Postgres unique_violation: a second entry for the same employee and day (a same-day race). */
const UNIQUE_VIOLATION = "23505";
// Same wording as the domain's ALREADY_RECORDED rule in src/domain/timesheet.ts.
const ALREADY_RECORDED_MESSAGE = "Today's attendance is already recorded.";

/** Timestamps come back as `+00:00` offsets; entries keep UTC ISO strings (`…Z`). */
const isoUtc = (value: string) => new Date(value).toISOString();

export function toEntry(row: AttendanceRow): TimesheetEntry {
  return {
    id: row.id, employeeId: row.employee_id, date: row.work_date,
    clockIn: isoUtc(row.clock_in), clockOut: row.clock_out ? isoUtc(row.clock_out) : null,
    breakMinutes: row.break_minutes, workMode: row.work_mode, log: row.log ?? null,
  };
}

export function toRow(entry: TimesheetEntry): AttendanceRow {
  return {
    id: entry.id, employee_id: entry.employeeId, work_date: entry.date, clock_in: entry.clockIn, clock_out: entry.clockOut,
    break_minutes: entry.breakMinutes, work_mode: entry.workMode, log: entry.log,
  };
}

type Result<T> = { data: T | null; error: unknown };

export type AttendanceStoreClients = {
  /** Per-request client carrying the signed-in user's JWT (RLS enforced). Used for every query. */
  userClient: () => Promise<SupabaseClient>;
};

const errorCode = (error: unknown) => (typeof error === "object" && error && "code" in error ? (error as { code: unknown }).code : undefined);

export function createAttendanceStore({ userClient }: AttendanceStoreClients): AttendanceStore {
  async function run<T>(query: (table: ReturnType<SupabaseClient["from"]>) => PromiseLike<Result<T>>): Promise<T | null> {
    let result: Result<T>;
    try {
      result = await query((await userClient()).from(TABLE));
    } catch (cause) {
      throw new AttendanceUnavailableError({ cause });
    }
    if (result.error) {
      if (errorCode(result.error) === UNIQUE_VIOLATION) throw new TimesheetValidationError("ALREADY_RECORDED", ALREADY_RECORDED_MESSAGE);
      throw new AttendanceUnavailableError({ cause: result.error });
    }
    return result.data;
  }

  async function list(employeeId?: string): Promise<TimesheetEntry[]> {
    const rows = await run<AttendanceRow[]>(t => {
      const query = t.select(COLUMNS);
      return (employeeId === undefined ? query : query.eq("employee_id", employeeId))
        .order("work_date", { ascending: false })
        .order("clock_in", { ascending: false })
        .returns<AttendanceRow[]>();
    });
    if (!rows) throw new AttendanceUnavailableError({ cause: "no data returned" });
    return rows.map(toEntry);
  }

  return {
    listForEmployee: employeeId => list(employeeId),
    listAll: () => list(),
    async save(entry) {
      await run(t => t.upsert({ ...toRow(entry), updated_at: new Date().toISOString() }, { onConflict: "id" }));
    },
    async clear() {
      throw new Error("Attendance entries are never deleted; clear() is only available on the in-memory test store.");
    },
  };
}

export const attendanceStore: AttendanceStore = createAttendanceStore({ userClient: getUserClient });
