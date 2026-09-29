import Login from "@/components/login";
import Portal from "@/components/portal";
import StaffAttendance from "@/components/staff-attendance";
import { getSession } from "@/server/auth";
import { attendanceStore } from "@/server/attendance-store";
import { employees } from "@/data/employees";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  const login = <Login showDemoCredentials={!process.env.DEMO_ADMIN_EMAIL && !process.env.DEMO_ADMIN_PASSWORD} />;
  if (!session) return login;
  if (session.role === "staff") {
    const employee = employees.find(e => e.id === session.employeeId);
    if (!employee) return login;
    const entries = await attendanceStore.listForEmployee(employee.id);
    return <StaffAttendance employee={employee} entries={entries} serverNow={new Date().toISOString()} />;
  }
  return <Portal employees={employees} />;
}
