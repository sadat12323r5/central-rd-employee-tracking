"use client";

import { startTransition, useActionState, useId, useState, type FormEvent } from "react";
import { CSV_BOM } from "@/domain/csv";
import { dhakaDate } from "@/domain/timesheet";
import { exportActivityAction, exportAllActivityAction, type ActivityExportState } from "@/server/activity-actions";

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

/**
 * Hands the CSV text to the browser as a download. The UTF-8 BOM is restored when missing: a long action
 * result reaches the client as a separately decoded text chunk, and that decoding drops a leading BOM.
 */
function save(csv: string, filename: string) {
  const body = csv.startsWith(CSV_BOM) ? csv : CSV_BOM + csv;
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
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
  // A form with an Employee ID is the single export (Story 8.1); without one, the bulk export (Story 8.2).
  const exportAction = form.has("employeeId") ? exportActivityAction : exportAllActivityAction;
  const result = await exportAction({ error: previous.error, message: previous.message }, form);
  if (result.error || !result.csv || !result.filename) return { error: result.error || "Nothing was downloaded. Please try again.", message: "" };
  save(result.csv, result.filename);
  // The CSV is not kept in state once it has been saved.
  return { error: "", message: `Downloaded ${result.filename}.` };
}

/**
 * Administrator and department managers: download one employee's activity timeline (attendance, interviews, training and
 * LMS enrolments) for a chosen period as a CSV. The form sends only the Employee ID and the period;
 * the acting Administrator or department manager is taken from the session at the server, which also audits the export.
 * Without an `employeeId` (Story 8.2, on the directory) it is the bulk export of every employee, with an
 * "Include archived" checkbox.
 * With `manager` (Story 8.3) only the heading and the notes change: the bulk export covers the manager's
 * departments, and the panel says interviews are not included. The server enforces both, whatever the UI sends.
 */
export default function ActivityExportPanel({ employeeId, manager = false }: { employeeId?: string; manager?: boolean }) {
  const bulk = employeeId === undefined;
  const title = bulk ? (manager ? "Download activity (your departments)" : "Download activity (all employees)") : "Download activity";
  const [state, action, pending] = useActionState(submit, initial);
  // Submitted by hand rather than through `<form action>`, so React does not reset the form after the
  // action: the chosen period and the controlled "Include archived" box stay as the Administrator or department manager left them.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  const id = useId();
  const today = dhakaDate(new Date());
  const [period, setPeriod] = useState<string>("this-week");
  // Controlled, so React's form reset after the action does not silently untick it.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [year, month] = today.split("-");
  return (
    <article className="panel account-panel activity-export-panel">
      <h2>{title}</h2>
      <p className="muted">
        {manager
          ? bulk
            ? "Attendance, training and LMS enrolments of everyone in your departments and their sub-departments in one CSV, one row per event, sorted by employee then date. Archived employees are left out unless included. Every download is recorded in the audit log."
            : "Attendance, training and LMS enrolments in one CSV, one row per event. Every download is recorded in the audit log."
          : bulk
            ? "Every employee's attendance, interviews, training and LMS enrolments in one CSV, one row per event, sorted by employee then date. Archived employees are left out unless included. Every download is recorded in the audit log."
            : "Attendance, interviews, training and LMS enrolments in one CSV, one row per event. Every download is recorded in the audit log."}
      </p>
      {manager && <p className="muted">Interviews are not included in a department manager's export.</p>}
      {state.message && <p role="status" className="notice">{state.message}</p>}
      <form onSubmit={onSubmit} className="account-form">
        {!bulk && <input type="hidden" name="employeeId" value={employeeId} />}
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
        {bulk && (
          <div className="check-field">
            <input id={`${id}-archived`} name="includeArchived" type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} />
            <label htmlFor={`${id}-archived`}>Include archived</label>
          </div>
        )}
        {state.error && <p role="alert" className="form-error">{state.error}</p>}
        <button className="secondary" disabled={pending}>{pending ? "Preparing…" : title}</button>
      </form>
    </article>
  );
}
