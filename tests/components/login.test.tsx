// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const signInMock = vi.fn();

vi.mock("@/server/auth", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

import Login from "@/components/login";

describe("Login", () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  it("renders the sign-in form without any demo credentials", () => {
    const { container } = render(<Login />);
    expect(screen.getByRole("heading", { name: "Welcome back." })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeRequired();
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "password");
    expect(screen.queryByText("nadia.rahman@example.com")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Staff23Demo|Brain23Demo|manager@example\.com/);
    expect(container).not.toHaveTextContent(/password:/i);
  });

  it("keeps the synthetic-data note", () => {
    render(<Login />);
    expect(screen.getByText("Interactive demo · synthetic data")).toBeInTheDocument();
  });

  it("shows the server-returned error after a failed sign-in attempt", async () => {
    signInMock.mockResolvedValue({ error: "The email or password is incorrect. Please try again." });
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Email address"), "admin@example.test");
    await user.type(screen.getByLabelText("Password", { exact: true }), "wrong-password");
    await user.click(screen.getByRole("button", { name: /sign in to workspace/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect/i);
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<Login />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
