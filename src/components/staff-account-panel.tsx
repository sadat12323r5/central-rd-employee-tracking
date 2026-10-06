"use client";

import { useActionState } from "react";
import { provisionStaffAccountAction } from "@/server/account-actions";
import type { ActionState } from "@/server/attendance-actions";

const initial: ActionState = { error: "", message: "" };

/**
 * Administrator-only: shows whether the employee has a sign-in account, or a form to create a Staff
 * account with an initial password. The account email is the employee's own primary email (set at
 * the server); the form sends only the Employee ID and the password.
 */
export default function StaffAccountPanel({ employeeId, name, hasAccount }: { employeeId: string; name: string; hasAccount: boolean }) {
  const [state, action, pending] = useActionState(provisionStaffAccountAction, initial);
  const created = hasAccount || Boolean(state.message);
  const passwordId = `initial-password-${employeeId}`;
  return (
    <article className="panel account-panel">
      <h2>Sign-in account</h2>
      {state.message && <p role="status" className="notice">{state.message}</p>}
      {created ? (
        <p className="account-state"><span className="badge green"><span className="dot" />Has a sign-in account</span></p>
      ) : (
        <form action={action} className="account-form">
          <p className="muted">{name} has no sign-in account yet. Set an initial password and pass it on outside the app; they sign in with their employee email.</p>
          <input type="hidden" name="employeeId" value={employeeId} />
          <div className="staff-field">
            <label htmlFor={passwordId}>Initial password</label>
            <input id={passwordId} name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required aria-describedby={`${passwordId}-hint`} />
            <small id={`${passwordId}-hint`}>12 to 72 characters.</small>
          </div>
          <div className="staff-field">
            <label htmlFor={`${passwordId}-confirm`}>Confirm initial password</label>
            <input id={`${passwordId}-confirm`} name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required />
          </div>
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <button className="primary" disabled={pending}>{pending ? "Creating account…" : "Create Staff account"}</button>
        </form>
      )}
    </article>
  );
}
