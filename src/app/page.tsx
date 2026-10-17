import Login from "@/components/login";
import Portal from "@/components/portal";
import StaffAttendance, { type StaffSelfServiceProps } from "@/components/staff-attendance";
import { getSession } from "@/server/auth";
import { attendanceStore, AttendanceUnavailableError } from "@/server/attendance-store";
import { backfilledProjectStore, type DepartmentOption } from "@/server/backfilled-project-store";
import { departmentsStore, DepartmentsUnavailableError } from "@/server/departments-store";
import { employeesStore, EmployeesUnavailableError } from "@/server/employees-store";
import { holidayCalendarStore, type CalendarVersion } from "@/server/holiday-calendar-store";
import { ownRecordIdentity, type SessionIdentity } from "@/server/session";
import { trainingStore, type CurrentTraining } from "@/server/training-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  const login = <Login />;
  if (!session) return login;
  try {
    if (session.role === "staff") {
      const employee = await employeesStore.getFor(session, session.employeeId);
      if (!employee) return login;
      // Started before the attendance read and never awaited here: the page streams it (Story 3.2).
      const current = currentTraining(session, [employee.id]);
      // Story 4.7: the departments to pick from when backfilling; unavailable is a value (the form says so).
      const [entries, departmentOptions] = await Promise.all([attendanceStore.listFor(session, employee.id), departmentOptionsFor()]);
      return <StaffAttendance employee={employee} entries={entries} serverNow={new Date().toISOString()} current={current}
        departmentOptions={departmentOptions} />;
    }
    if (session.role === "manager") {
      // Story 4.2: the management portal without Departments, interviews or account controls.
      // Story 4.3: everything is scoped to the manager's department subtree, worked out fresh by the stores.
      // Story 4.4: interviews are stripped here, server-side, so a manager's client payload can never carry
      // them whatever the store returns (FR-3); hiding the views in the portal is not the guarantee.
      // Story 4.8: every department's name (id and name only), so history recorded under a department outside
      // the subtree (before a transfer) still shows its name. Never used for choices; unavailable is null.
      // Story 4.10: "My record" is read separately under the Staff own-record rules; it keeps the manager's own
      // interviews (their own record), while the employees list stays interview-free.
      const options = departmentOptionsFor();
      const [scoped, departments, departmentNames, myRecord] = await Promise.all([
        employeesStore.listFor(session), departmentsStore.listFor(session), options, myRecordFor(session, options),
      ]);
      const employees = withoutInterviews(scoped);
      return <Portal role="manager" employees={employees} departments={departments} departmentNames={departmentNames}
        current={currentTraining(session, employees.map(e => e.id))} myRecord={myRecord} />;
    }
    // Department names (Story 4.1) are read separately and joined to employees by id in the portal.
    // Story 4.10: an Administrator linked to an employee row also gets "My record".
    // Story 5.1: the holiday calendar versions; unavailable is a value (null), never a page failure.
    const [employees, departments, myRecord, holidayCalendars] = await Promise.all([
      employeesStore.listFor(session), departmentsStore.listFor(session), myRecordFor(session), holidayCalendarVersionsFor(session),
    ]);
    return <Portal employees={employees} departments={departments} current={currentTraining(session, employees.map(e => e.id))}
      myRecord={myRecord} holidayCalendars={holidayCalendars} />;
  } catch (error) {
    // Never fall back to an empty or partial list: say plainly that records could not be loaded.
    if (error instanceof EmployeesUnavailableError) {
      console.error("Employee records unavailable.", error, { cause: error.cause });
      return <EmployeesUnavailable />;
    }
    if (error instanceof DepartmentsUnavailableError) {
      console.error("Departments unavailable.", error, { cause: error.cause });
      return <DepartmentsUnavailable />;
    }
    if (error instanceof AttendanceUnavailableError) {
      console.error("Attendance unavailable.", error, { cause: error.cause });
      return <AttendanceUnavailable />;
    }
    throw error;
  }
}

/**
 * Story 4.10: the "My record" props for an account linked to an employee (a manager, or a linked Administrator),
 * or undefined. Every read uses only the derived `{ role: "staff", employeeId }` identity, so the stores and RLS
 * apply the Staff own-record rules. A missing own record omits it; an unavailable store error propagates.
 */
async function myRecordFor(
  session: SessionIdentity, options?: Promise<DepartmentOption[] | null>,
): Promise<StaffSelfServiceProps | undefined> {
  const own = ownRecordIdentity(session);
  if (!own) return undefined;
  const [employee, entries, departmentOptions] = await Promise.all([
    employeesStore.getFor(own, own.employeeId), attendanceStore.listFor(own, own.employeeId), options ?? departmentOptionsFor(),
  ]);
  if (!employee) return undefined;
  return { employee, entries, serverNow: new Date().toISOString(), current: currentTraining(own, [own.employeeId]), departmentOptions };
}

/** Every employee with `interviews: []`: what a manager session may receive (Story 4.4). Pure. */
function withoutInterviews<T extends { interviews: unknown[] }>(employees: readonly T[]): T[] {
  return employees.map(e => ({ ...e, interviews: [] }));
}

/**
 * LMS enrolments for the client components to read with `use()` inside `<Suspense>`. The promise always
 * resolves: any unexpected error becomes `unavailable` (logged), so it never reaches an error boundary.
 */
function currentTraining(session: SessionIdentity, employeeIds: string[]): Promise<CurrentTraining> {
  return Promise.resolve()
    .then(() => trainingStore.currentFor(session, employeeIds))
    .catch((error: unknown): CurrentTraining => {
      console.error("Current training unavailable.", error);
      return { status: "unavailable" };
    });
}

/**
 * Story 4.7: the department list (id and name only) for the backfill form, read through the store. Any
 * error becomes `null` (logged): the form then says the list is unavailable rather than offering an empty select.
 */
async function departmentOptionsFor(): Promise<DepartmentOption[] | null> {
  try {
    return await backfilledProjectStore.departmentOptions();
  } catch (error) {
    console.error("Department options unavailable.", error);
    return null;
  }
}

/**
 * Story 5.1: the stored holiday calendar versions for the Administrator's panel, newest first. Any error
 * becomes `null` (logged): the panel then says the calendar is unavailable, never "none loaded".
 */
async function holidayCalendarVersionsFor(session: SessionIdentity): Promise<CalendarVersion[] | null> {
  try {
    return await holidayCalendarStore.versions(session);
  } catch (error) {
    console.error("Holiday calendar unavailable.", error);
    return null;
  }
}

function EmployeesUnavailable() {
  return (
    <main className="content">
      <div className="panel empty" role="alert">
        <h1>Employee records are unavailable</h1>
        <p>The employee database could not be reached, so no records are shown. Please refresh the page in a moment.</p>
      </div>
    </main>
  );
}

function DepartmentsUnavailable() {
  return (
    <main className="content">
      <div className="panel empty" role="alert">
        <h1>Departments are unavailable</h1>
        <p>The department list could not be reached, so no records are shown. Please refresh the page in a moment.</p>
      </div>
    </main>
  );
}

function AttendanceUnavailable() {
  return (
    <main className="content">
      <div className="panel empty" role="alert">
        <h1>Attendance is unavailable</h1>
        <p>Your attendance records could not be reached, so none are shown. Please refresh the page in a moment.</p>
      </div>
    </main>
  );
}
