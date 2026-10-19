import type { AccountInput } from "@/server/accounts-store";
import type { AttendanceStore } from "@/server/attendance-store";
import type { NewEmployeeInput } from "@/domain/employee-input";
import type { EmployeeCreateOptions } from "@/server/employees-store";
import type { SessionIdentity } from "@/server/session";
import type { ProvisionDeps, RangeEmployee, RetireDeps } from "../../sim/cohort";
import { createMemoryAttendanceStore } from "./memory-attendance-store";

// Story 9.1: offline fakes of the simulator's dependencies. They record every call (in order) so the
// tests can check the provisioning order, the paths used, the sign-ins and that no password leaks.

export type Call =
  | { kind: "account"; role: "admin" | "staff"; email?: string; employeeId?: string; password: string }
  | { kind: "signIn"; email: string }
  | { kind: "department"; session: SessionIdentity; name: string; parentId: string | null }
  | { kind: "employee"; session: SessionIdentity; input: NewEmployeeInput; options?: EmployeeCreateOptions; by: string }
  | { kind: "setManager"; session: SessionIdentity; departmentId: string; employeeId: string | null; by: string };

export function fakeProvisionDeps({ used = [] as string[], attendance = createMemoryAttendanceStore() as AttendanceStore } = {}) {
  const calls: Call[] = [];
  const users = new Map<string, { id: string; password: string }>();
  const employees = new Map<string, NewEmployeeInput>();
  let nextUser = 1;
  const deps: ProvisionDeps = {
    accounts: {
      async create(input: AccountInput) {
        const id = `00000000-0000-4000-8000-${String(nextUser++).padStart(12, "0")}`;
        if (input.role === "admin") {
          calls.push({ kind: "account", role: "admin", email: input.email, password: input.password });
          users.set(input.email, { id, password: input.password });
          return { id, email: input.email, role: "admin" as const };
        }
        const employee = employees.get(input.employeeId);
        if (!employee) throw new Error(`No employee ${input.employeeId}`);
        calls.push({ kind: "account", role: "staff", employeeId: input.employeeId, password: input.password });
        users.set(employee.email, { id, password: input.password });
        return { id, email: employee.email, role: "staff" as const, employeeId: input.employeeId };
      },
    },
    async signIn(email, password) {
      calls.push({ kind: "signIn", email });
      const user = users.get(email);
      if (!user || user.password !== password) throw new Error(`Bad sign-in for ${email}`);
      return {
        userId: user.id,
        stores: {
          departments: {
            async create(session, { name, parentId }) {
              calls.push({ kind: "department", session, name, parentId });
              return { id: "dddd0000-0000-4000-8000-000000000001", name, parentId, managerUserId: null, managerEmployeeId: null };
            },
            async setManager(session, departmentId, employeeId) {
              calls.push({ kind: "setManager", session, departmentId, employeeId, by: email });
              return { id: departmentId, name: "x", parentId: null, managerUserId: null, managerEmployeeId: employeeId };
            },
          },
          employees: {
            async create(session, input, options) {
              calls.push({ kind: "employee", session, input, options, by: email });
              employees.set(input.employeeId, input);
              return { employeeId: input.employeeId, name: input.name };
            },
          },
          attendance,
        },
      };
    },
    usedIds: async () => used,
    randomHex: () => "ab12",
  };
  return { deps, calls, employees, attendance };
}

export function fakeRetireDeps(employees: RangeEmployee[], users: { id: string; email: string }[], failing: readonly string[] = []) {
  const archived: { employeeId: string; actorId: string }[] = [];
  const warnings: string[] = [];
  const deps: RetireDeps = {
    accounts: {
      async archive(input) {
        if (failing.includes(input.employeeId)) throw new Error(`The employee ${input.employeeId} could not be archived.`);
        archived.push({ employeeId: input.employeeId, actorId: input.actorId });
        return { employeeId: input.employeeId, name: input.employeeId, archived: true };
      },
    },
    rangeEmployees: async () => employees,
    listUsers: async () => users,
    warn: message => warnings.push(message),
  };
  return { deps, archived, warnings };
}
