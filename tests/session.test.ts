import { describe, expect, it } from "vitest";
import * as session from "../src/server/session";

describe("session module", () => {
  it("no longer issues or reads HMAC demo sessions", () => {
    expect(Object.keys(session).sort()).toEqual(["sessionHours"]);
    expect("createSession" in session).toBe(false);
    expect("readSession" in session).toBe(false);
  });

  it("keeps the 12-hour staff and 8-hour Administrator session lengths", () => {
    expect(session.sessionHours({ role: "staff", employeeId: "BS-1003" })).toBe(12);
    expect(session.sessionHours({ role: "admin" })).toBe(8);
  });
});
