import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTimeline, narrate, type TimelineEvent } from "../sim/timeline";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: TimelineEvent = { seq: 1, day: "2026-08-03", at: "2026-08-03T03:05:00.000Z", actor: "Rafiq Ahmed", kind: "action", text: "Clocked in." };

describe("simulation timeline (Story 9.1)", () => {
  it("narrates each kind as one markdown line in Dhaka time", () => {
    expect(narrate(base)).toBe("- **2026-08-03 09:05** Rafiq Ahmed: Clocked in.");
    expect(narrate({ ...base, kind: "refusal", text: "You are already\nclocked in today." }))
      .toBe("- **2026-08-03 09:05** Rafiq Ahmed: **Refused:** You are already clocked in today.");
    expect(narrate({ ...base, kind: "refusal", text: "Unavailable.", detail: { cause: "42501 new row violates\nrow-level security" } }))
      .toBe("- **2026-08-03 09:05** Rafiq Ahmed: **Refused:** Unavailable. (42501 new row violates row-level security)");
    expect(narrate({ ...base, kind: "holiday", actor: "simulator", text: "Public holiday." })).toBe("- **2026-08-03 09:05** _Holiday:_ Public holiday.");
    expect(narrate({ ...base, kind: "day", actor: "simulator", text: "Day 1 of 37." })).toBe("- **2026-08-03 09:05** Day 1 of 37.");
    expect(narrate({ ...base, kind: "provisioned", day: null, text: "Cohort." })).toBe("- **2026-08-03 09:05** _Setup:_ Cohort.");
    expect(narrate({ ...base, kind: "end", text: "Done." })).toBe("- **2026-08-03 09:05** _End:_ Done.");
  });

  it("appends one JSON line and one narrated line per event, numbered in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-timeline-"));
    dirs.push(dir);
    const out = join(dir, "c00ab12");
    const timeline = createTimeline(out);
    const { seq: _seq, ...event } = base;
    expect(timeline.record(event).seq).toBe(1);
    timeline.record({ ...event, kind: "refusal", text: "No.", detail: { command: "clockIn" } });
    timeline.close();
    const lines = readFileSync(join(out, "timeline.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines).toEqual([{ ...base }, { ...base, seq: 2, kind: "refusal", text: "No.", detail: { command: "clockIn" } }]);
    expect(readFileSync(join(out, "timeline.md"), "utf8").trim().split("\n")).toEqual(timeline.events().map(narrate));
    expect(() => timeline.record(event)).toThrow(/closed/);
  });
});
