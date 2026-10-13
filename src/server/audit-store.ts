import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isCalendarDate } from "@/domain/dates";

// The only writer of activity-export audit rows (Story 8.1). It calls the Postgres function
// `record_activity_export`, which appends one `audit_events` row (actor, target employee,
// `export_activity`, period). audit_events is append-only with RLS on and no policies, so the client
// passed in must be the service-role client; the export action uses it only after the caller's
// Administrator session was checked.

export type ActivityExportAudit = { actorId: string; employeeId: string; from: string; to: string };

export interface AuditStore {
  /** Appends one `export_activity` audit row. Throws a typed error when nothing was recorded. */
  recordActivityExport(input: ActivityExportAudit): Promise<void>;
}

/** The audit log is unreachable or refused the write. Nothing was recorded. */
export class AuditUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The audit log is temporarily unavailable.", options);
    this.name = "AuditUnavailableError";
  }
}

/** The audited employee does not exist. Nothing was recorded. */
export class AuditEmployeeNotFoundError extends Error {
  constructor() {
    super("The employee to audit was not found.");
    this.name = "AuditEmployeeNotFoundError";
  }
}

/** The audit input is malformed (never sent to the database). `fields` names the offending inputs. */
export class AuditValidationError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`Invalid audit details: ${fields.join(", ")}.`);
    this.name = "AuditValidationError";
    this.fields = fields;
  }
}

const calendarDate = z.string().refine(isCalendarDate);
const exportInput = z.object({
  actorId: z.uuid(),
  employeeId: z.string().regex(/^BS-\d{4}$/),
  from: calendarDate,
  to: calendarDate,
}).refine(input => input.from <= input.to, { path: ["to"] });

export function createAuditStore(getClient: () => SupabaseClient): AuditStore {
  return {
    async recordActivityExport(input) {
      const parsed = exportInput.safeParse(input);
      if (!parsed.success) throw new AuditValidationError([...new Set(parsed.error.issues.map(i => String(i.path[0] ?? "input")))]);
      const { actorId, employeeId, from, to } = parsed.data;
      let result: { data: unknown; error: { message?: string } | null };
      try {
        result = await getClient().rpc("record_activity_export", { p_actor: actorId, p_employee_id: employeeId, p_from: from, p_to: to });
      } catch (cause) {
        throw new AuditUnavailableError({ cause });
      }
      if (result.error) {
        if (result.error.message === "employee_not_found") throw new AuditEmployeeNotFoundError();
        throw new AuditUnavailableError({ cause: result.error });
      }
      if (result.data === null || result.data === undefined) throw new AuditUnavailableError({ cause: "no audit id returned" });
    },
  };
}
