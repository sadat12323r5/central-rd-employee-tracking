import { describe, expect, it } from "vitest";
import { createSession, readSession, sessionHours } from "../src/server/session";

describe("staff sessions", () => {
  const secret = "test-secret";
  const now = 1_000_000;
  it("round-trips a staff identity", () => {
    const token = createSession(secret, now, { role: "staff", employeeId: "BS-1003" });
    expect(readSession(token, secret, now + 1)).toEqual({ role: "staff", employeeId: "BS-1003" });
  });
  it("keeps the 12-hour staff and 8-hour Administrator session lengths", () => {
    expect(sessionHours({ role: "staff", employeeId: "BS-1003" })).toBe(12);
    expect(sessionHours({ role: "admin" })).toBe(8);
  });
  it("rejects malformed employee ids and expired staff sessions", () => {
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "../admin" }), secret, now + 1)).toBeNull();
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "BS-1003" }), secret, now + 12 * 60 * 60 * 1000)).toBeNull();
    expect(readSession(createSession(secret, now, { role: "staff", employeeId: "BS-1003" }), secret, now + 9 * 60 * 60 * 1000)).not.toBeNull();
  });
});
