"use server";

import {
  activityErrorMessage, exportActivity, exportAllActivity, NOT_ADMIN, type ActivityExportInput, type BulkActivityExportInput,
} from "./activity-export";
import { attendanceStore } from "./attendance-store";
import type { ActionState } from "./attendance-actions";
import { createAuditStore } from "./audit-store";
import { getActor } from "./auth";
import { employeesStore } from "./employees-store";
import { interviewsStore } from "./interviews-store";
import { getServiceClient } from "./supabase";
import { trainingStore } from "./training-store";

// Administrator-only activity export (Story 8.1). The admin session is checked here, at the server,
// before anything else: a Staff session or no session reads nothing and gets no CSV. The audit actor is
// the validated Supabase user from the session, never anything in the form. The CSV text is returned to
// the profile panel, which saves it, so validation and "unavailable" messages render inline.
// Story 8.2 adds the bulk export of every employee (exportAllActivityAction), with the same checks.

export type ActivityExportState = ActionState & { csv?: string; filename?: string };

const FIELDS = ["employeeId", "period", "month", "year", "from", "to"] as const;

export async function exportActivityAction(_previous: ActivityExportState, form: FormData): Promise<ActivityExportState> {
  const actor = await getActor();
  if (actor?.identity.role !== "admin") return { error: NOT_ADMIN, message: "" };

  const input: ActivityExportInput = Object.fromEntries(FIELDS.map(name => [name, form.get(name) ?? undefined]));
  try {
    const result = await exportActivity(
      {
        employees: employeesStore, attendance: attendanceStore, interviews: interviewsStore, training: trainingStore,
        audit: createAuditStore(getServiceClient),
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
  if (actor?.identity.role !== "admin") return { error: NOT_ADMIN, message: "" };

  const input: BulkActivityExportInput = Object.fromEntries(BULK_FIELDS.map(name => [name, form.get(name) ?? undefined]));
  try {
    const result = await exportAllActivity(
      { employees: employeesStore, attendance: attendanceStore, training: trainingStore, audit: createAuditStore(getServiceClient) },
      actor.identity, actor.userId, input, new Date(),
    );
    return { error: "", message: `Exported ${result.filename}.`, csv: result.csv, filename: result.filename };
  } catch (error) {
    return failure(error);
  }
}
