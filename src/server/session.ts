import { createHmac, timingSafeEqual } from "node:crypto";

const EMPLOYEE_ID = /^BS-\d{4}$/;

export type SessionIdentity = { role: "admin" } | { role: "staff"; employeeId: string };

/** Staff sessions cover a full working day plus overtime, so clock-out never needs a re-login. */
export function sessionHours(identity: SessionIdentity): number {
  return identity.role === "staff" ? 12 : 8;
}

export function createSession(secret: string, now = Date.now(), identity: SessionIdentity = { role: "admin" }): string {
  const payload = Buffer.from(JSON.stringify({ ...identity, expires: now + sessionHours(identity) * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

/** Returns the signed-in identity, or null for a missing, tampered, expired or unknown session. */
export function readSession(token: string | undefined, secret: string, now = Date.now()): SessionIdentity | null {
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
    if (session.role === "admin") return { role: "admin" };
    if (session.role === "staff" && typeof session.employeeId === "string" && EMPLOYEE_ID.test(session.employeeId)) {
      return { role: "staff", employeeId: session.employeeId };
    }
    return null;
  } catch { return null; }
}

/** True only for a valid manager (admin) session. */
export function verifySession(token: string | undefined, secret: string, now = Date.now()): boolean {
  return readSession(token, secret, now)?.role === "admin";
}
