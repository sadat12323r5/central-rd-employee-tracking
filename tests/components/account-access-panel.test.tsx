// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

const archiveMock = vi.fn();
const restoreMock = vi.fn();
vi.mock("@/server/account-actions", () => ({
  archiveEmployeeAction: (...args: unknown[]) => archiveMock(...args),
  restoreEmployeeAction: (...args: unknown[]) => restoreMock(...args),
}));

import AccountAccessPanel from "@/components/account-access-panel";

describe("AccountAccessPanel", () => {
  beforeEach(() => {
    archiveMock.mockReset();
    restoreMock.mockReset();
  });

  it("explains archiving for an active employee and archives with only the Employee ID", async () => {
    archiveMock.mockResolvedValue({ error: "", message: "Meera Das was archived. Their sign-in access has ended." });
    const user = userEvent.setup();
    render(<AccountAccessPanel employeeId="BS-1003" archived={false} />);
    expect(screen.getByRole("heading", { name: "Account access" })).toBeInTheDocument();
    expect(screen.getByText("Archiving ends this person's sign-in access immediately. Their records are kept and can be restored.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive employee" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Meera Das was archived. Their sign-in access has ended.");
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore employee" })).toBeInTheDocument();
    expect(restoreMock).not.toHaveBeenCalled();
    const submitted = archiveMock.mock.calls[0][1] as FormData;
    expect(submitted.get("employeeId")).toBe("BS-1003");
    expect([...submitted.keys()]).not.toContain("actorId");
  });

  it("shows the Archived label and restores an archived employee", async () => {
    restoreMock.mockResolvedValue({ error: "", message: "Meera Das was restored." });
    const user = userEvent.setup();
    render(<AccountAccessPanel employeeId="BS-1003" archived />);
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive employee" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore employee" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Meera Das was restored.");
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive employee" })).toBeInTheDocument();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("shows a server error as an alert and keeps the current state", async () => {
    archiveMock.mockResolvedValue({ error: "You cannot archive your own account.", message: "" });
    const user = userEvent.setup();
    render(<AccountAccessPanel employeeId="BS-1003" archived={false} />);
    await user.click(screen.getByRole("button", { name: "Archive employee" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot archive your own account.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive employee" })).toBeInTheDocument();
  });

  it("is keyboard operable", async () => {
    archiveMock.mockResolvedValue({ error: "", message: "Meera Das was archived. Their sign-in access has ended." });
    const user = userEvent.setup();
    render(<AccountAccessPanel employeeId="BS-1003" archived={false} />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Archive employee" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(archiveMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("has no detectable accessibility violations (archived: %s)", async archived => {
    const { container } = render(<AccountAccessPanel employeeId="BS-1003" archived={archived} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
