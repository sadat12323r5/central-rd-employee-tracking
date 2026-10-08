// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSession, listFor, getFor } = vi.hoisted(() => ({ getSession: vi.fn(), listFor: vi.fn(), getFor: vi.fn() }));

vi.mock("@/server/auth", () => ({ getSession }));
vi.mock("@/server/attendance-store", () => ({ attendanceStore: { listForEmployee: vi.fn(async () => []) } }));
vi.mock("@/server/employees-store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/server/employees-store")>()),
  employeesStore: { listFor, getFor, findByEmail: vi.fn() },
}));
vi.mock("@/components/login", () => ({ default: () => <p>Sign-in form</p> }));
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
    expect(screen.queryByText("Sign-in form")).not.toBeInTheDocument();
  });
});
