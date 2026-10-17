export type SessionIdentity =
  | { role: "admin"; employeeId?: string }
  | { role: "manager"; employeeId: string; userId: string }
  | { role: "staff"; employeeId: string };

export type StaffIdentity = Extract<SessionIdentity, { role: "staff" }>;
export type ManagerIdentity = Extract<SessionIdentity, { role: "manager" }>;
export type AdminIdentity = Extract<SessionIdentity, { role: "admin" }>;

// Administrators and Staff both sign in through Supabase Auth (see auth.ts); the session is the
// Supabase auth cookie and the identity comes from the user's `app_metadata` (`role`, and for staff
// `employee_id`), which only the service role can set.
//
// `manager` (Story 4.2) is never stored: auth.ts derives it on every request for a valid Staff account
// whose auth user manages at least one department. An Administrator account is always `admin`.
// Story 4.3: a manager identity carries the validated auth `userId`, which manager-scope uses to work out
// the manager's departments fresh on each request (never from the token, never cached).
// Story 4.10: an admin identity carries `employeeId` only when its auth user is linked to exactly one
// non-archived employee row (looked up per request through RLS); that enables "My record".

/**
 * Staff sessions cover a full working day plus overtime; Administrator sessions last 8 hours (FR-SESS-002).
 * A manager's account is a Staff account, so a manager session has the Staff length.
 */
export function sessionHours(identity: SessionIdentity): number {
  return identity.role === "admin" ? 8 : 12;
}

/**
 * Story 4.10: the identity used for every own-record read and write ("My record" and the staff portal).
 * A staff session as is; a manager, or an admin linked to an employee row, as `{ role: "staff", employeeId }`
 * so the stores and RLS apply exactly the Staff own-record rules. Null for an unlinked admin or no session. Pure.
 */
export function ownRecordIdentity(session: SessionIdentity | null | undefined): StaffIdentity | null {
  if (!session) return null;
  if (session.role === "admin" && !session.employeeId) return null;
  const employeeId = session.employeeId;
  return typeof employeeId === "string" && employeeId !== "" ? { role: "staff", employeeId } : null;
}
