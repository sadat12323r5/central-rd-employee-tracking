"use server";

import {
  activityErrorMessage, exportActivity, exportAllActivity, mayExport, NOT_ALLOWED, type ActivityExportInput, type BulkActivityExportInput,
} from "./activity-export";
import { assignmentEvaluationsStore } from "./assignment-evaluations-store";
import { assignmentsStore } from "./assignments-store";
import { attendanceStore } from "./attendance-store";
import type { ActionState } from "./attendance-actions";
import { createAuditStore } from "./audit-store";
import { getActor } from "./auth";
import { employeesStore } from "./employees-store";
import { backfilledProjectStore } from "./backfilled-project-store";
import { interviewsStore } from "./interviews-store";
import { leaveStore } from "./leave-store";
import { managerScope } from "./manager-scope";
import { getServiceClient } from "./supabase";
import { trainingStore } from "./training-store";

// Activity export (Story 8.1, Administrator only until Story 8.3). The session is checked here, at the server,
// before anything else: a Staff session or no session reads nothing and gets no CSV. The audit actor is
// the validated Supabase user from the session, never anything in the form. The CSV text is returned to
// the profile panel, which saves it, so validation and "unavailable" messages render inline.
// Story 8.2 adds the bulk export of every employee (exportAllActivityAction), with the same checks.
// Story 8.3 opens both to department managers: the role is checked here, and the subtree scope (and the
// absence of interviews) is enforced in activity-export.ts through the session-aware stores.
// Story 8.4 adds the assignment, backfilled-project, evaluation and leave stores (the user's session, never the service role).

const RECORD_STORES = {
  assignments: assignmentsStore, backfilledProjects: backfilledProjectStore, evaluations: assignmentEvaluationsStore, leave: leaveStore,
};

export type ActivityExportState = ActionState & { csv?: string; filename?: string };

const FIELDS = ["employeeId", "period", "month", "year", "from", "to"] as const;

export async function exportActivityAction(_previous: ActivityExportState, form: FormData): Promise<ActivityExportState> {
  const actor = await getActor();
  if (!actor || !mayExport(actor.identity)) return { error: NOT_ALLOWED, message: "" };

  const input: ActivityExportInput = Object.fromEntries(FIELDS.map(name => [name, form.get(name) ?? undefined]));
  try {
    const result = await exportActivity(
      {
        employees: employeesStore, attendance: attendanceStore, interviews: interviewsStore, training: trainingStore,
        audit: createAuditStore(getServiceClient), ...RECORD_STORES,
      },
      actor.identity, actor.userId, input, new Date(),
    );
    return { error: "", message: `Exported ${result.filename}.`, csv: result.csv, filename: result.filename };
  } catch (error) {
    return failure(error);
  }
}

/** The inline failure state; unexpected failures are logged by name only (never any employee data). */
function failure(error: unknown): ActivityExportState {
  const message = activityErrorMessage(error);
  if (error instanceof Error && error.name !== "ActivityValidationError" && error.name !== "ActivityEmployeeNotFoundError") {
    console.error("Activity export failed.", error.name, error.cause instanceof Error ? error.cause.name : "");
  }
  return { error: message, message: "" };
}

const BULK_FIELDS = ["period", "month", "year", "from", "to", "includeArchived"] as const;

export async function exportAllActivityAction(_previous: ActivityExportState, form: FormData): Promise<ActivityExportState> {
  const actor = await getActor();
  if (!actor || !mayExport(actor.identity)) return { error: NOT_ALLOWED, message: "" };

  const input: BulkActivityExportInput = Object.fromEntries(BULK_FIELDS.map(name => [name, form.get(name) ?? undefined]));
  try {
    const result = await exportAllActivity(
      {
        employees: employeesStore, attendance: attendanceStore, training: trainingStore, audit: createAuditStore(getServiceClient),
        scope: managerScope, ...RECORD_STORES,
      },
      actor.identity, actor.userId, input, new Date(),
    );
    return { error: "", message: `Exported ${result.filename}.`, csv: result.csv, filename: result.filename };
  } catch (error) {
    return failure(error);
  }
}
