import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSession, readSession } from "../src/server/session";

const secret = "test-secret";
const now = 1_000_000;
const staff = { role: "staff", employeeId: "BS-1003" } as const;

/** Signs an arbitrary payload the way pre-Story-1.2 code did, to forge legacy tokens. */
function legacyToken(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

describe("HMAC demo session", () => {
  it("accepts a signed unexpired staff session", () => {
    expect(readSession(createSession(secret, now, staff), secret, now + 1)).toEqual(staff);
  });
  it("rejects missing, malformed and tampered sessions", () => {
    expect(readSession(undefined, secret, now)).toBeNull();
    expect(readSession("not-a-session", secret, now)).toBeNull();
    const token = createSession(secret, now, staff);
    expect(readSession(`x${token}`, secret, now)).toBeNull();
    expect(readSession(token, "different-secret", now)).toBeNull();
  });
  it("treats an old, validly signed admin token as signed out", () => {
    const token = legacyToken({ role: "admin", expires: now + 60_000 });
    expect(readSession(token, secret, now)).toBeNull();
  });
});
