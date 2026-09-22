import { createHmac, timingSafeEqual } from "node:crypto";

export function createSession(secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ role: "admin", expires: now + 8 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.role === "admin" && typeof session.expires === "number" && session.expires > now;
  } catch { return false; }
}
