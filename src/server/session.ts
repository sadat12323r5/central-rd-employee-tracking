export type SessionIdentity = { role: "admin" } | { role: "staff"; employeeId: string };

export type StaffIdentity = Extract<SessionIdentity, { role: "staff" }>;

// Administrators and Staff both sign in through Supabase Auth (see auth.ts); the session is the
// Supabase auth cookie and the identity comes from the user's `app_metadata` (`role`, and for staff
// `employee_id`), which only the service role can set.

/** Staff sessions cover a full working day plus overtime; Administrator sessions last 8 hours (FR-SESS-002). */
export function sessionHours(identity: SessionIdentity): number {
  return identity.role === "staff" ? 12 : 8;
}
