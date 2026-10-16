"use client";

import { useActionState, useId } from "react";
import type { Department } from "@/domain/departments";
import type { ActionState } from "@/server/attendance-actions";
import { transferEmployeeAction } from "@/server/employee-actions";

type PanelState = ActionState & { departmentId?: string | null; attempt: number };

const initial: PanelState = { error: "", message: "", attempt: 0 };

async function submit(previous: PanelState, form: FormData): Promise<PanelState> {
  const result = await transferEmployeeAction({ error: previous.error, message: previous.message }, form);
  const to = form.get("toDepartmentId");
  // A success shows the new department at once; the refreshed page props agree after revalidation.
  return {
    ...result,
    departmentId: result.message && typeof to === "string" ? to : previous.departmentId,
    attempt: previous.attempt + 1,
  };
}

/**
 * Story 4.8: the profile's "Department" panel for the Administrator and department managers. It shows the
 * employee's current department and offers every other department the portal lists for this session (all
 * of them for the Administrator, the manager's subtree for a manager, which is where a manager has
 * destination authority). The form sends only the Employee ID and the destination; the server checks the
 * actor's authority over both departments and refuses a move while an assignment is open.
 */
export default function TransferPanel({ employeeId, departments, departmentId: departmentProp }: {
  employeeId: string; departments: Department[]; departmentId: string | null | undefined;
}) {
  const [state, action, pending] = useActionState(submit, initial);
  const id = useId();
  const current = state.departmentId !== undefined ? state.departmentId : (departmentProp ?? null);
  const currentName = current ? departments.find(d => d.id === current)?.name : undefined;
  const options = departments.filter(d => d.id !== current);
  return (
    <article className="panel account-panel" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Department</h2>
      <p className="account-state">{current ? `Department: ${currentName ?? "Unknown"}` : "No department"}</p>
      {state.message && <p role="status" className="notice">{state.message}</p>}
      {options.length === 0 ? (
        <p className="muted">There is no other department you can move this employee to.</p>
      ) : (
        <form key={state.attempt} action={action} className="account-form" aria-label="Transfer to another department">
          <input type="hidden" name="employeeId" value={employeeId} />
          <div className="staff-field">
            <label htmlFor={`${id}-to`}>Move to department</label>
            <select id={`${id}-to`} name="toDepartmentId" required defaultValue="">
              <option value="" disabled>Choose a department</option>
              {options.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <button className="secondary" disabled={pending}>{pending ? "Transferring…" : "Transfer employee"}</button>
        </form>
      )}
    </article>
  );
}
