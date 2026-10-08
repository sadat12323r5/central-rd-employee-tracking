"use client";

import { useActionState } from "react";
import { archiveEmployeeAction, restoreEmployeeAction } from "@/server/account-actions";
import type { ActionState } from "@/server/attendance-actions";

type PanelState = ActionState & { archived?: boolean };

const initial: PanelState = { error: "", message: "" };

async function submit(previous: PanelState, form: FormData): Promise<PanelState> {
  const restoring = form.get("intent") === "restore";
  const result = await (restoring ? restoreEmployeeAction : archiveEmployeeAction)({ error: previous.error, message: previous.message }, form);
  // A success flips the state shown here at once; the refreshed page props agree after revalidation.
  return { ...result, archived: result.message ? !restoring : previous.archived };
}

/**
 * Administrator-only: archive an active employee (ends their sign-in access on their next request and
 * keeps every record) or restore an archived one. The form sends only the Employee ID; the acting
 * Administrator is taken from the session at the server.
 */
export default function AccountAccessPanel({ employeeId, archived: archivedProp }: { employeeId: string; archived: boolean }) {
  const [state, action, pending] = useActionState(submit, initial);
  const archived = state.archived ?? archivedProp;
  return (
    <article className="panel account-panel">
      <h2>Account access</h2>
      {state.message && <p role="status" className="notice">{state.message}</p>}
      {archived ? (
        <form action={action} className="account-form">
          <p className="account-state"><span className="badge amber"><span className="dot" />Archived</span></p>
          <p className="muted">This person cannot sign in. Their records are kept. Restoring gives them sign-in access again.</p>
          <input type="hidden" name="employeeId" value={employeeId} />
          <input type="hidden" name="intent" value="restore" />
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <button className="secondary" disabled={pending}>{pending ? "Restoring…" : "Restore employee"}</button>
        </form>
      ) : (
        <form action={action} className="account-form">
          <p className="muted">Archiving ends this person&apos;s sign-in access immediately. Their records are kept and can be restored.</p>
          <input type="hidden" name="employeeId" value={employeeId} />
          <input type="hidden" name="intent" value="archive" />
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <button className="secondary" disabled={pending}>{pending ? "Archiving…" : "Archive employee"}</button>
        </form>
      )}
    </article>
  );
}
