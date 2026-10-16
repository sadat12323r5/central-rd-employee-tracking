"use client";

import { useActionState } from "react";
import type { Assignment, AssignmentEvaluation, BackfilledProject } from "@/data/employees";
import { formatDisplayDate, formatDisplayDay } from "@/domain/dates";
import { amendEvaluationAction, createEvaluationAction } from "@/server/assignment-evaluation-actions";
import { closeAssignmentAction, createAssignmentAction, updateAssignmentNoteAction } from "@/server/assignment-actions";
import type { ActionState } from "@/server/attendance-actions";
import EvaluationView from "./evaluation-view";
import ProvenanceLabel from "./provenance-label";

// Story 4.5: the profile's Current work tab in the management portal (Administrator or a manager over
// the employee's department). It shows the open assignment, with forms to edit its latest-update note and
// to close it, or, when nothing is open, a form to create one; then the history of closed assignments,
// read-only. The department is never chosen here: the server copies the employee's own.
// Story 4.6: each closed assignment shows its evaluation (with the client's feedback and its authorship)
// and a form to write it or, once written, to amend it. The open assignment is never offered one.
// Story 4.7: the history also lists the employee's self-reported past projects, mixed with the closed
// assignments, newest completion first. Each row carries a text marker read from its materialized
// `provenance` ("Manager-created" or "Self-reported"), plus "Withdrawn" where it applies. Past projects
// are read-only here: no edit, withdraw or evaluation control (only their owner changes them).

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

/** The note and close forms keep their refused value too, so a refusal never throws away what was typed. */
type KeptState = Stamped & { kept?: string; attempt: number };
const keptInitial: KeptState = { ...initial, attempt: 0 };

async function submitNote(previous: KeptState, form: FormData): Promise<KeptState> {
  const result = await updateAssignmentNoteAction(previous, form);
  const value = form.get("note");
  return { ...result, at: stamp(), kept: result.error && typeof value === "string" ? value : undefined, attempt: previous.attempt + 1 };
}

async function submitClose(previous: KeptState, form: FormData): Promise<KeptState> {
  const result = await closeAssignmentAction(previous, form);
  const value = form.get("completionDate");
  return { ...result, at: stamp(), kept: result.error && typeof value === "string" ? value : undefined, attempt: previous.attempt + 1 };
}

function StatusLabel({ status }: { status: Assignment["status"] }) {
  return status === "open"
    ? <span className="badge green"><span className="dot" />Open</span>
    : <span className="badge withdrawn"><span className="dot" />Closed</span>;
}

const date = formatDisplayDate;

/** Story 4.7: one history row, a closed assignment or a backfilled project, told apart by its stored provenance. */
type HistoryRow = Assignment | BackfilledProject;

/** Newest completion first; ties by creation time (newest first), then id. */
function compareHistory(a: HistoryRow, b: HistoryRow): number {
  const byCompletion = (b.completionDate ?? "").localeCompare(a.completionDate ?? "");
  if (byCompletion !== 0) return byCompletion;
  const byCreated = b.createdAt.localeCompare(a.createdAt);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

/** Story 4.7: a self-reported past project, read-only in the management portal. */
function BackfilledRow({ project }: { project: BackfilledProject }) {
  return <>
    <div className="panel-title">
      <h3>{project.projectName}</h3>
      <span className="history-markers">
        <ProvenanceLabel provenance={project.provenance} />
        {project.status === "withdrawn" && <span className="badge withdrawn"><span className="dot" />Withdrawn</span>}
      </span>
    </div>
    <p>{project.client}</p>
    <small>Completed {date(project.completionDate)} · {project.departmentName}</small>
    {/* A withdrawal stamps updated_at and withdrawn_at with the same database time: that is not an edit. */}
    {project.updatedAt !== project.createdAt && project.updatedAt !== project.withdrawnAt && <small className="spaced">Edited {formatDisplayDay(project.updatedAt)}</small>}
    <div className="callout backfill-outcome">{project.outcome}</div>
  </>;
}

/** The evaluation form's result; a refused entry is kept so it can be shown again. */
type EvaluationState = ActionState & { values?: { evaluation: string; clientFeedback: string }; attempt: number };
const evaluationInitial: EvaluationState = { error: "", message: "", attempt: 0 };

async function submitEvaluation(previous: EvaluationState, form: FormData): Promise<EvaluationState> {
  const write = form.get("mode") === "amend" ? amendEvaluationAction : createEvaluationAction;
  const result = await write({ error: previous.error, message: previous.message }, form);
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    ...result, attempt: previous.attempt + 1,
    values: result.error ? { evaluation: text("evaluation"), clientFeedback: text("clientFeedback") } : undefined,
  };
}

/**
 * Story 4.6: a closed assignment's evaluation, then the form to write it (none yet) or amend it. The
 * form names only the assignment; the server takes the employee, department and author from elsewhere.
 */
function ClosedEvaluation({ assignment, evaluation }: {
  assignment: Assignment; evaluation: AssignmentEvaluation | undefined;
}) {
  const [state, submit, saving] = useActionState(submitEvaluation, evaluationInitial);
  const mode = evaluation ? "amend" : "create";
  const id = (suffix: string) => `evaluation-${suffix}-${assignment.id}`;
  const label = evaluation ? "Amend evaluation" : "Write evaluation";
  return <div className="assignment-evaluation">
    <EvaluationView evaluation={evaluation} projectName={assignment.projectName} />
    {state.error ? <p role="alert" className="form-error">{state.error}</p> : state.message ? <p role="status" className="staff-status">{state.message}</p> : null}
    <details key={mode} className="evaluation-editor">
      <summary>{label}</summary>
      <form key={`${mode}-${state.attempt}-${evaluation?.updatedAt ?? ""}`} action={submit} className="staff-log"
        aria-label={`${label} for ${assignment.projectName}`}>
        <input type="hidden" name="assignmentId" value={assignment.id} />
        <input type="hidden" name="mode" value={mode} />
        <div className="staff-field">
          <label htmlFor={id("text")}>Evaluation</label>
          <textarea id={id("text")} name="evaluation" maxLength={4000} rows={4} required
            defaultValue={state.values?.evaluation ?? evaluation?.evaluation ?? ""} />
        </div>
        <div className="staff-field">
          <label htmlFor={id("feedback")}>Client feedback (optional)</label>
          <textarea id={id("feedback")} name="clientFeedback" maxLength={2000} rows={3}
            defaultValue={state.values?.clientFeedback ?? evaluation?.clientFeedback ?? ""} />
        </div>
        <div className="staff-actions">
          <button className="primary" disabled={saving}>{saving ? "Saving…" : evaluation ? "Save amendment" : "Save evaluation"}</button>
        </div>
      </form>
    </details>
  </div>;
}

export default function AssignmentsPanel({ employeeId, name, assignments, departmentName, evaluations = [], backfilledProjects = [] }: {
  employeeId: string;
  /** The employee's name, for labels. */
  name: string;
  /** The employee's assignments as assignments-store returns them: the open one first, then history. */
  assignments: Assignment[];
  /** The department's display name. */
  departmentName: (id: string) => string;
  /** Story 4.6: the employee's assignment evaluations (joined to closed assignments by id). */
  evaluations?: AssignmentEvaluation[];
  /** Story 4.7: the employee's self-reported past projects (withdrawn ones included), read-only here. */
  backfilledProjects?: BackfilledProject[];
}) {
  const [created, create, creating] = useActionState(submitCreate, createInitial);
  const [noted, note, noting] = useActionState(submitNote, keptInitial);
  const [closed, close, closing] = useActionState(submitClose, keptInitial);
  const open = assignments.find(a => a.status === "open");
  const history: HistoryRow[] = [...assignments.filter(a => a.status === "closed"), ...backfilledProjects].sort(compareHistory);
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
        <form key={`note-${open.id}-${open.latestUpdate}-${noted.attempt}`} action={note} className="staff-log" aria-label="Edit the latest update">
          <input type="hidden" name="id" value={open.id} />
          <div className="staff-field">
            <label htmlFor={ids("note")}>Latest update</label>
            <textarea id={ids("note")} name="note" maxLength={2000} rows={3} defaultValue={noted.kept ?? open.latestUpdate} />
          </div>
          <div className="staff-actions"><button className="primary" disabled={noting}>{noting ? "Saving…" : "Save update"}</button></div>
        </form>
        <form key={`close-${open.id}-${closed.attempt}`} action={close} className="staff-log" aria-label="Close the assignment">
          <input type="hidden" name="id" value={open.id} />
          <div className="staff-field">
            <label htmlFor={ids("completion")}>Completion date</label>
            <input id={ids("completion")} name="completionDate" type="date" min={open.startDate} required defaultValue={closed.kept} />
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
      <h2 id={ids("history-heading")}>Work history</h2>
      <p className="muted">Closed assignments and self-reported past projects, newest completion first. Kept for the record.</p>
      {history.length === 0 ? <p className="muted">No closed assignments or past projects yet.</p> : <ul className="assignment-history" aria-labelledby={ids("history-heading")}>
        {history.map(row => <li key={`${row.provenance}-${row.id}`} className="interview-detail">
          {row.provenance === "backfilled" ? <BackfilledRow project={row} /> : <>
            <div className="panel-title">
              <h3>{row.projectName}</h3>
              <span className="history-markers"><ProvenanceLabel provenance={row.provenance} /><StatusLabel status="closed" /></span>
            </div>
            <p>{row.role} · {row.client} · {row.allocation}%</p>
            <small>{date(row.startDate)} – {date(row.completionDate ?? "")} · {departmentName(row.departmentId)}</small>
            {row.latestUpdate && <div className="callout">{row.latestUpdate}</div>}
            <ClosedEvaluation assignment={row} evaluation={evaluations.find(e => e.assignmentId === row.id)} />
          </>}
        </li>)}
      </ul>}
    </article>
  </div>;
}
