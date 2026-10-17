"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import type { LeaveRecord } from "@/data/employees";
import { formatDisplayDate } from "@/domain/dates";
import { categoryForWorkingDays } from "@/domain/leave";
import type { ActionState } from "@/server/attendance-actions";
import { cancelLeaveAction, recordLeaveAction, updateLeaveAction } from "@/server/leave-actions";

const initial: ActionState = { error: "", message: "" };

/** `attempt` counts successful submissions: the form is re-keyed (cleared) or closed only then. */
type CountedState = ActionState & { attempt: number };
const counted: CountedState = { ...initial, attempt: 0 };

async function record(previous: CountedState, form: FormData): Promise<CountedState> {
  const result = await recordLeaveAction({ error: previous.error, message: previous.message }, form);
  return { ...result, attempt: result.error ? previous.attempt : previous.attempt + 1 };
}

async function update(previous: CountedState, form: FormData): Promise<CountedState> {
  const result = await updateLeaveAction({ error: previous.error, message: previous.message }, form);
  return { ...result, attempt: result.error ? previous.attempt : previous.attempt + 1 };
}

/** Submitted by hand rather than through `action=`, so a refusal keeps the dates entered. */
const submitWith = (action: (form: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  startTransition(() => action(form));
};

/** A category always shows its text label next to its colour (from the domain, for the period's working days). */
function Category({ workingDays }: { workingDays: number }) {
  const display = categoryForWorkingDays(workingDays);
  return <span className="leave-category"><span className="leave-swatch" style={{ background: display.colour }} aria-hidden="true" />{display.label}</span>;
}

/** The first and last day inputs (prefilled for an edit). */
function DateFields({ prefix, record }: { prefix: string; record?: LeaveRecord }) {
  return <div className="leave-dates">
    <div className="staff-field">
      <label htmlFor={`${prefix}-start`}>First day of leave</label>
      <input id={`${prefix}-start`} name="startDate" type="date" defaultValue={record?.startDate} required />
    </div>
    <div className="staff-field">
      <label htmlFor={`${prefix}-end`}>Last day of leave</label>
      <input id={`${prefix}-end`} name="endDate" type="date" defaultValue={record?.endDate} required />
    </div>
  </div>;
}

/**
 * Story 5.3: one active period's controls. "Edit" opens an inline form with its dates; "Cancel leave" asks
 * for confirmation first. The cancel state is owned by the panel: a cancelled period loses these controls
 * (this component unmounts), so its message is shown once at panel level.
 */
function LeaveControls({ record, employeeId, cancelAction, cancelPending }: {
  record: LeaveRecord; employeeId: string; cancelAction: (form: FormData) => void; cancelPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(update, counted);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const saved = useRef(state.attempt);
  const refocus = useRef(false);
  const name = `${formatDisplayDate(record.startDate)} to ${formatDisplayDate(record.endDate)}`;
  const prefix = `leave-edit-${record.id}`;

  /** Closes the edit form; focus returns to its Edit button once that is rendered again. */
  const closeEdit = () => { refocus.current = true; setEditing(false); };
  // A successful save closes the form.
  useEffect(() => {
    if (state.attempt === saved.current) return;
    saved.current = state.attempt;
    closeEdit();
  }, [state.attempt]);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    editRef.current?.focus();
  }, [editing]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  return <div className="leave-controls">
    {!editing && !confirming && <div className="staff-actions">
      <button type="button" className="text-button" ref={editRef} onClick={() => setEditing(true)} aria-label={`Edit leave: ${name}`}>Edit</button>
      <button type="button" className="text-button" onClick={() => setConfirming(true)} aria-label={`Cancel leave: ${name}`}>Cancel leave</button>
    </div>}
    {editing && <form onSubmit={submitWith(action)} className="staff-log" aria-label={`Edit leave: ${name}`}>
      <input type="hidden" name="id" value={record.id} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <DateFields prefix={prefix} record={record} />
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save dates"}</button>
        <button type="button" className="secondary" onClick={closeEdit}>Don&apos;t save</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>}
    {confirming && <form onSubmit={submitWith(form => { setConfirming(false); cancelAction(form); })} className="staff-log" aria-label={`Cancel leave: ${name}`}>
      <input type="hidden" name="id" value={record.id} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <p className="muted">Cancel this leave? It stays in the leave history and no longer counts. It cannot be changed again.</p>
      <div className="staff-actions">
        <button className="secondary" ref={confirmRef} disabled={cancelPending}>{cancelPending ? "Cancelling…" : "Confirm cancel"}</button>
        <button type="button" className="text-button" onClick={() => setConfirming(false)}>Keep leave</button>
      </div>
    </form>}
    {!editing && <p role="status" className="staff-status">{state.error ? "" : state.message}</p>}
  </div>;
}

/**
 * Story 5.2: an employee's leave periods (newest start first, the order the store returns), each with its
 * working days and category, and "Cancelled" when cancelled. With `canEdit` (the employee on their own
 * record, the Administrator, or a manager for their subtree) it adds a "Record leave" form. The server
 * counts the working days and re-checks everything. Render with `key={employeeId}`.
 * Story 5.3: with `canEdit`, each active (non-cancelled) period also gets Edit and Cancel leave.
 */
export default function LeavePanel({ employeeId, records, canEdit, own = false }: {
  employeeId: string; records: LeaveRecord[]; canEdit: boolean;
  /** True on the employee's own record (wording only). */
  own?: boolean;
}) {
  const [state, action, pending] = useActionState(record, counted);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelLeaveAction, initial);
  const prefix = `leave-${employeeId}`;
  return <>
    {records.length === 0 ? <p className="muted">{own ? "You have not recorded any leave yet." : "No leave has been recorded."}</p> : <div className="table-scroll"><table aria-label={own ? "Your leave" : "Recorded leave"}>
      <thead><tr><th>From</th><th>To</th><th>Working days</th><th>Category</th><th>Status</th>{canEdit && <th>Changes</th>}</tr></thead>
      <tbody>{records.map(r => <tr key={r.id}>
        <td>{formatDisplayDate(r.startDate)}</td><td>{formatDisplayDate(r.endDate)}</td><td>{r.workingDays}</td>
        <td><Category workingDays={r.workingDays} /></td>
        <td>{r.cancelledAt ? <span className="badge withdrawn">Cancelled</span> : <span className="badge green"><span className="dot" />Recorded</span>}</td>
        {canEdit && <td>{!r.cancelledAt && <LeaveControls record={r} employeeId={employeeId} cancelAction={cancelAction} cancelPending={cancelPending} />}</td>}
      </tr>)}</tbody>
    </table></div>}
    {canEdit && <>
      {cancelState.error && <p role="alert" className="form-error">{cancelState.error}</p>}
      <p role="status" className="staff-status">{cancelState.error ? "" : cancelState.message}</p>
      <form key={state.attempt} onSubmit={submitWith(action)} className="staff-log leave-form" aria-label="Record leave">
        <h3>Record leave</h3>
        <p className="muted">Working days exclude weekends (Saturday and Sunday) and holidays in the loaded holiday calendar. The category is assigned automatically.</p>
        <input type="hidden" name="employeeId" value={employeeId} />
        <DateFields prefix={prefix} />
        <div className="staff-actions">
          <button className="primary" disabled={pending}>{pending ? "Recording…" : "Record leave"}</button>
        </div>
        {state.error && <p role="alert" className="form-error">{state.error}</p>}
      </form>
      {/* Outside the re-keyed form, so the live region stays in place between submissions. */}
      <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
    </>}
  </>;
}
