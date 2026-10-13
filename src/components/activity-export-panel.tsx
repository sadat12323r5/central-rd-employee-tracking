"use client";

import { useActionState, useId, useState } from "react";
import { dhakaDate } from "@/domain/timesheet";
import { exportActivityAction, type ActivityExportState } from "@/server/activity-actions";

const PERIOD_OPTIONS = [
  ["this-week", "This week"],
  ["last-week", "Last week"],
  ["month", "Month"],
  ["year", "Year"],
  ["custom", "Custom range"],
  ["all", "All time"],
] as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const initial: ActivityExportState = { error: "", message: "" };

/** Hands the CSV text to the browser as a download. */
function save(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled, so the browser does not cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function submit(previous: ActivityExportState, form: FormData): Promise<ActivityExportState> {
  const result = await exportActivityAction({ error: previous.error, message: previous.message }, form);
  if (result.error || !result.csv || !result.filename) return { error: result.error || "Nothing was downloaded. Please try again.", message: "" };
  save(result.csv, result.filename);
  // The CSV is not kept in state once it has been saved.
  return { error: "", message: `Downloaded ${result.filename}.` };
}

/**
 * Administrator-only: download one employee's activity timeline (attendance, interviews, training and
 * LMS enrolments) for a chosen period as a CSV. The form sends only the Employee ID and the period;
 * the acting Administrator is taken from the session at the server, which also audits the export.
 */
export default function ActivityExportPanel({ employeeId }: { employeeId: string }) {
  const [state, action, pending] = useActionState(submit, initial);
  const id = useId();
  const today = dhakaDate(new Date());
  const [period, setPeriod] = useState<string>("this-week");
  const [year, month] = today.split("-");
  return (
    <article className="panel account-panel activity-export-panel">
      <h2>Download activity</h2>
      <p className="muted">Attendance, interviews, training and LMS enrolments in one CSV, one row per event. Every download is recorded in the audit log.</p>
      {state.message && <p role="status" className="notice">{state.message}</p>}
      <form action={action} className="account-form">
        <input type="hidden" name="employeeId" value={employeeId} />
        <div className="staff-field">
          <label htmlFor={`${id}-period`}>Period</label>
          <select id={`${id}-period`} name="period" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIOD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {period === "month" && (
          <div className="staff-field">
            <label htmlFor={`${id}-month`}>Month</label>
            <select id={`${id}-month`} name="month" defaultValue={String(Number(month))}>
              {MONTHS.map((name, i) => <option key={name} value={String(i + 1)}>{name}</option>)}
            </select>
          </div>
        )}
        {(period === "month" || period === "year") && (
          <div className="staff-field">
            <label htmlFor={`${id}-year`}>Year</label>
            <input id={`${id}-year`} name="year" type="number" inputMode="numeric" min={2000} max={9999} defaultValue={year} required />
          </div>
        )}
        {period === "custom" && (
          <>
            <div className="staff-field">
              <label htmlFor={`${id}-from`}>From</label>
              <input id={`${id}-from`} name="from" type="date" max={today} required />
            </div>
            <div className="staff-field">
              <label htmlFor={`${id}-to`}>To</label>
              <input id={`${id}-to`} name="to" type="date" max={today} required aria-describedby={`${id}-to-hint`} />
              <small id={`${id}-to-hint`}>Inclusive. The end date cannot be in the future.</small>
            </div>
          </>
        )}
        {state.error && <p role="alert" className="form-error">{state.error}</p>}
        <button className="secondary" disabled={pending}>{pending ? "Preparing…" : "Download activity"}</button>
      </form>
    </article>
  );
}
