import { describe, expect, it } from "vitest";
import { createSession, verifySession } from "../src/server/session";

describe("demo admin session", () => {
  const secret = "test-secret";
  const now = 1_000_000;
  it("accepts a signed unexpired session", () => {
    expect(verifySession(createSession(secret, now), secret, now + 1)).toBe(true);
  });
  it("rejects missing, malformed and tampered sessions", () => {
    expect(verifySession(undefined, secret, now)).toBe(false);
    expect(verifySession("not-a-session", secret, now)).toBe(false);
    const token = createSession(secret, now);
    expect(verifySession(`x${token}`, secret, now)).toBe(false);
    expect(verifySession(token, "different-secret", now)).toBe(false);
  });
  it("rejects an expired session", () => {
    expect(verifySession(createSession(secret, now), secret, now + 8 * 60 * 60 * 1000)).toBe(false);
  });
});
