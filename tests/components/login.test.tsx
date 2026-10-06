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

  it("renders the sign-in form without demo credentials by default", () => {
    render(<Login showDemoCredentials={false} />);
    expect(screen.getByRole("heading", { name: "Welcome back." })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeRequired();
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "password");
    expect(screen.queryByText("nadia.rahman@example.com")).not.toBeInTheDocument();
  });

  it("shows only the staff demo credentials when requested, never the retired manager ones", () => {
    const { container } = render(<Login showDemoCredentials={true} />);
    expect(screen.getByText("nadia.rahman@example.com")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/manager@example\.com/);
    expect(container).not.toHaveTextContent(/Brain23Demo/);
  });

  it("shows the server-returned error after a failed sign-in attempt", async () => {
    signInMock.mockResolvedValue({ error: "The email or password is incorrect. Please try again." });
    const user = userEvent.setup();
    render(<Login showDemoCredentials={false} />);

    await user.type(screen.getByLabelText("Email address"), "admin@example.test");
    await user.type(screen.getByLabelText("Password", { exact: true }), "wrong-password");
    await user.click(screen.getByRole("button", { name: /sign in to workspace/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect/i);
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = render(<Login showDemoCredentials={true} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
