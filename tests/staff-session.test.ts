import { describe, expect, it } from "vitest";
import { createSession, readSession, verifySession } from "../src/server/session";

describe("staff sessions", () => {
  const secret = "test-secret";
  const now = 1_000_000;
  it("round-trips a staff identity", () => {
    const token = createSession(secret, now, { role: "staff", employeeId: "BS-1003" });
    expect(readSession(token, secret, now + 1)).toEqual({ role: "staff", employeeId: "BS-1003" });
  });
  it("does not treat a staff session as a manager session", () => {
    const token = createSession(secret, now, { role: "staff", employeeId: "BS-1003" });
    expect(verifySession(token, secret, now + 1)).toBe(false);
  });
  it("still reads admin sessions created without an identity", () => {
    expect(readSession(createSession(secret, now), secret, now + 1)).toEqual({ role: "admin" });
  });
  it("rejects malformed employee ids and expired staff sessions", () => {
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "../admin" }), secret, now + 1)).toBeNull();
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "BS-1003" }), secret, now + 12 * 60 * 60 * 1000)).toBeNull();
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "BS-1003" }), secret, now + 9 * 60 * 60 * 1000)).not.toBeNull();
  });
});
