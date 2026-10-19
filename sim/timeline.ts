import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dhakaClock } from "./calendar";

// Story 9.1: the run's timeline. Every event is appended as one JSON line to `timeline.jsonl` and one
// narrated markdown line to `timeline.md`, as it happens, so an interrupted run still leaves a readable
// record. Events never carry passwords or keys.

export type TimelineKind = "provisioned" | "day" | "holiday" | "action" | "refusal" | "end";

export type TimelineEvent = {
  /** 1, 2, 3... in recording order. */
  seq: number;
  /** The simulated ISO date the event belongs to; null outside the stepped days (provisioning). */
  day: string | null;
  /** The simulated instant (UTC ISO). */
  at: string;
  /** Who acted: a persona's name, or "simulator". */
  actor: string;
  kind: TimelineKind;
  text: string;
  detail?: Record<string, unknown>;
};

export type NewTimelineEvent = Omit<TimelineEvent, "seq">;

export interface Timeline {
  /** The directory the files are written to. */
  readonly dir: string;
  /** Appends the event (numbered in order) to both files and returns it. */
  record(event: NewTimelineEvent): TimelineEvent;
  /** The events recorded so far, in order. */
  events(): readonly TimelineEvent[];
  close(): void;
}

const KIND_LABEL: Record<TimelineKind, string> = {
  provisioned: "Setup", day: "Day", holiday: "Holiday", action: "", refusal: "Refused", end: "End",
};

/** One markdown line for the event. Pure. */
export function narrate(event: TimelineEvent): string {
  const when = `${event.day ?? event.at.slice(0, 10)} ${dhakaClock(event.at)}`;
  const text = event.text.replace(/\s+/g, " ").trim();
  switch (event.kind) {
    case "day":
      return `- **${when}** ${text}`;
    case "holiday":
      return `- **${when}** _Holiday:_ ${text}`;
    case "action":
      return `- **${when}** ${event.actor}: ${text}`;
    case "refusal": {
      // The database's own reason behind an "unavailable" refusal, when the driver recorded one.
      const cause = typeof event.detail?.cause === "string" ? ` (${event.detail.cause.replace(/\s+/g, " ").trim()})` : "";
      return `- **${when}** ${event.actor}: **${KIND_LABEL.refusal}:** ${text}${cause}`;
    }
    default:
      return `- **${when}** _${KIND_LABEL[event.kind]}:_ ${text}`;
  }
}

/** A timeline writing to `<dir>/timeline.jsonl` and `<dir>/timeline.md` (created or truncated now). */
export function createTimeline(dir: string): Timeline {
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, "timeline.jsonl");
  const md = join(dir, "timeline.md");
  writeFileSync(jsonl, "");
  writeFileSync(md, "");
  const recorded: TimelineEvent[] = [];
  let closed = false;
  return {
    dir,
    record(event) {
      if (closed) throw new Error("The timeline is closed.");
      const full: TimelineEvent = { seq: recorded.length + 1, ...event };
      appendFileSync(jsonl, `${JSON.stringify(full)}\n`);
      appendFileSync(md, `${narrate(full)}\n`);
      recorded.push(full);
      return full;
    },
    events: () => recorded,
    close() {
      closed = true;
    },
  };
}
