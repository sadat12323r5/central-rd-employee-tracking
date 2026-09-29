"use client";

import { useActionState, useEffect, useState } from "react";
import type { Employee } from "@/data/employees";
import {
  WORK_MODES, entryStatus, formatDuration, todaysEntry, workedMinutes, summariseEntries, type TimesheetEntry,
} from "@/domain/timesheet";
import { clockInAction, clockOutAction, saveLogAction, type ActionState } from "@/server/attendance-actions";
import { signOut } from "@/server/auth";

const initial: ActionState = { error: "", message: "" };
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });
const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Dhaka" });
const shortDate = (value: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

function elapsed(entry: TimesheetEntry, now: Date) {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(entry.clockIn)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <p role="alert" className="form-error">{state.error}</p>;
  return <p role="status" className="staff-status">{state.message}</p>;
}

type TaskRow = { key: number; description: string; hours: string; link: string };

export default function StaffAttendance({ employee, entries, serverNow }: { employee: Employee; entries: TimesheetEntry[]; serverNow: string }) {
  const [now, setNow] = useState(() => new Date(serverNow));
  const [inState, inAction, inPending] = useActionState(clockInAction, initial);
  const [outState, outAction, outPending] = useActionState(clockOutAction, initial);
  const [logState, logAction, logPending] = useActionState(saveLogAction, initial);

  const today = todaysEntry(entries, employee.id, now);
  const open = today && !today.clockOut;
  const missing = entries.filter(e => entryStatus(e, now) === "Missing clock-out");
  const week = summariseEntries(entries.slice(0, 7), now);

  const [tasks, setTasks] = useState<TaskRow[]>(() =>
    today?.log?.tasks.length
      ? today.log.tasks.map((t, i) => ({ key: i, description: t.description, hours: String(t.hours), link: t.link ?? "" }))
      : [{ key: 0, description: "", hours: "", link: "" }]);

  useEffect(() => {
    if (!open) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  function updateTask(key: number, field: "description" | "hours" | "link", value: string) {
    setTasks(rows => rows.map(r => (r.key === key ? { ...r, [field]: value } : r)));
  }
  function addTask() {
    setTasks(rows => [...rows, { key: Math.max(...rows.map(r => r.key)) + 1, description: "", hours: "", link: "" }]);
  }
  function removeTask(key: number) {
    setTasks(rows => (rows.length > 1 ? rows.filter(r => r.key !== key) : rows));
  }

  return <main className="staff-page">
    <header className="staff-header">
      <div className="brand"><span className="brand-mark">23</span><span>brain station <b>23</b><small>PEOPLE & DEVELOPMENT</small></span></div>
      <div className="staff-identity">
        <span className={`avatar ${employee.color}`}>{employee.initials}</span>
        <span><strong>{employee.name}</strong><small>{employee.title} · {employee.id}</small></span>
        <form action={signOut}><button className="secondary">Sign out</button></form>
      </div>
    </header>

    <div className="staff-content">
      <section className="panel staff-today" aria-labelledby="today-heading">
        <h1 id="today-heading">{longDate.format(now)}</h1>
        <p className="muted">Times are shown in Dhaka time (GMT+6).</p>

        {!today && <form action={inAction} className="staff-clock-form">
          <fieldset className="staff-modes">
            <legend>Where are you working today?</legend>
            {WORK_MODES.map((mode, i) => <label key={mode}><input type="radio" name="workMode" value={mode} defaultChecked={i === 0} />{mode}</label>)}
          </fieldset>
          <button className="primary staff-big-button" disabled={inPending}>{inPending ? "Clocking in…" : "Clock in"}</button>
          <Feedback state={inState} />
        </form>}

        {open && <form action={outAction} className="staff-clock-form">
          <p className="staff-timer" aria-label={`Time since clock-in: ${formatDuration(workedMinutes(today, now))}`}>{elapsed(today, now)}</p>
          <p className="muted">Clocked in at {clock.format(new Date(today.clockIn))} · {today.workMode}</p>
          <div className="staff-field staff-break">
            <label htmlFor="breakMinutes">Break taken (minutes)</label>
            <input id="breakMinutes" name="breakMinutes" type="number" min={0} step={1} inputMode="numeric" placeholder="0" />
          </div>
          <button className="primary staff-big-button" disabled={outPending}>{outPending ? "Clocking out…" : "Clock out"}</button>
          <Feedback state={outState} />
        </form>}

        {today?.clockOut && <div className="staff-done">
          <p className="staff-timer">{formatDuration(workedMinutes(today, now))}</p>
          <p className="muted">Worked today · {clock.format(new Date(today.clockIn))}–{clock.format(new Date(today.clockOut))}{today.breakMinutes ? ` · ${today.breakMinutes} min break` : ""} · {today.workMode}</p>
          <Feedback state={outState} />
        </div>}
      </section>

      {missing.length > 0 && <div className="callout" role="note">
        {missing.length === 1 ? "One earlier day is" : `${missing.length} earlier days are`} missing a clock-out ({missing.map(e => shortDate(e.date)).join(", ")}). Your manager will review and correct {missing.length === 1 ? "it" : "them"}.
      </div>}

      <section className="panel" aria-labelledby="log-heading">
        <h2 id="log-heading">Today's work log</h2>
        {!today ? <p className="muted">Clock in to start today's log.</p> : <form action={logAction} className="staff-log">
          <div className="staff-field">
            <label htmlFor="summary">What did you work on today?</label>
            <textarea id="summary" name="summary" rows={3} maxLength={2000} defaultValue={today.log?.summary ?? ""} required />
          </div>
          <fieldset className="staff-tasks">
            <legend>Tasks</legend>
            <p className="muted">Hours in quarter hours, for example 1.5. Links to pull requests or tickets are optional.</p>
            {tasks.map((task, i) => <div className="staff-task-row" key={task.key}>
              <div className="staff-field">
                <label htmlFor={`task-desc-${task.key}`}>Task {i + 1}</label>
                <input id={`task-desc-${task.key}`} name="taskDescription" value={task.description} onChange={e => updateTask(task.key, "description", e.target.value)} maxLength={300} />
              </div>
              <div className="staff-field staff-hours">
                <label htmlFor={`task-hours-${task.key}`}>Hours</label>
                <input id={`task-hours-${task.key}`} name="taskHours" type="number" min={0.25} step={0.25} inputMode="decimal" value={task.hours} onChange={e => updateTask(task.key, "hours", e.target.value)} />
              </div>
              <div className="staff-field">
                <label htmlFor={`task-link-${task.key}`}>Link</label>
                <input id={`task-link-${task.key}`} name="taskLink" type="url" placeholder="https://" value={task.link} onChange={e => updateTask(task.key, "link", e.target.value)} />
              </div>
              <button type="button" className="text-button staff-remove" onClick={() => removeTask(task.key)} disabled={tasks.length === 1} aria-label={`Remove task ${i + 1}`}>Remove</button>
            </div>)}
            {tasks.length < 8 && <button type="button" className="text-button" onClick={addTask}>Add task</button>}
          </fieldset>
          <div className="staff-field">
            <label htmlFor="blockers">Blockers or help needed (optional)</label>
            <textarea id="blockers" name="blockers" rows={2} maxLength={1000} defaultValue={today.log?.blockers ?? ""} />
          </div>
          <div className="staff-actions">
            <button className="primary" disabled={logPending}>{logPending ? "Saving…" : today.log ? "Update log" : "Save log"}</button>
            {today.log && <small>Last saved {clock.format(new Date(today.log.updatedAt))}</small>}
          </div>
          <Feedback state={logState} />
        </form>}
      </section>

      <section className="panel staff-history" aria-labelledby="history-heading">
        <div className="panel-title">
          <h2 id="history-heading">Recent days</h2>
          <small>{formatDuration(week.minutesWorked)} across {week.daysRecorded} {week.daysRecorded === 1 ? "day" : "days"}</small>
        </div>
        {entries.length === 0 ? <p className="muted">Your attendance history appears here after your first clock-in.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Date</th><th>Mode</th><th>In</th><th>Out</th><th>Break</th><th>Worked</th><th>Log</th><th>Status</th></tr></thead>
          <tbody>{entries.slice(0, 14).map(e => {
            const status = entryStatus(e, now);
            return <tr key={e.id}>
              <td>{shortDate(e.date)}</td><td>{e.workMode}</td>
              <td>{clock.format(new Date(e.clockIn))}</td><td>{e.clockOut ? clock.format(new Date(e.clockOut)) : "—"}</td>
              <td>{e.breakMinutes ? `${e.breakMinutes} min` : "—"}</td>
              <td>{e.clockOut ? formatDuration(workedMinutes(e, now)) : "—"}</td>
              <td>{e.log ? `${e.log.tasks.length} ${e.log.tasks.length === 1 ? "task" : "tasks"}` : "Not written"}</td>
              <td><span className={`badge ${status === "Completed" ? "green" : status === "Clocked in" ? "blue" : "rose"}`}><span className="dot" />{status}</span></td>
            </tr>;
          })}</tbody>
        </table></div>}
      </section>
      <p className="fine-print">Demonstration records are kept in server memory and reset when the server restarts.</p>
    </div>
  </main>;
}
