"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import type { Department } from "@/domain/departments";
import { EMPLOYMENT_TYPES } from "@/domain/employee-input";
import type { ActionState } from "@/server/attendance-actions";
import { createEmployeeAction } from "@/server/employee-actions";

type Field = "employeeId" | "name" | "title" | "team" | "email" | "manager" | "office" | "joinedOn";

/** `attempt` counts successful adds: the form is re-keyed (cleared) only then. */
type AddState = ActionState & { attempt: number };
const initial: AddState = { error: "", message: "", attempt: 0 };

async function submit(previous: AddState, form: FormData): Promise<AddState> {
  const result = await createEmployeeAction({ error: previous.error, message: previous.message }, form);
  return { ...result, attempt: result.error ? previous.attempt : previous.attempt + 1 };
}

function Text({ id, name, label, type = "text", hint, ...rest }: {
  id: string; name: Field; label: string; type?: string; hint?: string;
  maxLength?: number; required?: boolean; pattern?: string; autoComplete?: string;
}) {
  return <div className="staff-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} name={name} type={type} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}

/**
 * Story 7.1: the Administrator (any department) and department managers (their subtree) add a new
 * employee. `departments` are the ones the portal already has: all for an admin, the subtree for a
 * manager. The server re-checks everything; nothing here creates a sign-in account.
 */
export default function AddEmployeePanel({ departments }: { departments: Department[] }) {
  const [state, action, pending] = useActionState(submit, initial);
  // Submitted by hand rather than through `action=`, which would make React reset the form after every
  // submission: a refusal keeps what was entered (and focus); a success re-keys the form to clear it.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  const sorted = [...departments].sort((a, b) => a.name.localeCompare(b.name));
  return <section className="panel add-employee" aria-labelledby="add-employee-heading">
    <h2 id="add-employee-heading">Add an employee</h2>
    <p className="muted">Every field is required except the join date, which defaults to today. Give them a sign-in account from their profile afterwards.</p>
    <form key={state.attempt} onSubmit={onSubmit} className="staff-log" aria-label="Add an employee">
      <div className="add-employee-grid">
        <Text id="new-employee-id" name="employeeId" label="Employee ID" required pattern="BS-\d{4}" maxLength={7} hint="BS followed by four digits, like BS-1234." />
        <Text id="new-employee-name" name="name" label="Full name" required maxLength={120} autoComplete="off" />
        <Text id="new-employee-title" name="title" label="Job title" required maxLength={120} />
        <Text id="new-employee-team" name="team" label="Team" required maxLength={120} />
        <Text id="new-employee-email" name="email" label="Email address" type="email" required maxLength={254} autoComplete="off" />
        <div className="staff-field">
          <label htmlFor="new-employee-department">Department</label>
          <select id="new-employee-department" name="departmentId" defaultValue="" required>
            <option value="" disabled>Choose a department…</option>
            {sorted.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <Text id="new-employee-manager" name="manager" label="Reporting manager" required maxLength={120} />
        <Text id="new-employee-office" name="office" label="Office" required maxLength={120} />
        <div className="staff-field">
          <label htmlFor="new-employee-type">Employment type</label>
          <select id="new-employee-type" name="employmentType" defaultValue="" required>
            <option value="" disabled>Choose a type…</option>
            {EMPLOYMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <Text id="new-employee-joined" name="joinedOn" label="Join date (optional)" type="date" hint="Leave empty for today." />
      </div>
      {departments.length === 0 && <p className="muted">There are no departments to add employees to yet.</p>}
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Adding…" : "Add employee"}</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>
    {/* Outside the re-keyed form, so the live region stays in place between submissions. */}
    <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
  </section>;
}
