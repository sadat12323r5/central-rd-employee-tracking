import Login from "@/components/login";
import Portal from "@/components/portal";
import StaffAttendance from "@/components/staff-attendance";
import { getSession } from "@/server/auth";
import { attendanceStore } from "@/server/attendance-store";
import { employeesStore, EmployeesUnavailableError } from "@/server/employees-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  const login = <Login />;
  if (!session) return login;
  try {
    if (session.role === "staff") {
      const employee = await employeesStore.getFor(session, session.employeeId);
      if (!employee) return login;
      const entries = await attendanceStore.listForEmployee(employee.id);
      return <StaffAttendance employee={employee} entries={entries} serverNow={new Date().toISOString()} />;
    }
    return <Portal employees={await employeesStore.listFor(session)} />;
  } catch (error) {
    // Never fall back to an empty or partial list: say plainly that records could not be loaded.
    if (error instanceof EmployeesUnavailableError) {
      console.error("Employee records unavailable.", error, { cause: error.cause });
      return <EmployeesUnavailable />;
    }
    throw error;
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
