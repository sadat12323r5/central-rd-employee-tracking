"use client";

import { useActionState } from "react";
import { formatDisplayDateTime } from "@/domain/dates";
import { formatYears } from "@/domain/holiday-calendar";
import type { ActionState } from "@/server/attendance-actions";
import { loadHolidayCalendarAction } from "@/server/holiday-calendar-actions";
import type { CalendarVersion } from "@/server/holiday-calendar-store";

const initial: ActionState = { error: "", message: "" };
const holidays = (n: number) => `${n} ${n === 1 ? "holiday" : "holidays"}`;

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <p role="alert" className="form-error">{state.error}</p>;
  return <p role="status" className="staff-status">{state.message}</p>;
}

function ActiveVersion({ version }: { version: CalendarVersion }) {
  return <dl className="details" aria-label="Active holiday calendar">
    <div><dt>Version</dt><dd>Version {version.version} (active)</dd></div>
    <div><dt>Jurisdiction</dt><dd>{version.jurisdiction}</dd></div>
    <div><dt>Timezone</dt><dd>{version.timezone}</dd></div>
    <div><dt>Supported years</dt><dd>{formatYears(version.supportedYearStart, version.supportedYearEnd)}</dd></div>
    <div><dt>Holidays</dt><dd>{holidays(version.holidayCount)}</dd></div>
    <div><dt>Loaded</dt><dd>{formatDisplayDateTime(version.loadedAt)}</dd></div>
    <div><dt>Source</dt><dd>{version.source}</dd></div>
  </dl>;
}

function EarlierVersions({ versions }: { versions: CalendarVersion[] }) {
  return <section aria-labelledby="holiday-calendar-earlier-heading">
    <h3 id="holiday-calendar-earlier-heading">Earlier versions</h3>
    <p className="muted">Kept unchanged, so leave counted with them stays explainable.</p>
    <div className="table-scroll">
      <table aria-label="Earlier holiday calendar versions">
        <thead><tr><th>Version</th><th>Jurisdiction</th><th>Years</th><th>Holidays</th><th>Loaded</th><th>Source</th></tr></thead>
        <tbody>{versions.map(v => <tr key={v.id}>
          <td>Version {v.version}</td><td>{v.jurisdiction}</td><td>{formatYears(v.supportedYearStart, v.supportedYearEnd)}</td>
          <td>{v.holidayCount}</td><td>{formatDisplayDateTime(v.loadedAt)}</td><td>{v.source}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function LoadCalendar() {
  const [state, action, pending] = useActionState(loadHolidayCalendarAction, initial);
  return <form action={action} className="staff-log" aria-labelledby="holiday-calendar-load-heading">
    <h3 id="holiday-calendar-load-heading">Load a holiday calendar</h3>
    <p className="muted">
      CSV files with the header <code>date,name,kind</code> (kind: general, executive order or special). Load every year
      the calendar should cover together, for example the 2026 and 2027 files. Each load becomes a new version.
    </p>
    <div className="staff-field">
      <label htmlFor="holiday-calendar-files">Calendar files (.csv)</label>
      <input id="holiday-calendar-files" name="files" type="file" multiple accept=".csv" />
    </div>
    <div className="staff-field">
      <label htmlFor="holiday-calendar-jurisdiction">Jurisdiction</label>
      <input id="holiday-calendar-jurisdiction" name="jurisdiction" maxLength={100} required defaultValue="Bangladesh" />
    </div>
    <p className="muted">Timezone: Asia/Dhaka</p>
    <div className="staff-actions">
      <button className="primary" disabled={pending}>{pending ? "Loading…" : "Load calendar"}</button>
    </div>
    <Feedback state={state} />
  </form>;
}

/**
 * Story 5.1, Administrator only: the active holiday calendar version, earlier versions and the load form.
 * `versions` is newest first; null means the calendar could not be read (never shown as "none loaded").
 */
export default function HolidayCalendarPanel({ versions }: { versions: CalendarVersion[] | null }) {
  const [active, ...earlier] = versions ?? [];
  return <section className="panel holiday-calendar-panel" aria-labelledby="holiday-calendar-heading">
    <h2 id="holiday-calendar-heading">Holiday calendar</h2>
    <p className="muted">Leave is counted in working days: Monday to Friday, excluding the active calendar&apos;s holidays.</p>
    {versions === null
      ? <p role="alert" className="form-error">The holiday calendar is unavailable right now, so the stored versions can&apos;t be shown. Please refresh the page in a moment.</p>
      : active
        ? <><ActiveVersion version={active} />{earlier.length > 0 && <EarlierVersions versions={earlier} />}</>
        : <p className="muted">No holiday calendar has been loaded yet.</p>}
    <LoadCalendar />
  </section>;
}
