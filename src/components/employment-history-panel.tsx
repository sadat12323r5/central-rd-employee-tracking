"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import type { Employee } from "@/data/employees";
import { DETAIL_MAX, EMPLOYER_MAX, PERIOD_MAX, ROLE_MAX } from "@/domain/employment-history";
import type { ActionState } from "@/server/attendance-actions";
import {
  addEmploymentHistoryAction, removeEmploymentHistoryAction, updateEmploymentHistoryAction,
} from "@/server/employment-history-actions";

type Entry = Employee["history"][number];

const initial: ActionState = { error: "", message: "" };

/** `attempt` counts successful submissions: the add form is re-keyed (cleared) only then. */
type CountedState = ActionState & { attempt: number };
const counted: CountedState = { ...initial, attempt: 0 };

async function addEntry(previous: CountedState, form: FormData): Promise<CountedState> {
  const result = await addEmploymentHistoryAction({ error: previous.error, message: previous.message }, form);
  return { ...result, attempt: result.error ? previous.attempt : previous.attempt + 1 };
}

async function updateEntry(previous: CountedState, form: FormData): Promise<CountedState> {
  const result = await updateEmploymentHistoryAction({ error: previous.error, message: previous.message }, form);
  return { ...result, attempt: result.error ? previous.attempt : previous.attempt + 1 };
}

function Feedback({ state }: { state: ActionState }) {
  return <>
    {state.error && <p role="alert" className="form-error">{state.error}</p>}
    <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
  </>;
}

/**
 * Submitted by hand rather than through `action=`, which would make React reset the form after every
 * submission: a refusal keeps what was entered (and focus).
 */
const submitWith = (action: (form: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  startTransition(() => action(form));
};

/** The role, employer, period and detail inputs, prefilled for an edit. */
function EntryFields({ prefix, entry }: { prefix: string; entry?: Entry }) {
  return <>
    <div className="staff-field">
      <label htmlFor={`${prefix}-role`}>Role</label>
      <input id={`${prefix}-role`} name="role" defaultValue={entry?.role} required maxLength={ROLE_MAX} autoComplete="off" />
    </div>
    <div className="staff-field">
      <label htmlFor={`${prefix}-employer`}>Employer</label>
      <input id={`${prefix}-employer`} name="employer" defaultValue={entry?.company} required maxLength={EMPLOYER_MAX} autoComplete="off" />
    </div>
    <div className="staff-field">
      <label htmlFor={`${prefix}-period`}>Period</label>
      <input id={`${prefix}-period`} name="period" defaultValue={entry?.period} required maxLength={PERIOD_MAX} autoComplete="off" aria-describedby={`${prefix}-period-hint`} />
      <small id={`${prefix}-period-hint`}>Include a year, like 2021 – 2023 or Mar 2023 – Present.</small>
    </div>
    <div className="staff-field">
      <label htmlFor={`${prefix}-detail`}>Detail (optional)</label>
      <textarea id={`${prefix}-detail`} name="detail" rows={3} defaultValue={entry?.detail} maxLength={DETAIL_MAX} />
    </div>
  </>;
}

/**
 * One entry's controls: "Edit" opens an inline form; "Remove" asks for confirmation first. The remove
 * state is owned by the panel: a removed entry leaves the list (this component unmounts), so its
 * message is shown once at panel level.
 */
function EntryControls({ entry, employeeId, removeAction, removePending }: {
  entry: Entry; employeeId: string; removeAction: (form: FormData) => void; removePending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(updateEntry, counted);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const saved = useRef(state.attempt);
  const name = `${entry.role}, ${entry.company}`;
  const prefix = `history-${entry.id}`;

  // A successful save closes the form and returns focus to its Edit button.
  useEffect(() => {
    if (state.attempt === saved.current) return;
    saved.current = state.attempt;
    setEditing(false);
    editRef.current?.focus();
  }, [state.attempt]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  return <div className="history-controls">
    {!editing && !confirming && <div className="staff-actions">
      <button type="button" className="text-button" ref={editRef} onClick={() => setEditing(true)} aria-label={`Edit employment entry: ${name}`}>Edit</button>
      <button type="button" className="text-button" onClick={() => setConfirming(true)} aria-label={`Remove employment entry: ${name}`}>Remove</button>
    </div>}
    {editing && <form onSubmit={submitWith(action)} className="staff-log" aria-label={`Edit employment entry: ${name}`}>
      <input type="hidden" name="id" value={entry.id} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <EntryFields prefix={prefix} entry={entry} />
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save entry"}</button>
        <button type="button" className="secondary" onClick={() => { setEditing(false); editRef.current?.focus(); }}>Cancel</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>}
    {confirming && <form onSubmit={submitWith(form => { setConfirming(false); removeAction(form); })} className="staff-log" aria-label={`Remove employment entry: ${name}`}>
      <input type="hidden" name="id" value={entry.id} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <p className="muted">Remove this entry from the employment history? It is kept in the record&apos;s history and cannot be changed again.</p>
      <div className="staff-actions">
        <button className="secondary" ref={confirmRef} disabled={removePending}>{removePending ? "Removing…" : "Confirm remove"}</button>
        <button type="button" className="text-button" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </form>}
    {!editing && <p role="status" className="staff-status">{state.error ? "" : state.message}</p>}
  </div>;
}

/**
 * Story 7.3: an employee's employment history as a timeline, newest first (the order the store returns).
 * The timeline markup is the profile's original one. With `canEdit` (the employee on their own record,
 * the Administrator, or a manager for their subtree) it adds an "Add employment entry" form and, per
 * entry, Edit and Remove. The server re-checks everything. Render with `key={employeeId}`.
 */
export default function EmploymentHistoryPanel({ employeeId, entries, canEdit }: { employeeId: string; entries: Employee["history"]; canEdit: boolean }) {
  const [addState, addAction, addPending] = useActionState(addEntry, counted);
  const [removeState, removeAction, removePending] = useActionState(removeEmploymentHistoryAction, initial);
  const prefix = `history-new-${employeeId}`;
  return <>
    {entries.length === 0 ? <p className="muted">No employment history has been recorded.</p> : <div className="timeline">{entries.map(h => <div className="timeline-item" key={h.id}><span className="timeline-dot" /><small>{h.period}</small><h3>{h.role}</h3><strong>{h.company}</strong><p>{h.detail}</p>{canEdit && <EntryControls entry={h} employeeId={employeeId} removeAction={removeAction} removePending={removePending} />}</div>)}</div>}
    {canEdit && <>
      <Feedback state={removeState} />
      <form key={addState.attempt} onSubmit={submitWith(addAction)} className="staff-log employment-history-add" aria-label="Add employment entry">
        <h3>Add employment entry</h3>
        <input type="hidden" name="employeeId" value={employeeId} />
        <EntryFields prefix={prefix} />
        <div className="staff-actions">
          <button className="primary" disabled={addPending}>{addPending ? "Adding…" : "Add entry"}</button>
        </div>
        {addState.error && <p role="alert" className="form-error">{addState.error}</p>}
      </form>
      {/* Outside the re-keyed form, so the live region stays in place between submissions. */}
      <p role="status" className="staff-status">{addState.error ? "" : addState.message}</p>
    </>}
  </>;
}
