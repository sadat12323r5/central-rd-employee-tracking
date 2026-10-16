import { describe, expect, it } from "vitest";
import * as session from "../src/server/session";

describe("session module", () => {
  it("no longer issues or reads HMAC demo sessions", () => {
    expect(Object.keys(session).sort()).toEqual(["ownRecordIdentity", "sessionHours"]);
    expect("createSession" in session).toBe(false);
    expect("readSession" in session).toBe(false);
  });

  it("keeps the 12-hour staff and 8-hour Administrator session lengths", () => {
    expect(session.sessionHours({ role: "staff", employeeId: "BS-1003" })).toBe(12);
    expect(session.sessionHours({ role: "admin" })).toBe(8);
  });

  it("gives a manager session (a Staff account) the 12-hour Staff length (Story 4.2)", () => {
    expect(session.sessionHours({ role: "manager", employeeId: "BS-1003", userId: "u-1" })).toBe(12);
  });

  describe("ownRecordIdentity (Story 4.10)", () => {
    it("keeps a staff session's own employee", () => {
      expect(session.ownRecordIdentity({ role: "staff", employeeId: "BS-1003" })).toEqual({ role: "staff", employeeId: "BS-1003" });
    });

    it("derives a staff identity for a manager, dropping the user id", () => {
      expect(session.ownRecordIdentity({ role: "manager", employeeId: "BS-1004", userId: "u-1" })).toEqual({ role: "staff", employeeId: "BS-1004" });
    });

    it("derives a staff identity for a linked Administrator", () => {
      expect(session.ownRecordIdentity({ role: "admin", employeeId: "BS-1005" })).toEqual({ role: "staff", employeeId: "BS-1005" });
    });

    it("is null for an unlinked Administrator or no session", () => {
      expect(session.ownRecordIdentity({ role: "admin" })).toBeNull();
      expect(session.ownRecordIdentity({ role: "admin", employeeId: "" })).toBeNull();
      expect(session.ownRecordIdentity(null)).toBeNull();
      expect(session.ownRecordIdentity(undefined)).toBeNull();
    });
  });
});
