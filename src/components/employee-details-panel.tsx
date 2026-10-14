"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { EMPLOYMENT_TYPES, TEXT_FIELD_MAX } from "@/domain/employee-input";
import type { ActionState } from "@/server/attendance-actions";
import { updateEmployeeDetailsAction } from "@/server/employee-actions";

type Field = "title" | "team" | "manager" | "office";

const initial: ActionState = { error: "", message: "" };

function Text({ id, name, label, value }: { id: string; name: Field; label: string; value: string }) {
  return <div className="staff-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} name={name} type="text" defaultValue={value} required maxLength={TEXT_FIELD_MAX} autoComplete="off" />
  </div>;
}

/**
 * Story 7.2: the Administrator (anyone) and department managers (their subtree) edit an employee's title,
 * team, reporting manager, office and employment type. There is deliberately no department control: an
 * employee's department changes only through a transfer, so it is shown read-only. The server re-checks
 * everything. Render it with `key={employeeId}` so it remounts (and refills) for each employee.
 */
export default function EmployeeDetailsPanel({ employeeId, name, title, team, manager, office, employmentType, departmentName }: {
  employeeId: string; name: string; title: string; team: string; manager: string; office: string; employmentType: string;
  departmentName: string;
}) {
  const [state, action, pending] = useActionState(updateEmployeeDetailsAction, initial);
  // Submitted by hand rather than through `action=`, which would make React reset the form after every
  // submission: a refusal keeps what was entered (and focus).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  // A legacy value outside the known types is still shown, so saving without touching it is refused visibly, not silently changed.
  const types: readonly string[] = (EMPLOYMENT_TYPES as readonly string[]).includes(employmentType) ? EMPLOYMENT_TYPES : [employmentType, ...EMPLOYMENT_TYPES];
  const prefix = `details-${employeeId}`;
  return <article className="panel employee-details" aria-labelledby={`${prefix}-heading`}>
    <h2 id={`${prefix}-heading`}>Edit details</h2>
    <p className="muted">Update {name}&apos;s basic details. Every field is required.</p>
    <form onSubmit={onSubmit} className="staff-log" aria-label="Edit employee details">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="add-employee-grid">
        <Text id={`${prefix}-title`} name="title" label="Job title" value={title} />
        <Text id={`${prefix}-team`} name="team" label="Team" value={team} />
        <Text id={`${prefix}-manager`} name="manager" label="Reporting manager" value={manager} />
        <Text id={`${prefix}-office`} name="office" label="Office" value={office} />
        <div className="staff-field">
          <label htmlFor={`${prefix}-type`}>Employment type</label>
          <select id={`${prefix}-type`} name="employmentType" defaultValue={employmentType} required>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {/* Read-only on purpose: no input, so the form never carries a department. */}
        <div className="staff-field read-only-field">
          <span className="field-label">Department</span>
          <strong className="regular">{departmentName}</strong>
          <small>Changes through a transfer.</small>
        </div>
      </div>
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save details"}</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>
    <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
  </article>;
}
