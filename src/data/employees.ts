/**
 * Story 4.5: one assignment (what the employee did, for whom, under which department). `department_id`
 * is the employee's department when it was created, never caller-chosen. Only `latestUpdate` changes
 * while open; closing sets `completionDate` (a calendar date) and `closedAt`; nothing is ever deleted.
 */
export type Assignment = {
  id: string; employeeId: string; departmentId: string; client: string; projectName: string; role: string;
  allocation: number; startDate: string; latestUpdate: string; status: "open" | "closed";
  completionDate: string | null; createdAt: string; closedAt: string | null;
  /** Story 4.7: materialized by assignments-store (`toAssignment`): a manager-created record. Never inferred in the UI. */
  provenance: "assignment";
};

/**
 * Story 4.7: a past project the employee added themselves (a separate record, AD-2). Only the owner adds,
 * edits and withdraws it; a withdrawn entry stays in history (`status` "withdrawn", `withdrawnAt` set).
 * `completionDate` is a calendar date; `provenance` is materialized by backfilled-project-store.
 */
export type BackfilledProject = {
  id: string; employeeId: string; departmentId: string; client: string; projectName: string; completionDate: string;
  outcome: string; status: "active" | "withdrawn"; createdAt: string; updatedAt: string; withdrawnAt: string | null;
  provenance: "backfilled";
};

/**
 * Story 4.6: the evaluation of one closed assignment (a separate record, AD-2; at most one per assignment).
 * `employeeId` and `departmentId` are copied from the assignment, never caller-chosen. `createdBy` /
 * `createdAt` are the first writer; `authoredBy` / `updatedAt` the latest (an amendment). Both authors are
 * auth user ids taken from the writer's session by the database, with a snapshot of the writer's display
 * name (null when the account has no employee row) and role at the time of the write. Never deleted.
 */
export type AssignmentEvaluation = {
  id: string; assignmentId: string; employeeId: string; departmentId: string; evaluation: string; clientFeedback: string;
  createdBy: string; createdByName: string | null; createdByRole: AuthorRole; createdAt: string;
  authoredBy: string; authoredByName: string | null; authoredByRole: AuthorRole; updatedAt: string;
};

/** Story 4.6: the role an evaluation's writer had when writing it. */
export type AuthorRole = "admin" | "manager";

export type Employee = {
  id: string; name: string; title: string; team: string; type: string; email: string;
  joined: string; manager: string; location: string; status: "On project" | "In training" | "Available";
  initials: string; color: string; summary: string;
  /** Administrator reads only: true when the employee has a linked sign-in account (`auth_user_id`). */
  hasAccount?: boolean;
  /** Administrator reads only: true when the employee is archived (`archived_at` set, Story 1.4). */
  archived?: boolean;
  /** Administrator reads only: the employee's department (`department_id`, Story 4.1); null when unset. */
  departmentId?: string | null;
  skills: { name: string; level: number; evidence: string }[];
  history: { role: string; company: string; period: string; detail: string }[];
  /**
   * Stored completed training (Story 3.1, read through training-store from the `training_history` table):
   * `progress` 100, `date` = completion date, newest completion first. LMS enrolments (in progress, and
   * courses the LMS reports as completed) are not part of this list: they stream separately through
   * `trainingStore.currentFor` (Story 3.2). In this fixture, which is seed-only for training, the entries
   * below 100% (`date` = target date) are the seed for the LMS stub table.
   */
  training: { id: string; name: string; provider: string; progress: number; date: string; result: string }[];
  /**
   * Story 4.5: the employee's assignments, read through assignments-store from the `assignments` table:
   * the open one first, then closed ones by completion date, newest first. The fixture's former "current
   * work" is seed-only (`fixtureCurrentWork`); the fixture's own list is always empty.
   */
  assignments: Assignment[];
  /**
   * Story 4.6: the evaluations of the employee's closed assignments, read through
   * assignment-evaluations-store from the `assignment_evaluations` table (joined to `assignments` by
   * `assignmentId`). The fixture's own list is always empty.
   */
  evaluations: AssignmentEvaluation[];
  /**
   * Story 4.7: the employee's self-reported past projects, read through backfilled-project-store from the
   * `backfilled_projects` table (newest completion first), withdrawn ones included and marked. The
   * fixture's own list is always empty.
   */
  backfilledProjects: BackfilledProject[];
  /**
   * External interviews (Story 2.1): read from the `external_interviews` table, newest first.
   * `withdrawn` (Story 2.2) marks an entry its author withdrew: it leaves active views but stays in history.
   */
  interviews: { id: string; company: string; role: string; date: string; stage: string; outcome: string; feedback: string; withdrawn: boolean }[];
  attendance: { scheduled: number; worked: number; leave: number; unrecorded: number; records: { date: string; type: string; days: number; status: string }[] };
  review: { date: string; reviewer: string; readiness: string; strengths: string; next: string };
};

/**
 * The deterministic `external_interviews.id` of a fixture interview, stable per employee and index,
 * so `npm run db:seed` upserts the same rows on every run (e.g. BS-1001 #0 -> 5eed0000-0000-4000-8000-000010010000).
 */
export function interviewSeedId(employeeId: string, index: number): string {
  const digits = /^BS-(\d{4})$/.exec(employeeId)?.[1];
  if (!digits || !Number.isInteger(index) || index < 0 || index > 0xffff) throw new Error(`No seed id for ${employeeId} #${index}.`);
  return `5eed0000-0000-4000-8000-0000${digits}${index.toString(16).padStart(4, "0")}`;
}

/** The `external_interviews` rows `npm run db:seed` upserts for the given employees' fixture interviews. */
export function interviewSeedRows(list: Employee[]) {
  return list.flatMap(e => e.interviews.map(i => ({
    id: i.id, employee_id: e.id, company: i.company, role: i.role, stage: i.stage,
    interview_date: i.date, outcome: i.outcome, feedback: i.feedback,
  })));
}

/**
 * The deterministic id of a fixture training entry, stable per employee and index (the
 * `training_history.id` of a completed one), e.g. BS-1001 #0 -> 7a1a0000-0000-4000-8000-000010010000.
 */
export function trainingSeedId(employeeId: string, index: number): string {
  const digits = /^BS-(\d{4})$/.exec(employeeId)?.[1];
  if (!digits || !Number.isInteger(index) || index < 0 || index > 0xffff) throw new Error(`No seed id for ${employeeId} #${index}.`);
  return `7a1a0000-0000-4000-8000-0000${digits}${index.toString(16).padStart(4, "0")}`;
}

/**
 * The `training_history` rows `npm run db:seed` inserts: completed fixture entries (`progress === 100`)
 * only. In-progress entries are never copied into the table.
 */
export function trainingSeedRows(list: Employee[]) {
  return list.flatMap(e => e.training.filter(t => t.progress === 100).map(t => ({
    id: t.id, employee_id: e.id, programme: t.name, provider: t.provider, result: t.result, completed_on: t.date,
  })));
}

/**
 * The deterministic `lms_stub_enrolments.id` of a fixture training entry, stable per employee and index
 * (the same index as `trainingSeedId`), e.g. BS-1001 #1 -> 1a5b0000-0000-4000-8000-000010010001.
 */
export function lmsStubSeedId(employeeId: string, index: number): string {
  const digits = /^BS-(\d{4})$/.exec(employeeId)?.[1];
  if (!digits || !Number.isInteger(index) || index < 0 || index > 0xffff) throw new Error(`No LMS stub seed id for ${employeeId} #${index}.`);
  return `1a5b0000-0000-4000-8000-0000${digits}${index.toString(16).padStart(4, "0")}`;
}

/**
 * The `lms_stub_enrolments` rows `npm run db:seed` inserts (Story 3.2): in-progress fixture entries
 * (`progress < 100`) only, as `in_progress` enrolments whose target date is the entry's date. Completed
 * entries are never copied here (they are stored history). `synced_at` defaults to the insert time.
 */
export function lmsStubSeedRows(list: Employee[]) {
  return list.flatMap(e => e.training.flatMap((t, index) => (t.progress < 100 ? [{
    id: lmsStubSeedId(e.id, index), employee_id: e.id, programme: t.name, provider: t.provider,
    status: "in_progress" as const, progress: t.progress, target_date: t.date,
  }] : [])));
}

/**
 * The deterministic `assignments.id` of an employee's seeded assignment (Story 4.5: one per fixture
 * employee, from its former "current work"), e.g. BS-1001 -> a5510000-0000-4000-8000-000010010000.
 */
export function assignmentSeedId(employeeId: string): string {
  const digits = /^BS-(\d{4})$/.exec(employeeId)?.[1];
  if (!digits) throw new Error(`No assignment seed id for ${employeeId}.`);
  return `a5510000-0000-4000-8000-0000${digits}0000`;
}

const SEED_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The first day of a fixture work period as a calendar date (`"14–20 Sep 2026"` -> `2026-09-14`,
 * `"3 Oct 2026"` -> `2026-10-03`), or null when the period does not parse to a real date.
 */
export function periodStartDate(period: string): string | null {
  const match = /^(\d{1,2})(?:\s*[–—-]\s*\d{1,2})?\s+([A-Za-z]{3})\s+(\d{4})$/.exec(period.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = SEED_MONTHS.findIndex(m => m.toLowerCase() === match[2].toLowerCase());
  const year = Number(match[3]);
  if (month < 0 || day < 1) return null;
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month, day);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A fixture employee's former "current work" record (seed-only; never read at runtime). */
export type FixtureWork = { employeeId: string; project: string; role: string; allocation: number; update: string; period: string };

/**
 * The open `assignments` rows `npm run db:seed` inserts (Story 4.5): one per given employee that has a
 * fixture work record, with client "Not recorded" and the start date from the work period (its first
 * day), falling back to the join date. No department (the database copies the employee's own) and no
 * status (always open on insert).
 */
export function assignmentSeedRows(list: Employee[], work: readonly FixtureWork[] = fixtureCurrentWork) {
  return list.flatMap(e => {
    const w = work.find(x => x.employeeId === e.id);
    if (!w) return [];
    return [{
      id: assignmentSeedId(e.id), employee_id: e.id, client: "Not recorded", project_name: w.project, role: w.role,
      allocation: w.allocation, start_date: periodStartDate(w.period) ?? e.joined, latest_update: w.update,
    }];
  });
}

const people = [
  ["BS-1001", "Nadia Rahman", "Software Engineer I", "Engineering", "Permanent", "On project", "NR", "lavender", "2024-03-04", "React", "TypeScript", "Customer experience platform"],
  ["BS-1002", "Arif Hasan", "AI Engineer", "AI & Data", "Permanent", "On project", "AH", "mint", "2023-08-13", "Python", "Machine learning", "Document intelligence"],
  ["BS-1003", "Meera Das", "Trainee Software Engineer", "Engineering", "Trainee", "In training", "MD", "peach", "2026-06-01", "JavaScript", "React", "Trainee capstone · learning portal"],
  ["BS-1004", "Rafi Ahmed", "QA Engineer", "Quality Engineering", "Permanent", "Available", "RA", "blue", "2024-01-08", "Playwright", "API testing", "Internal test automation"],
  ["BS-1005", "Sara Islam", "UI/UX Designer", "Design", "Permanent", "On project", "SI", "rose", "2023-11-20", "Figma", "User research", "Customer experience platform"],
  ["BS-1006", "Tanvir Alam", "Software Engineering Intern", "Engineering", "Intern", "In training", "TA", "yellow", "2026-07-05", "C#", ".NET", "Internship · employee portal"],
  ["BS-1007", "Ishrat Khan", "DevOps Engineer", "Cloud & Infrastructure", "Permanent", "Available", "IK", "mint", "2022-09-11", "AWS", "Terraform", "Platform reliability improvements"],
  ["BS-1008", "Fahim Noor", "Software Engineer II", "Engineering", "Permanent", "On project", "FN", "lavender", "2022-02-06", "Node.js", "PostgreSQL", "Commerce API modernisation"],
] as const;

export const employees: Employee[] = people.map((p, index) => {
  const [id, name, title, team, type, status, initials, color, joined, skillOne, skillTwo, project] = p;
  const junior = type === "Trainee" || type === "Intern";
  return {
    id, name, title, team, type, status, initials, color, joined,
    email: `${name.toLowerCase().replace(" ", ".")}@example.com`, manager: "Ayesha Karim", location: "Dhaka, Bangladesh",
    summary: junior ? `Developing practical ${skillOne} skills through guided training and a supervised project.` : `${title} focused on ${skillOne} and ${skillTwo}, with experience delivering collaborative engineering projects.`,
    skills: [{ name: skillOne, level: junior ? 2 : 4, evidence: junior ? "Mentor-reviewed training exercise" : "Project deliverable and technical review" }, { name: skillTwo, level: junior ? 2 : 3, evidence: "Practical assessment" }, { name: "Communication", level: 3, evidence: "Mentor feedback and project presentation" }],
    history: [{ role: title, company: "Brain Station 23", period: `${joined} – Present`, detail: `Working with the ${team} team.` }, ...(!junior ? [{ role: index === 1 ? "Junior Data Engineer" : `Associate ${title.replace(/ I+$/, "")}`, company: "Example Digital Ltd. (fictional)", period: "2021 – 2022", detail: "Delivered team projects and developed foundational professional skills." }] : [])],
    training: [{ id: trainingSeedId(id, 0), name: `${skillOne} · practical foundations`, provider: "BS23 Learning & Development", progress: 100, date: "2026-08-20", result: junior ? "Completed · mentor reviewed" : "Completed · assessment passed" }, { id: trainingSeedId(id, 1), name: junior ? "Professional communication" : "Technical leadership & collaboration", provider: "BS23 Learning & Development", progress: 60 + (index % 3) * 10, date: "2026-09-28", result: "In progress" }],
    assignments: [],
    evaluations: [],
    backfilledProjects: [],
    interviews: index === 2 || index === 5 ? [] : [{ id: interviewSeedId(id, 0), company: ["Northstar Labs", "Orbit Analytics", "", "Cedar Software", "Canvas Digital", "", "Summit Cloud", "Harbour Systems"][index] + " (fictional)", role: title, date: index === 0 ? "2026-09-23" : "2026-09-16", stage: index === 0 ? "Technical interview" : "Technical round completed", outcome: index === 0 ? "Scheduled" : index === 3 ? "Not selected" : "Awaiting feedback", feedback: index === 3 ? "Needs more practice explaining test strategy. Mentor follow-up planned." : "Preparation focus: project examples, technical reasoning and communication. No offer recorded.", withdrawn: false }],
    attendance: { scheduled: 14, worked: index === 2 ? 11 : 12, leave: index === 2 ? 2 : 1, unrecorded: 1, records: [{ date: "2026-09-10", type: "Leave", days: index === 2 ? 2 : 1, status: "Recorded" }, { date: "2026-09-17", type: "Attendance", days: 1, status: "Missing record" }] },
    review: { date: "2026-09-14", reviewer: "Ayesha Karim · L&D Manager", readiness: junior ? "Developing · mentor support" : "Ready for role-matched interviews", strengths: junior ? "Consistent learning progress, asks thoughtful questions and responds well to feedback." : "Clear technical reasoning, collaborative delivery and well-documented project contributions.", next: junior ? "Complete the capstone and practise a short technical presentation." : `Strengthen advanced ${skillTwo} skills and prepare two project case studies.` },
  };
});

/**
 * Story 4.5: each fixture employee's former "current work", seed-only (the Git commit counts were dropped:
 * Git tracking is a non-goal). `npm run db:seed` turns each into an open assignment (assignmentSeedRows).
 */
export const fixtureCurrentWork: readonly FixtureWork[] = people.map(p => {
  const [id, , title, , type, status, , , , , , project] = p;
  const junior = type === "Trainee" || type === "Intern";
  return {
    employeeId: id, project, role: junior ? "Supervised contributor" : title,
    allocation: status === "Available" ? 0 : junior ? 50 : 80,
    update: junior ? "Completed the first milestone; preparing a walkthrough with the mentor." : "Reviewed this week's deliverables and documented the next implementation steps.",
    period: "14–20 Sep 2026",
  };
});
