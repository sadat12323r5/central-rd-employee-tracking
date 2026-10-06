// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSession, listFor, getFor, loginProps } = vi.hoisted(() => ({ getSession: vi.fn(), listFor: vi.fn(), getFor: vi.fn(), loginProps: vi.fn() }));

vi.mock("@/server/auth", () => ({ getSession }));
vi.mock("@/server/attendance-store", () => ({ attendanceStore: { listForEmployee: vi.fn(async () => []) } }));
vi.mock("@/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/employees-store")>()),
  employeesStore: { listFor, getFor },
}));
vi.mock("@/components/login", () => ({
  default: (props: Record<string, unknown>) => {
    loginProps(props);
    return <p>Sign-in form</p>;
  },
}));
vi.mock("@/components/portal", () => ({ default: () => <p>Employee directory</p> }));
vi.mock("@/components/staff-attendance", () => ({ default: () => <p>Staff portal</p> }));

const { default: Home } = await import("@/app/page");
const { EmployeesUnavailableError } = await import("@/server/employees-store");

describe("Home when employee records are unavailable", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listFor.mockRejectedValue(new EmployeesUnavailableError());
    getFor.mockRejectedValue(new EmployeesUnavailableError());
  });
  afterEach(() => errorSpy.mockRestore());

  it("shows the unavailable alert instead of the directory for an admin", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/employee records are unavailable/i);
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("shows the unavailable alert instead of the staff portal for staff", async () => {
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    render(await Home());
    expect(screen.getByRole("alert")).toHaveTextContent(/employee records are unavailable/i);
    expect(screen.queryByText("Staff portal")).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign-in form/)).not.toBeInTheDocument();
  });
});

describe("Home when signed out", () => {
  beforeEach(() => getSession.mockResolvedValue(null));

  it("renders the sign-in form without any demo-credential props or credentials", async () => {
    render(await Home());
    expect(loginProps).toHaveBeenCalledWith({});
    expect(document.body).not.toHaveTextContent(/Staff23Demo|demo credentials|password:/i);
  });
});

describe("Home routing by role", () => {
  beforeEach(() => {
    listFor.mockReset();
    getFor.mockReset();
  });

  it("renders only the staff portal for a staff session, reading their own record", async () => {
    const { employees } = await import("@/data/employees");
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(employees.find(e => e.id === "BS-1003"));
    render(await Home());
    expect(screen.getByText("Staff portal")).toBeInTheDocument();
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
    expect(getFor).toHaveBeenCalledWith({ role: "staff", employeeId: "BS-1003" }, "BS-1003");
    expect(listFor).not.toHaveBeenCalled();
  });

  it("shows the sign-in form when a staff member's own record is not visible", async () => {
    getSession.mockResolvedValue({ role: "staff", employeeId: "BS-1003" });
    getFor.mockResolvedValue(null);
    render(await Home());
    expect(screen.getByText(/Sign-in form/)).toBeInTheDocument();
    expect(screen.queryByText("Employee directory")).not.toBeInTheDocument();
  });

  it("renders the directory for an admin", async () => {
    getSession.mockResolvedValue({ role: "admin" });
    listFor.mockResolvedValue([]);
    render(await Home());
    expect(screen.getByText("Employee directory")).toBeInTheDocument();
  });
});
