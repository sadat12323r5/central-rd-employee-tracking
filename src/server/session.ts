import { createHmac, timingSafeEqual } from "node:crypto";

const EMPLOYEE_ID = /^BS-\d{4}$/;

export type SessionIdentity = { role: "admin" } | { role: "staff"; employeeId: string };

export type StaffIdentity = Extract<SessionIdentity, { role: "staff" }>;

// Administrators sign in through Supabase Auth (see auth.ts). The HMAC cookie below now carries
// only the interim demo staff identity until Story 1.3 gives staff Supabase accounts; a token
// claiming `admin` (issued before Story 1.2) is treated as signed out.

/** Staff sessions cover a full working day plus overtime; Administrator sessions last 8 hours (FR-SESS-002). */
export function sessionHours(identity: SessionIdentity): number {
  return identity.role === "staff" ? 12 : 8;
}

export function createSession(secret: string, now: number, identity: StaffIdentity): string {
  const payload = Buffer.from(JSON.stringify({ ...identity, expires: now + sessionHours(identity) * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

/** Returns the signed-in staff identity, or null for a missing, tampered, expired, admin or unknown session. */
export function readSession(token: string | undefined, secret: string, now = Date.now()): StaffIdentity | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof session.expires !== "number" || session.expires <= now) return null;
    if (session.role === "staff" && typeof session.employeeId === "string" && EMPLOYEE_ID.test(session.employeeId)) {
      return { role: "staff", employeeId: session.employeeId };
    }
    return null;
  } catch { return null; }
}
