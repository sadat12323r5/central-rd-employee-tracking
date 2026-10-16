export type SessionIdentity =
  | { role: "admin" }
  | { role: "manager"; employeeId: string; userId: string }
  | { role: "staff"; employeeId: string };

export type StaffIdentity = Extract<SessionIdentity, { role: "staff" }>;
export type ManagerIdentity = Extract<SessionIdentity, { role: "manager" }>;

// Administrators and Staff both sign in through Supabase Auth (see auth.ts); the session is the
// Supabase auth cookie and the identity comes from the user's `app_metadata` (`role`, and for staff
// `employee_id`), which only the service role can set.
//
// `manager` (Story 4.2) is never stored: auth.ts derives it on every request for a valid Staff account
// whose auth user manages at least one department. An Administrator account is always `admin`.
// Story 4.3: a manager identity carries the validated auth `userId`, which manager-scope uses to work out
// the manager's departments fresh on each request (never from the token, never cached).

/**
 * Staff sessions cover a full working day plus overtime; Administrator sessions last 8 hours (FR-SESS-002).
 * A manager's account is a Staff account, so a manager session has the Staff length.
 */
export function sessionHours(identity: SessionIdentity): number {
  return identity.role === "admin" ? 8 : 12;
}
