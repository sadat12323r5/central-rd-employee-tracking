"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import type { LeaveRecord } from "@/data/employees";
import { formatDisplayDate } from "@/domain/dates";
import { categoryForWorkingDays } from "@/domain/leave";
import type { ActionState } from "@/server/attendance-actions";
import { recordLeaveAction } from "@/server/leave-actions";

/** `attempt` counts successful submissions: the form is re-keyed (cleared) only then. */
type CountedState = ActionState & { attempt: number };
const counted: CountedState = { error: "", message: "", attempt: 0 };

async function record(previous: CountedState, form: FormData): Promise<CountedState> {
  const result = await recordLeaveAction({ error: previous.error, message: previous.message }, form);
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

/**
 * Story 5.2: an employee's leave periods (newest start first, the order the store returns), each with its
 * working days and category, and "Cancelled" when cancelled. With `canEdit` (the employee on their own
 * record, the Administrator, or a manager for their subtree) it adds a "Record leave" form. The server
 * counts the working days and re-checks everything. Render with `key={employeeId}`.
 */
export default function LeavePanel({ employeeId, records, canEdit, own = false }: {
  employeeId: string; records: LeaveRecord[]; canEdit: boolean;
  /** True on the employee's own record (wording only). */
  own?: boolean;
}) {
  const [state, action, pending] = useActionState(record, counted);
  const prefix = `leave-${employeeId}`;
  return <>
    {records.length === 0 ? <p className="muted">{own ? "You have not recorded any leave yet." : "No leave has been recorded."}</p> : <div className="table-scroll"><table aria-label={own ? "Your leave" : "Recorded leave"}>
      <thead><tr><th>From</th><th>To</th><th>Working days</th><th>Category</th><th>Status</th></tr></thead>
      <tbody>{records.map(r => <tr key={r.id}>
        <td>{formatDisplayDate(r.startDate)}</td><td>{formatDisplayDate(r.endDate)}</td><td>{r.workingDays}</td>
        <td><Category workingDays={r.workingDays} /></td>
        <td>{r.cancelledAt ? <span className="badge withdrawn">Cancelled</span> : <span className="badge green"><span className="dot" />Recorded</span>}</td>
      </tr>)}</tbody>
    </table></div>}
    {canEdit && <>
      <form key={state.attempt} onSubmit={submitWith(action)} className="staff-log leave-form" aria-label="Record leave">
        <h3>Record leave</h3>
        <p className="muted">Working days exclude weekends (Saturday and Sunday) and holidays in the loaded holiday calendar. The category is assigned automatically.</p>
        <input type="hidden" name="employeeId" value={employeeId} />
        <div className="leave-dates">
          <div className="staff-field">
            <label htmlFor={`${prefix}-start`}>First day of leave</label>
            <input id={`${prefix}-start`} name="startDate" type="date" required />
          </div>
          <div className="staff-field">
            <label htmlFor={`${prefix}-end`}>Last day of leave</label>
            <input id={`${prefix}-end`} name="endDate" type="date" required />
          </div>
        </div>
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
