"use client";

import { useActionState } from "react";
import { wouldCreateCycle, type Department } from "@/domain/departments";
import { createDepartmentAction, updateDepartmentAction } from "@/server/department-actions";
import type { ActionState } from "@/server/attendance-actions";

const initial: ActionState = { error: "", message: "" };
const TOP_LEVEL = "Top level";

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <p role="alert" className="form-error">{state.error}</p>;
  return <p role="status" className="staff-status">{state.message}</p>;
}

/**
 * The parent choices: "Top level" plus every department, except (for an existing department `exclude`)
 * itself and its own descendants, which the server would always reject as a cycle.
 */
function ParentSelect({ id, departments, exclude, defaultValue }: {
  id: string; departments: Department[]; exclude?: string; defaultValue: string;
}) {
  return <select id={id} name="parentId" defaultValue={defaultValue}>
    <option value="">{TOP_LEVEL}</option>
    {departments.filter(d => exclude === undefined || !wouldCreateCycle(departments, exclude, d.id)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
  </select>;
}

/** The add form's state: on a refusal it keeps what was submitted, so the form can show it again. */
type AddState = ActionState & { name: string; parentId: string; attempt: number };
const addInitial: AddState = { ...initial, name: "", parentId: "", attempt: 0 };

async function submitAdd(previous: AddState, form: FormData): Promise<AddState> {
  const result = await createDepartmentAction({ error: previous.error, message: previous.message }, form);
  const value = (key: string) => (typeof form.get(key) === "string" ? (form.get(key) as string) : "");
  // React resets the form after every action; a new key with these defaults restores a refused entry.
  return result.error
    ? { ...result, name: value("name"), parentId: value("parentId"), attempt: previous.attempt + 1 }
    : { ...result, name: "", parentId: "", attempt: previous.attempt + 1 };
}

function AddDepartment({ departments }: { departments: Department[] }) {
  const [state, action, pending] = useActionState(submitAdd, addInitial);
  return <form key={state.attempt} action={action} className="staff-log departments-add" aria-labelledby="departments-add-heading">
    <h3 id="departments-add-heading">Add a department</h3>
    <div className="staff-field">
      <label htmlFor="department-new-name">Department name</label>
      <input id="department-new-name" name="name" maxLength={100} required defaultValue={state.name} />
    </div>
    <div className="staff-field">
      <label htmlFor="department-new-parent">Parent department</label>
      <ParentSelect id="department-new-parent" departments={departments} defaultValue={state.parentId} />
    </div>
    <div className="staff-actions">
      <button className="primary" disabled={pending}>{pending ? "Adding…" : "Add department"}</button>
    </div>
    <Feedback state={state} />
  </form>;
}

function EditDepartment({ department, departments }: { department: Department; departments: Department[] }) {
  const [state, action, pending] = useActionState(updateDepartmentAction, initial);
  const key = department.id;
  return <details className="staff-interview-editor">
    <summary aria-label={`Edit department: ${department.name}`}>Edit</summary>
    <form action={action} className="staff-log">
      <input type="hidden" name="id" value={department.id} />
      <div className="staff-field">
        <label htmlFor={`department-name-${key}`}>Department name<span className="sr-only"> · {department.name}</span></label>
        <input id={`department-name-${key}`} name="name" maxLength={100} defaultValue={department.name} required />
      </div>
      <div className="staff-field">
        <label htmlFor={`department-parent-${key}`}>Parent department<span className="sr-only"> · {department.name}</span></label>
        <ParentSelect id={`department-parent-${key}`} departments={departments} exclude={department.id} defaultValue={department.parentId ?? ""} />
      </div>
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save department"}</button>
      </div>
      <Feedback state={state} />
    </form>
  </details>;
}

/**
 * Story 4.1, Administrator only: the department list with its parents, an add form and a per-row edit
 * form (name and parent). There is no delete control: departments are never removed.
 */
export default function DepartmentsPanel({ departments }: { departments: Department[] }) {
  const nameOf = (id: string | null) => (id === null ? TOP_LEVEL : departments.find(d => d.id === id)?.name ?? "Unknown department");
  return <section className="panel departments-panel" aria-labelledby="departments-heading">
    <h2 id="departments-heading">Department list</h2>
    <p className="muted">Every employee belongs to one department. Departments can be renamed or moved, but never deleted.</p>
    <div className="table-scroll">
      <table aria-label="Departments">
        <thead><tr><th>Department</th><th>Parent department</th><th><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{departments.map(d => <tr key={d.id}>
          <td><strong className="regular">{d.name}</strong></td>
          <td>{nameOf(d.parentId)}</td>
          <td><EditDepartment department={d} departments={departments} /></td>
        </tr>)}</tbody>
      </table>
      {departments.length === 0 && <p className="muted">No departments yet. Add the first one below.</p>}
    </div>
    <AddDepartment departments={departments} />
  </section>;
}
