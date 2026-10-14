"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { EVALUATION_TEXT_MAX, READINESS_MAX } from "@/domain/assessment-input";
import type { ActionState } from "@/server/attendance-actions";
import { saveEvaluationAction } from "@/server/assessment-actions";

const initial: ActionState = { error: "", message: "" };

/**
 * Story 7.4: the Administrator (anyone) and department managers (their subtree) edit an employee's
 * evaluation summary: strengths, development priorities and readiness, prefilled with the current values.
 * The reviewer and the date are set by the server from the session, never entered here. Render it with
 * `key={employeeId}`; the form inside is keyed by the current values, so it refills once a save has
 * refreshed them, while the confirmation (held by this component) stays.
 */
export default function EvaluationPanel({ employeeId, name, strengths, developmentPriorities, readiness }: {
  employeeId: string; name: string; strengths: string; developmentPriorities: string; readiness: string;
}) {
  const [state, action, pending] = useActionState(saveEvaluationAction, initial);
  // Submitted by hand rather than through `action=`, so a refusal keeps what was entered (and focus).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  const prefix = `evaluation-${employeeId}`;
  const current = [strengths, developmentPriorities, readiness].join("\u0000");
  return <article className="panel assessment-form" aria-labelledby={`${prefix}-heading`}>
    <h2 id={`${prefix}-heading`}>Edit evaluation</h2>
    <p className="muted">Update {name}&apos;s evaluation summary. Every field is required; you are recorded as the reviewer, dated today.</p>
    <form key={current} onSubmit={onSubmit} className="staff-log" aria-label="Edit evaluation">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="staff-field">
        <label htmlFor={`${prefix}-strengths`}>Strengths</label>
        <textarea id={`${prefix}-strengths`} name="strengths" rows={3} defaultValue={strengths} required maxLength={EVALUATION_TEXT_MAX} />
      </div>
      <div className="staff-field">
        <label htmlFor={`${prefix}-priorities`}>Development priorities</label>
        <textarea id={`${prefix}-priorities`} name="developmentPriorities" rows={3} defaultValue={developmentPriorities} required maxLength={EVALUATION_TEXT_MAX} />
      </div>
      <div className="staff-field">
        <label htmlFor={`${prefix}-readiness`}>Readiness</label>
        <input id={`${prefix}-readiness`} name="readiness" type="text" defaultValue={readiness} required maxLength={READINESS_MAX} autoComplete="off" />
      </div>
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save evaluation"}</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>
    <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
  </article>;
}
