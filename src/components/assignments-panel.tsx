"use client";

import { useActionState } from "react";
import type { Assignment } from "@/data/employees";
import { formatDisplayDate } from "@/domain/dates";
import { closeAssignmentAction, createAssignmentAction, updateAssignmentNoteAction } from "@/server/assignment-actions";
import type { ActionState } from "@/server/attendance-actions";

// Story 4.5: the profile's Current work tab in the management portal (Administrator or a manager over
// the employee's department). It shows the open assignment, with forms to edit its latest-update note and
// to close it, or, when nothing is open, a form to create one; then the history of closed assignments,
// read-only. The department is never chosen here: the server copies the employee's own.

/** A form's result, stamped so the panel can show the most recent one (forms unmount after a create or close). */
type Stamped = ActionState & { at: number };
const initial: Stamped = { error: "", message: "", at: 0 };

/** The create form also keeps a refused entry, so it can be shown again (React resets forms after an action). */
type CreateState = Stamped & { values: Record<string, string>; attempt: number };
const createInitial: CreateState = { ...initial, values: {}, attempt: 0 };

let clock = 0;
const stamp = () => ++clock;

async function submitCreate(previous: CreateState, form: FormData): Promise<CreateState> {
  const result = await createAssignmentAction({ error: previous.error, message: previous.message }, form);
  const values: Record<string, string> = {};
  if (result.error) {
    for (const key of ["client", "projectName", "role", "allocation", "startDate"]) {
      const value = form.get(key);
      values[key] = typeof value === "string" ? value : "";
    }
  }
  return { ...result, at: stamp(), values, attempt: previous.attempt + 1 };
}

async function submitNote(previous: Stamped, form: FormData): Promise<Stamped> {
  return { ...(await updateAssignmentNoteAction(previous, form)), at: stamp() };
}

async function submitClose(previous: Stamped, form: FormData): Promise<Stamped> {
  return { ...(await closeAssignmentAction(previous, form)), at: stamp() };
}

function StatusLabel({ status }: { status: Assignment["status"] }) {
  return status === "open"
    ? <span className="badge green"><span className="dot" />Open</span>
    : <span className="badge withdrawn"><span className="dot" />Closed</span>;
}

const date = formatDisplayDate;

export default function AssignmentsPanel({ employeeId, name, assignments, departmentName }: {
  employeeId: string;
  /** The employee's name, for labels. */
  name: string;
  /** The employee's assignments as assignments-store returns them: the open one first, then history. */
  assignments: Assignment[];
  /** The department's display name. */
  departmentName: (id: string) => string;
}) {
  const [created, create, creating] = useActionState(submitCreate, createInitial);
  const [noted, note, noting] = useActionState(submitNote, initial);
  const [closed, close, closing] = useActionState(submitClose, initial);
  const open = assignments.find(a => a.status === "open");
  const history = assignments.filter(a => a.status === "closed");
  const latest = [created, noted, closed].reduce((a, b) => (b.at > a.at ? b : a));
  const ids = (suffix: string) => `assignment-${suffix}-${employeeId}`;

  return <div className="detail-grid">
    <article className="panel" aria-labelledby={ids("current-heading")}>
      <span className="eyebrow">CURRENT ASSIGNMENT</span>
      {latest.error ? <p role="alert" className="form-error">{latest.error}</p> : <p role="status" className="staff-status">{latest.message}</p>}
      {open ? <>
        <div className="panel-title"><h2 id={ids("current-heading")}>{open.projectName}</h2><StatusLabel status="open" /></div>
        <dl className="details">
          <div><dt>Client</dt><dd>{open.client}</dd></div>
          <div><dt>Responsibility</dt><dd>{open.role}</dd></div>
          <div><dt>Client allocation</dt><dd>{open.allocation}%</dd></div>
          <div><dt>Start date</dt><dd>{date(open.startDate)}</dd></div>
          <div><dt>Department</dt><dd>{departmentName(open.departmentId)}</dd></div>
          <div><dt>Latest update</dt><dd>{open.latestUpdate || "No update yet."}</dd></div>
        </dl>
        <div className="assignment-forms">
        <form key={`note-${open.id}-${open.latestUpdate}`} action={note} className="staff-log" aria-label="Edit the latest update">
          <input type="hidden" name="id" value={open.id} />
          <div className="staff-field">
            <label htmlFor={ids("note")}>Latest update</label>
            <textarea id={ids("note")} name="note" maxLength={2000} rows={3} defaultValue={open.latestUpdate} />
          </div>
          <div className="staff-actions"><button className="primary" disabled={noting}>{noting ? "Saving…" : "Save update"}</button></div>
        </form>
        <form key={`close-${open.id}`} action={close} className="staff-log" aria-label="Close the assignment">
          <input type="hidden" name="id" value={open.id} />
          <div className="staff-field">
            <label htmlFor={ids("completion")}>Completion date</label>
            <input id={ids("completion")} name="completionDate" type="date" min={open.startDate} required />
          </div>
          <div className="staff-actions"><button className="secondary" disabled={closing}>{closing ? "Closing…" : "Close assignment"}</button></div>
        </form>
        </div>
      </> : <>
        <h2 id={ids("current-heading")}>No open assignment</h2>
        <p className="muted">{name} has no open assignment. Create one below; it is recorded under {name.split(" ")[0]}&apos;s department.</p>
        <form key={`create-${created.attempt}`} action={create} className="staff-log assignment-forms" aria-label="Create an assignment">
          <input type="hidden" name="employeeId" value={employeeId} />
          <div className="staff-field">
            <label htmlFor={ids("client")}>Client</label>
            <input id={ids("client")} name="client" maxLength={200} required defaultValue={created.values.client} />
          </div>
          <div className="staff-field">
            <label htmlFor={ids("project")}>Project name</label>
            <input id={ids("project")} name="projectName" maxLength={200} required defaultValue={created.values.projectName} />
          </div>
          <div className="staff-field">
            <label htmlFor={ids("role")}>Role</label>
            <input id={ids("role")} name="role" maxLength={200} required defaultValue={created.values.role} />
          </div>
          <div className="staff-field">
            <label htmlFor={ids("allocation")}>Allocation (%)</label>
            <input id={ids("allocation")} name="allocation" type="number" min={0} max={100} step={1} required defaultValue={created.values.allocation} />
          </div>
          <div className="staff-field">
            <label htmlFor={ids("start")}>Start date</label>
            <input id={ids("start")} name="startDate" type="date" required defaultValue={created.values.startDate} />
          </div>
          <div className="staff-actions"><button className="primary" disabled={creating}>{creating ? "Creating…" : "Create assignment"}</button></div>
        </form>
      </>}
    </article>
    <article className="panel" aria-labelledby={ids("history-heading")}>
      <h2 id={ids("history-heading")}>Assignment history</h2>
      <p className="muted">Closed assignments, newest completion first. Kept for the record; read-only.</p>
      {history.length === 0 ? <p className="muted">No closed assignments yet.</p> : <ul className="assignment-history" aria-label="Closed assignments">
        {history.map(a => <li key={a.id} className="interview-detail">
          <div className="panel-title"><h3>{a.projectName}</h3><StatusLabel status="closed" /></div>
          <p>{a.role} · {a.client} · {a.allocation}%</p>
          <small>{date(a.startDate)} – {date(a.completionDate ?? "")} · {departmentName(a.departmentId)}</small>
          {a.latestUpdate && <div className="callout">{a.latestUpdate}</div>}
        </li>)}
      </ul>}
    </article>
  </div>;
}
