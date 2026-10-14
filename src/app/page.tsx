import Login from "@/components/login";
import Portal from "@/components/portal";
import StaffAttendance from "@/components/staff-attendance";
import { getSession } from "@/server/auth";
import { attendanceStore, AttendanceUnavailableError } from "@/server/attendance-store";
import { departmentsStore, DepartmentsUnavailableError } from "@/server/departments-store";
import { employeesStore, EmployeesUnavailableError } from "@/server/employees-store";
import type { SessionIdentity } from "@/server/session";
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
      const entries = await attendanceStore.listFor(session, employee.id);
      return <StaffAttendance employee={employee} entries={entries} serverNow={new Date().toISOString()} current={current} />;
    }
    if (session.role === "manager") {
      // Story 4.2: the management portal without Departments, interviews or account controls.
      // Story 4.3: everything is scoped to the manager's department subtree, worked out fresh by the stores.
      const [employees, departments] = await Promise.all([employeesStore.listFor(session), departmentsStore.listFor(session)]);
      return <Portal role="manager" employees={employees} departments={departments} current={currentTraining(session, employees.map(e => e.id))} />;
    }
    // Department names (Story 4.1) are read separately and joined to employees by id in the portal.
    const [employees, departments] = await Promise.all([employeesStore.listFor(session), departmentsStore.listFor(session)]);
    return <Portal employees={employees} departments={departments} current={currentTraining(session, employees.map(e => e.id))} />;
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
