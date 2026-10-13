import { formatDisplayDateTime } from "@/domain/dates";

// Shared states of the LMS-backed "Current" training views (Story 3.2), used by the staff portal and
// the Administrator's views so loading, stale and unavailable look and read the same everywhere.

/** Shown while the LMS read is pending (history is already on screen). */
export function CurrentLoading() {
  return <p role="status" className="muted">Loading current enrolments…</p>;
}

/** The LMS could not be reached: say so plainly instead of showing an empty or partial list. */
export function CurrentUnavailable({ history = "Completed training is still shown." }: { history?: string }) {
  return <p role="alert" className="form-error">Current enrolments are unavailable right now. {history} Please refresh the page in a moment.</p>;
}

/** Stale LMS data is labelled in text (not only colour), with the time it dates from (Asia/Dhaka). */
export function StaleNote({ asOf }: { asOf: string }) {
  return <p className="lms-stale"><span className="badge amber"><span className="dot" />Stale</span>{" "}
    <span>as of {formatDisplayDateTime(asOf)}</span> <small className="muted">· the LMS has not synced since then</small></p>;
}
