"use client";

import { Suspense, use, useState, type ReactNode } from "react";
import type { Employee } from "@/data/employees";
import type { Department } from "@/domain/departments";
import { toCsv } from "@/domain/csv";
import { formatDisplayDate, formatDisplayDateTime } from "@/domain/dates";
import { signOut } from "@/server/auth";
import type { CurrentTraining } from "@/server/training-store";
import type { CalendarVersion } from "@/server/holiday-calendar-store";
import AccountAccessPanel from "./account-access-panel";
import ActivityExportPanel from "./activity-export-panel";
import AssignmentsPanel from "./assignments-panel";
import AddEmployeePanel from "./add-employee-panel";
import EmployeeDetailsPanel from "./employee-details-panel";
import EvaluationPanel from "./evaluation-panel";
import SkillRatingPanel from "./skill-rating-panel";
import { EvaluationSummary, hasEvaluation, NO_EVALUATION, SKILL_SCALE, SkillList } from "./assessment-summary";
import EmploymentHistoryPanel from "./employment-history-panel";
import { CurrentLoading, CurrentUnavailable, StaleNote } from "./current-training";
import DepartmentsPanel from "./departments-panel";
import HolidayCalendarPanel from "./holiday-calendar-panel";
import LeavePanel from "./leave-panel";
import TransferPanel from "./transfer-panel";
import StaffAccountPanel from "./staff-account-panel";
import { StaffSelfService, type StaffSelfServiceProps } from "./staff-attendance";

type Section = "Overview" | "Employees" | "Learning & development" | "Interviews & placements" | "Attendance & leave" | "Departments" | "My record";
type Show = "Active employees" | "Archived employees";
type Tab = "Overview" | "Employment" | "Training" | "Skills & evaluation" | "Current work" | "Interviews" | "Attendance";
const tabs: Tab[] = ["Overview", "Employment", "Training", "Skills & evaluation", "Current work", "Interviews", "Attendance"];
const paths: Record<string, string> = {
  Overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  Employees: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  "Learning & development": "m2 8 10-5 10 5-10 5z M6 10v7c4 3 8 3 12 0v-7 M22 8v8",
  "Interviews & placements": "M8 6V3h8v3 M3 7h18v14H3z M3 12c6 3 12 3 18 0 M10 12h4v4h-4z",
  "Attendance & leave": "M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2 M8 18h2",
  Departments: "M9 3h6v5H9z M12 8v4 M5 12h14 M5 12v4 M19 12v4 M2 16h6v5H2z M16 16h6v5h-6z",
  "My record": "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  search: "m21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
};
function Icon({ name }: { name: string }) { return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.Overview} /></svg>; }
function Avatar({ employee, large = false }: { employee: Employee; large?: boolean }) { return <span className={`avatar ${employee.color} ${large ? "large" : ""}`}>{employee.initials}</span>; }
function Badge({ children }: { children: string }) { return <span className={`badge ${children === "On project" || children.startsWith("Ready") || children === "Recorded" ? "green" : children === "In training" || children === "Scheduled" ? "blue" : children === "Not selected" || children === "Missing record" ? "rose" : children === "Withdrawn" ? "withdrawn" : "amber"}`}><span className="dot" />{children}</span>; }
function Empty({ message }: { message: string }) { return <div className="empty"><span>○</span><h3>Nothing here yet</h3><p>{message}</p></div>; }
// D MMM YYYY. Employees without fixture profile data have empty dates; show "Not recorded" instead of throwing.
const date = formatDisplayDate;
/** Staff report the outcome later (it starts empty), so an empty outcome still gets a text label. */
const outcomeLabel = (outcome: string) => outcome || "No outcome yet";

type Training = Employee["training"][number];
type TrainingWithEmployee = { employee: Employee; training: Training };

/** One training entry on the profile Training tab (completed or in progress). */
function TrainingRow({ t }: { t: Training }) {
  return <div className="training-row"><span className="course-icon"><Icon name="Learning & development" /></span><div className="grow"><h4>{t.name}</h4><p>{t.provider}</p><small>{t.progress === 100 ? "Completed" : "Target completion"}: {date(t.date)}</small><div className="progress-line"><progress value={t.progress} max={100} aria-label={`${t.name} completion`} /><small>{t.progress}%</small></div></div><Badge>{t.result}</Badge></div>;
}

function TrainingRows({ entries, empty }: { entries: Training[]; empty: string }) {
  return entries.length === 0 ? <p className="muted">{empty}</p> : <>{entries.map(t => <TrainingRow key={t.id} t={t} />)}</>;
}

function LearningMini({ entries }: { entries: Training[] }) {
  return <>{entries.map(t => <div className="learning-mini" key={t.id}><strong>{t.name}</strong><div className="progress-line"><progress value={t.progress} max={100} aria-label={`${t.name} completion`} /><small>{t.progress}%</small></div></div>)}</>;
}

/** The profile Overview's Learning journey: stored entries, then that employee's in-progress LMS enrolments. */
function JourneyWithLms({ current, stored, employeeId }: { current: Promise<CurrentTraining>; stored: Training[]; employeeId: string }) {
  const result = use(current);
  const inProgress = result.status === "ok" ? result.inProgress.filter(t => t.employeeId === employeeId) : [];
  return <LearningMini entries={[...stored, ...inProgress]} />;
}

/** Story 3.2: the profile's Current block (that employee's in-progress LMS enrolments and own freshness). */
function ProfileCurrent({ current, employeeId }: { current: Promise<CurrentTraining>; employeeId: string }) {
  const result = use(current);
  if (result.status === "unavailable") return <CurrentUnavailable />;
  const { asOf, stale } = result.freshness[employeeId] ?? result;
  return <>{stale && <StaleNote asOf={asOf} />}<TrainingRows entries={result.inProgress.filter(t => t.employeeId === employeeId)} empty="No current enrolments." /></>;
}

/** The profile's completed history: stored entries, then LMS-completed ones (deduplicated by training-store). */
function ProfileCompleted({ current, stored, employeeId }: { current: Promise<CurrentTraining>; stored: Training[]; employeeId: string }) {
  const result = use(current);
  const fromLms = result.status === "ok" ? result.lmsCompleted.filter(t => t.employeeId === employeeId) : [];
  return <TrainingRows entries={[...stored, ...fromLms]} empty="No completed training on record." />;
}

/** Org-wide rows, per employee: stored completed, then LMS-completed, then in progress. */
function orgTraining(employees: Employee[], result?: CurrentTraining): TrainingWithEmployee[] {
  return employees.flatMap(employee => {
    const own = <T extends { employeeId: string }>(list: T[]) => list.filter(t => t.employeeId === employee.id);
    const lms = result?.status === "ok" ? [...own(result.lmsCompleted), ...own(result.inProgress)] : [];
    return [...employee.training, ...lms].map(training => ({ employee, training }));
  });
}

function InProgressStat({ current, employees }: { current: Promise<CurrentTraining>; employees: Employee[] }) {
  const result = use(current);
  if (result.status === "unavailable") return <Stat label="Learning in progress" value="Unavailable" note="The LMS could not be reached" icon="Learning & development" />;
  const count = orgTraining(employees, result).filter(t => t.training.progress < 100).length;
  return <Stat label="Learning in progress" value={count} note={result.stale ? `Stale · as of ${formatDisplayDateTime(result.asOf)}` : "Active training enrolments"} icon="Learning & development" />;
}

function CompletedCount({ current, employees }: { current: Promise<CurrentTraining>; employees: Employee[] }) {
  const count = orgTraining(employees, use(current)).filter(t => t.training.progress === 100).length;
  return <>{count} completed training records</>;
}

/** Story 4.3: a manager's overview counts the departments in their subtree instead of the org-wide team note. */
const departmentCount = (n: number) => `Across ${n} ${n === 1 ? "department" : "departments"}`;

/** Sections and profile tabs a department manager never sees (Story 4.2). */
const MANAGER_HIDDEN_SECTIONS: readonly Section[] = ["Departments", "Interviews & placements"];
const MANAGER_HIDDEN_TABS: readonly Tab[] = ["Interviews"];

export default function Portal({ employees: all, departments = [], departmentNames, current, role = "admin", myRecord, holidayCalendars }: {
  employees: Employee[];
  /**
   * Story 4.2: who is using the management portal. A department manager does not get Departments,
   * Interviews & placements, the profile Interviews tab, the interview stat or the account controls.
   */
  role?: "admin" | "manager";
  /**
   * Story 4.1: the department list, joined to employees by id for the directory. Story 4.3: for a manager,
   * only the departments in their subtree.
   */
  departments?: Department[];
  /**
   * Story 4.8 (manager portal): every department's id and name, or null when unavailable. Only a name
   * fallback for records (e.g. past assignments) under a department outside `departments`; never choices.
   */
  departmentNames?: { id: string; name: string }[] | null;
  /** Story 3.2: LMS enrolments for every listed employee, streamed (always resolves; `unavailable` is a value). */
  current: Promise<CurrentTraining>;
  /**
   * Story 4.10: the signed-in account's own employee record, for an account linked to one (a manager, or a
   * linked Administrator). Read on the server under the Staff own-record rules. Without it there is no
   * "My record" navigation entry or section.
   */
  myRecord?: StaffSelfServiceProps;
  /**
   * Story 5.1 (Administrator only): the stored holiday calendar versions, newest first, or null when they
   * could not be read. Shown in Attendance & leave; never passed for a manager.
   */
  holidayCalendars?: CalendarVersion[] | null;
}) {
  // Archived employees (Story 1.4) are left out of every view, count and stat by default; the
  // directory's "Show" filter lists them on their own.
  const employees = all.filter(e => !e.archived);
  const archivedEmployees = all.filter(e => e.archived);
  const [section, setSection] = useState<Section>("Overview");
  const [picked, setSelected] = useState<Employee | null>(null);
  // The open profile reads from the refreshed props first, so a saved edit (Story 7.2) shows straight away.
  const selected = picked ? (all.find(e => e.id === picked.id) ?? picked) : null;
  const [tab, setTab] = useState<Tab>("Overview");
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("All teams");
  const [status, setStatus] = useState("All statuses");
  const [show, setShow] = useState<Show>("Active employees");
  const [notice, setNotice] = useState("");
  const directory = show === "Archived employees" ? archivedEmployees : employees;
  const visible = directory.filter(e => `${e.name} ${e.title} ${e.id} ${e.skills.map(s => s.name).join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (team === "All teams" || e.team === team) && (status === "All statuses" || e.status === status));
  // The "On your radar" demo rows point at specific fixture employees; skip a row when that employee is archived or absent.
  const radarNadia = employees.find(e => e.id === "BS-1001");
  const radarMeera = employees.find(e => e.id === "BS-1003");
  // Stored completed training, shown at once; LMS enrolments are added when `current` resolves.
  const trainings = orgTraining(employees);
  // Active views (org-wide list, "Upcoming interviews" stat) leave out withdrawn entries (Story 2.2).
  const interviews = employees.flatMap(employee => employee.interviews.filter(i => !i.withdrawn).map(interview => ({ employee, interview })));
  const totals = employees.reduce((a, e) => ({ worked: a.worked + e.attendance.worked, leave: a.leave + e.attendance.leave, missing: a.missing + e.attendance.unrecorded }), { worked: 0, leave: 0, missing: 0 });
  const activeInterviews = selected ? selected.interviews.filter(i => !i.withdrawn) : [];
  const withdrawnInterviews = selected ? selected.interviews.filter(i => i.withdrawn) : [];
  // Read from the refreshed props first, so the label follows an archive or restore.
  const selectedArchived = Boolean(selected && (all.find(e => e.id === selected.id)?.archived ?? selected.archived));
  // Story 4.5: assignments also come from the refreshed props, so a create, note edit or close shows at once.
  const selectedAssignments = selected ? (all.find(e => e.id === selected.id)?.assignments ?? selected.assignments) : [];
  const openAssignment = selectedAssignments.find(a => a.status === "open");
  // Story 4.6: evaluations too (their authorship labels come from the stored snapshot).
  const selectedEvaluations = selected ? (all.find(e => e.id === selected.id)?.evaluations ?? selected.evaluations ?? []) : [];
  const selectedBackfilled = selected ? (all.find(e => e.id === selected.id)?.backfilledProjects ?? selected.backfilledProjects ?? []) : [];
  const isManager = role === "manager";
  const sections = (Object.keys(paths).filter(k => k !== "search") as Section[])
    .filter(name => !isManager || !MANAGER_HIDDEN_SECTIONS.includes(name))
    .filter(name => name !== "My record" || Boolean(myRecord));
  const profileTabs = tabs.filter(t => !isManager || !MANAGER_HIDDEN_TABS.includes(t));
  const departmentName = (id: string | null | undefined) =>
    (id ? departments.find(d => d.id === id)?.name ?? departmentNames?.find(d => d.id === id)?.name : undefined) ?? "No department";
  function navigate(value: Section) { setSection(value); setSelected(null); setNotice(""); }
  function open(employee: Employee, nextTab: Tab = "Overview") { setSelected(employee); setTab(nextTab); setNotice(""); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function exportDirectory() {
    const rows = [["Employee ID", "Name", "Designation", "Team", "Status", "Email"], ...visible.map(e => [e.id, e.name, e.title, e.team, e.status, e.email])];
    const csv = toCsv(rows);
    const link = document.createElement("a"); const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" })); link.href = url; link.download = "bs23-demo-employees.csv"; link.click(); URL.revokeObjectURL(url); setNotice(`Exported ${visible.length} demo employee records.`);
  }
  const employeeTable = <div className="table-scroll"><table><thead><tr><th>Employee</th><th>Designation & team</th><th>Department</th><th>Core skills</th><th>Current status</th><th><span className="sr-only">Profile</span></th></tr></thead><tbody>{visible.map(e => <tr key={e.id}><td><button className="person-button" onClick={() => open(e)}><Avatar employee={e} /><span><strong>{e.name}</strong><small>{e.id} · {e.type}</small></span></button></td><td><strong className="regular">{e.title}</strong><small>{e.team}</small></td><td>{departmentName(e.departmentId)}</td><td><div className="tags">{e.skills.slice(0, 2).map(s => <span key={s.name}>{s.name}</span>)}</div></td><td><Badge>{e.status}</Badge></td><td><button className="arrow-button" onClick={() => open(e)} aria-label={`View ${e.name}'s profile`}>↗</button></td></tr>)}</tbody></table>{visible.length === 0 && <Empty message="No employees match these filters. Try another name, skill or team." />}</div>;
  const filters = <div className="filters"><label className="search-box"><Icon name="search" /><input aria-label="Search employees" placeholder="Search by name, skill or employee ID…" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="Filter by team" value={team} onChange={e => setTeam(e.target.value)}><option>All teams</option>{[...new Set(all.map(e => e.team))].map(t => <option key={t}>{t}</option>)}</select><select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}><option>All statuses</option><option>On project</option><option>In training</option><option>Available</option></select><select aria-label="Show employees" value={show} onChange={e => setShow(e.target.value as Show)}><option>Active employees</option><option>Archived employees</option></select>{(query || team !== "All teams" || status !== "All statuses" || show !== "Active employees") && <button className="text-button" onClick={() => { setQuery(""); setTeam("All teams"); setStatus("All statuses"); setShow("Active employees"); }}>Reset</button>}</div>;

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">23</span><span>brain station <b>23</b><small>PEOPLE & DEVELOPMENT</small></span></div><div className="workspace"><span className="workspace-icon">L&D</span><div><strong>Learning & Development</strong><small>Manager workspace</small></div></div><p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{sections.map(name => <button key={name} className={section === name ? "nav-item active" : "nav-item"} onClick={() => navigate(name)} aria-current={section === name ? "page" : undefined}><Icon name={name} /><span>{name}</span>{name === "Employees" && <span className="nav-count">{employees.length}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="demo-card"><span className="dot" /><strong>Demo workspace</strong><p>Explore with fictional employee records.</p></div>{isManager ? <div className="admin-identity"><span className="avatar lavender">DM</span><div><strong>Department manager</strong><small>Management portal · demo</small></div></div> : <div className="admin-identity"><span className="avatar lavender">AK</span><div><strong>Ayesha Karim</strong><small>L&D administrator · demo</small></div></div>}<form action={signOut}><button className="sign-out">Sign out <span>↗</span></button></form></div></aside>
  <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{selected ? "Employee profile" : section}</strong></div><div className="topbar-right"><span className="demo-pill">SYNTHETIC DATA</span><form action={signOut} className="mobile-sign-out"><button className="text-button">Sign out</button></form>{isManager ? <span className="avatar lavender mini">DM</span> : <span className="avatar lavender mini">AK</span>}</div></header><main className="content">
  {notice && <p className="notice" role="status">{notice}</p>}
  {selected ? <>
    <button className="text-button back" onClick={() => setSelected(null)}>← Back to {section.toLowerCase()}</button>
    <section className="profile-header"><Avatar employee={selected} large /><div className="profile-title"><span className="eyebrow">EMPLOYEE PROFILE · {selected.id}</span><h1>{selected.name}</h1><p>{selected.title} <span>·</span> {selected.team}</p><div className="profile-meta"><span>{selected.location}</span><span>Joined {date(selected.joined)}</span></div></div>{selectedArchived && <span className="badge amber"><span className="dot" />Archived</span>}<Badge>{selected.status}</Badge></section>
    <div className="tabs" role="tablist" aria-label="Employee details">{profileTabs.map(t => <button key={t} id={`tab-${t.replaceAll(" ", "-")}`} role="tab" aria-selected={tab === t} aria-controls="profile-panel" className={tab === t ? "selected" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    <section id="profile-panel" role="tabpanel" aria-labelledby={`tab-${tab.replaceAll(" ", "-")}`}>
    {tab === "Overview" && <div className="detail-grid"><article className="panel"><h2>About {selected.name.split(" ")[0]}</h2><p className="body-copy">{selected.summary}</p><dl className="details"><div><dt>Email address</dt><dd><a href={`mailto:${selected.email}`}>{selected.email}</a></dd></div><div><dt>Employment type</dt><dd>{selected.type}</dd></div><div><dt>Reporting manager</dt><dd>{selected.manager}</dd></div><div><dt>Office</dt><dd>{selected.location}</dd></div></dl></article><article className="panel"><div className="panel-title"><h2>Development snapshot</h2><span className="badge blue">L&D REVIEW</span></div>{hasEvaluation(selected.review) ? <><h3 className="readiness">{selected.review.readiness}</h3><p className="body-copy">{selected.review.next}</p><small>Reviewed {date(selected.review.date)} · {selected.review.reviewer}</small></> : <p className="muted">{NO_EVALUATION}</p>}<button className="text-button spaced" onClick={() => setTab("Skills & evaluation")}>View assessment →</button></article><article className="panel"><h2>Current focus</h2>{openAssignment ? <><h3>{openAssignment.projectName}</h3><p className="body-copy">{openAssignment.latestUpdate || "No update yet."}</p></> : <p className="body-copy">No open assignment</p>}<button className="text-button" onClick={() => setTab("Current work")}>Explore current work →</button></article><article className="panel"><h2>Learning journey</h2><Suspense fallback={<LearningMini entries={selected.training} />}><JourneyWithLms current={current} stored={selected.training} employeeId={selected.id} /></Suspense><button className="text-button" onClick={() => setTab("Training")}>View training history →</button></article>{(role === "admin" || role === "manager") && <EmployeeDetailsPanel key={`details-${selected.id}`} employeeId={selected.id} name={selected.name} title={selected.title} team={selected.team} manager={selected.manager} office={selected.location} employmentType={selected.type} departmentName={departmentName(selected.departmentId)} />}{!isManager && <StaffAccountPanel key={selected.id} employeeId={selected.id} name={selected.name} hasAccount={Boolean(all.find(e => e.id === selected.id)?.hasAccount ?? selected.hasAccount)} />}<AccountAccessPanel key={`access-${selected.id}`} employeeId={selected.id} archived={selectedArchived} /><TransferPanel key={`transfer-${selected.id}`} employeeId={selected.id} departments={departments} departmentId={all.find(e => e.id === selected.id)?.departmentId ?? selected.departmentId} /><ActivityExportPanel key={`activity-${selected.id}`} employeeId={selected.id} manager={isManager} /></div>}
    {tab === "Employment" && <article className="panel"><h2>Employment history</h2><p className="muted">Current role and previous employment.</p><EmploymentHistoryPanel key={`history-${selected.id}`} employeeId={selected.id} entries={selected.history} canEdit={role === "admin" || role === "manager"} /></article>}
    {tab === "Training" && <article className="panel"><h2>Training & development</h2><p className="muted">Programmes completed and learning currently in progress.</p><section aria-labelledby="profile-completed-heading"><h3 id="profile-completed-heading">Completed training</h3><Suspense fallback={<TrainingRows entries={selected.training} empty="No completed training on record." />}><ProfileCompleted current={current} stored={selected.training} employeeId={selected.id} /></Suspense></section><section aria-labelledby="profile-current-heading"><h3 id="profile-current-heading">Current enrolments</h3><Suspense fallback={<CurrentLoading />}><ProfileCurrent current={current} employeeId={selected.id} /></Suspense></section></article>}
    {tab === "Skills & evaluation" && <div className="detail-grid"><article className="panel"><h2>Assessed skills</h2><p className="muted">{SKILL_SCALE}</p><SkillList skills={selected.skills} /></article><article className="panel"><h2>Manager evaluation</h2><EvaluationSummary review={selected.review} /><p className="fine-print">A role-specific, human-reviewed assessment. Git activity and attendance are not used to generate an employee score.</p></article>{(role === "admin" || role === "manager") && <><SkillRatingPanel key={`skills-${selected.id}`} employeeId={selected.id} name={selected.name} skills={selected.skills} /><EvaluationPanel key={`evaluation-${selected.id}`} employeeId={selected.id} name={selected.name} strengths={selected.review.strengths} developmentPriorities={selected.review.next} readiness={selected.review.readiness} /></>}</div>}
    {tab === "Current work" && <AssignmentsPanel key={`assignments-${selected.id}`} employeeId={selected.id} name={selected.name} assignments={selectedAssignments} departmentName={departmentName} evaluations={selectedEvaluations} backfilledProjects={selectedBackfilled} />}
    {tab === "Interviews" && !isManager && <article className="panel"><h2>External job interviews</h2><p className="muted">Opportunities at other employers, separate from internal assignments.</p>{activeInterviews.length === 0 ? <Empty message={withdrawnInterviews.length === 0 ? "No external job applications or interviews have been recorded for this employee." : "This employee has no active external interviews."} /> : activeInterviews.map(i => <div className="interview-detail" key={i.id}><div className="panel-title"><h3>{i.company}</h3><Badge>{outcomeLabel(i.outcome)}</Badge></div><p>{i.role}</p><small>{date(i.date)} · {i.stage}</small>{i.feedback && <div className="callout">{i.feedback}</div>}<small>Offer / joining date: not recorded</small></div>)}{withdrawnInterviews.length > 0 && <section aria-labelledby="withdrawn-history-heading"><h3 id="withdrawn-history-heading">Withdrawn (history)</h3><p className="muted">Entries the employee withdrew. Kept for the record; read-only.</p>{withdrawnInterviews.map(i => <div className="interview-detail" key={i.id}><div className="panel-title"><h3>{i.company}</h3><Badge>Withdrawn</Badge></div><p>{i.role}</p><small>{date(i.date)} · {i.stage}{i.outcome ? ` · ${i.outcome}` : ""}</small>{i.feedback && <div className="callout">{i.feedback}</div>}</div>)}</section>}</article>}
    {tab === "Attendance" && <><div className="stat-grid"><Stat label="Scheduled days" value={selected.attendance.scheduled} note="1–20 September 2026" icon="Attendance & leave" /><Stat label="Recorded days worked" value={selected.attendance.worked} note="From demo attendance records" icon="Employees" /><Stat label="Leave days" value={selected.attendance.leave} note="Within the reporting period" icon="Attendance & leave" /><Stat label="Missing records" value={selected.attendance.unrecorded} note="Require review" icon="Overview" /></div><article className="panel"><h2>Leave & attendance exceptions</h2><p className="muted">Schedule: Monday–Friday · demonstration period, not a payroll calculation.</p><div className="table-scroll"><table><thead><tr><th>Date</th><th>Record type</th><th>Days</th><th>Status</th></tr></thead><tbody>{selected.attendance.records.map(r => <tr key={r.date}><td>{date(r.date)}</td><td>{r.type}</td><td>{r.days}</td><td><Badge>{r.status}</Badge></td></tr>)}</tbody></table></div></article><article className="panel" aria-labelledby="profile-leave-heading"><h2 id="profile-leave-heading">Recorded leave</h2><p className="muted">Leave periods recorded for {selected.name}, newest first, with their working days and category.</p><LeavePanel key={`leave-${selected.id}`} employeeId={selected.id} records={selected.leave} canEdit={role === "admin" || role === "manager"} /></article></>}
    </section>
  </> : <>
    <div className="page-heading"><div><span className="eyebrow">PEOPLE & DEVELOPMENT</span><h1>{section === "Overview" ? "A clearer view of your people." : section}</h1><p>{section === "Overview" ? "Track progress, support growth and help your people take their next step." : section === "Employees" ? "Every person, their experience and their potential — in one place." : section === "Departments" ? "The organisational units employees belong to." : section === "My record" ? "Your own attendance, daily log, assignments, past projects, training and interviews." : "A shared view of development, opportunities and employee records."}</p></div>{(section === "Overview" || section === "Employees") && <button className="secondary" onClick={exportDirectory}>↓ Export directory</button>}</div>
    {section === "Overview" && <><div className="period-label">WORKSPACE SNAPSHOT <span>Demo period · September 2026</span></div><div className="stat-grid"><Stat label="Total employees" value={employees.length} note={isManager ? departmentCount(departments.length) : "Across 5 specialist teams"} icon="Employees" /><Suspense fallback={<Stat label="Learning in progress" value="…" note="Loading from the LMS" icon="Learning & development" />}><InProgressStat current={current} employees={employees} /></Suspense><Stat label="Available for assignment" value={employees.filter(e => e.status === "Available").length} note="Ready for a new opportunity" icon="Overview" />{!isManager && <Stat label="Upcoming interviews" value={interviews.filter(i => i.interview.outcome === "Scheduled").length} note="External employer opportunities" icon="Interviews & placements" />}</div><div className="overview-grid"><article className="panel focus-panel"><div className="panel-title"><h2>Growth starts with a next step.</h2><span className="spark">✳</span></div><p>Connect each employee's skills and experience with the right learning opportunity.</p><button className="primary" onClick={() => navigate("Learning & development")}>Explore learning progress <span>→</span></button><div className="focus-foot"><span className="overlap-avatars">{employees.slice(0, 3).map(e => <Avatar key={e.id} employee={e} />)}</span><span><Suspense fallback={<>{trainings.length} completed training records</>}><CompletedCount current={current} employees={employees} /></Suspense></span></div></article><article className="panel attention"><div className="panel-title"><h2>On your radar</h2><span className="badge amber">FOLLOW UP</span></div>{radarNadia && !isManager && <button className="radar-row" onClick={() => open(radarNadia, "Interviews")}><span className="radar-icon blue"><Icon name="Interviews & placements" /></span><span><strong>Nadia's technical interview</strong><small>23 Sep · Northstar Labs · external employer</small></span><span>↗</span></button>}{radarMeera && <button className="radar-row" onClick={() => open(radarMeera, "Training")}><span className="radar-icon lavender"><Icon name="Learning & development" /></span><span><strong>Meera's learning check-in</strong><small>Review communication training progress</small></span><span>↗</span></button>}<button className="radar-row" onClick={() => navigate("Attendance & leave")}><span className="radar-icon peach"><Icon name="Attendance & leave" /></span><span><strong>{totals.missing} attendance records to review</strong><small>Missing entries in the demo reporting period</small></span><span>↗</span></button></article></div></>}
    {(section === "Employees" || section === "Overview") && <section className="panel directory"><div className="panel-title"><div><h2>Employee directory <span className="count">{directory.length}</span></h2><p className="muted">Get to know the people behind the work.</p></div>{section === "Overview" && <button className="text-button" onClick={() => navigate("Employees")}>View directory →</button>}</div>{filters}{employeeTable}<div className="table-footer">Showing {visible.length} of {directory.length} {show === "Archived employees" ? "archived " : ""}employees <span>All records are fictional</span></div></section>}
    {section === "Employees" && <ActivityExportPanel key="activity-all" manager={isManager} />}
    {section === "Employees" && (role === "admin" || role === "manager") && <AddEmployeePanel departments={departments} />}
    {section === "Learning & development" && <Suspense fallback={<LearningTable rows={trainings} badge={`${trainings.length} completed`} open={open} state={<CurrentLoading />} />}><OrgLearning current={current} employees={employees} open={open} /></Suspense>}
    {section === "Interviews & placements" && !isManager && <section className="panel"><h2>External opportunities</h2><p className="muted">Applications and interview outcomes at other employers. Select an employee to review feedback.</p><div className="table-scroll"><table><thead><tr><th>Employee</th><th>Employer & position</th><th>Interview date</th><th>Outcome</th></tr></thead><tbody>{interviews.map(({ employee: e, interview: i }) => <tr key={i.id}><td><button className="person-button" onClick={() => open(e, "Interviews")}><Avatar employee={e} /><strong>{e.name}</strong></button></td><td>{i.company}<small>{i.role}</small></td><td>{date(i.date)}</td><td><Badge>{outcomeLabel(i.outcome)}</Badge></td></tr>)}</tbody></table></div></section>}
    {section === "Departments" && !isManager && <DepartmentsPanel departments={departments} employees={all} />}
    {section === "My record" && myRecord && <section className="my-record" aria-label="My record"><StaffSelfService {...myRecord} /></section>}
    {section === "Attendance & leave" && <><div className="stat-grid three"><Stat label="Recorded days worked" value={totals.worked} note="Sum across employees" icon="Employees" /><Stat label="Leave days" value={totals.leave} note="Sum across employees" icon="Attendance & leave" /><Stat label="Missing records" value={totals.missing} note="Require manual review" icon="Overview" /></div><section className="panel"><h2>Attendance summary</h2><p className="muted">1–20 September 2026 · Monday–Friday schedule · synthetic attendance records</p><div className="table-scroll"><table><thead><tr><th>Employee</th><th>Scheduled</th><th>Worked</th><th>Leave</th><th>Missing</th></tr></thead><tbody>{employees.map(e => <tr key={e.id}><td><button className="person-button" onClick={() => open(e, "Attendance")}><Avatar employee={e} /><strong>{e.name}</strong></button></td><td>{e.attendance.scheduled}</td><td>{e.attendance.worked}</td><td>{e.attendance.leave}</td><td><span className="badge amber">{e.attendance.unrecorded}</span></td></tr>)}</tbody></table></div><p className="fine-print">Worked days come from attendance records, not Git commits or scheduled days minus leave.</p></section>{role === "admin" && holidayCalendars !== undefined && <HolidayCalendarPanel versions={holidayCalendars} />}</>}
  </>}
  <footer className="page-footer"><span>Brain Station 23 · People & Development</span><span>Demo workspace · fictional records · September 2026</span></footer>
  </main></div></div>;
}
function Stat({ label, value, note, icon }: { label: string; value: number | string; note: string; icon: string }) { return <article className="stat-card"><div><span>{label}</span><Icon name={icon} /></div><strong>{typeof value === "number" ? value.toString().padStart(2, "0") : value}</strong><small>{note}</small></article>; }

type Open = (employee: Employee, nextTab?: Tab) => void;

/** The org-wide Learning & development table, with the LMS state (loading, stale, unavailable) above it. */
function LearningTable({ rows, badge, open, state }: { rows: TrainingWithEmployee[]; badge: string; open: Open; state?: ReactNode }) {
  return <section className="panel"><div className="panel-title"><h2>Training programmes</h2><span className="badge blue">{badge}</span></div>{state}<div className="table-scroll"><table><thead><tr><th>Employee</th><th>Programme</th><th>Progress</th><th>Completion / target</th></tr></thead><tbody>{rows.map(({ employee: e, training: t }) => <tr key={t.id}><td><button className="person-button" onClick={() => open(e, "Training")}><Avatar employee={e} /><strong>{e.name}</strong></button></td><td><strong className="regular">{t.name}</strong><small>{t.provider}</small></td><td><div className="progress-line"><progress max={100} value={t.progress} aria-label={`${e.name}: ${t.name}`} /><small>{t.progress}%</small></div></td><td>{date(t.date)}</td></tr>)}</tbody></table></div></section>;
}

function OrgLearning({ current, employees, open }: { current: Promise<CurrentTraining>; employees: Employee[]; open: Open }) {
  const result = use(current);
  if (result.status === "unavailable") {
    const stored = orgTraining(employees);
    return <LearningTable rows={stored} badge={`${stored.length} completed`} open={open} state={<CurrentUnavailable />} />;
  }
  const rows = orgTraining(employees, result);
  return <LearningTable rows={rows} badge={`${rows.length} enrolments`} open={open} state={result.stale ? <StaleNote asOf={result.asOf} /> : undefined} />;
}
