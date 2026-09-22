import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentStorageUsage from "@/components/Settings/AttachmentStorageUsage";

const mocks = vi.hoisted(() => ({ stats: vi.fn(), refetch: vi.fn() }));
vi.mock("@/hooks/useCurrentUser", () => ({ default: () => ({ name: "users/owner" }) }));
vi.mock("@/hooks/useUserQueries", () => ({ useUserStats: mocks.stats }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
beforeEach(() => {
  mocks.stats.mockReturnValue({ data: undefined, isPending: false, isError: false, refetch: mocks.refetch });
});

describe("account attachment storage", () => {
  it("shows zero only when the API explicitly returns zero", () => {
    const { rerender } = render(<AttachmentStorageUsage />);
    expect(screen.getByText("—")).toBeDefined();
    mocks.stats.mockReturnValue({ data: { attachmentStorageBytes: 0n }, isPending: false });
    rerender(<AttachmentStorageUsage />);
    expect(screen.getByText("0 B")).toBeDefined();
    expect(mocks.stats).toHaveBeenCalledWith("users/owner");
  });
  it("renders large totals and explains the account-wide scope", () => {
    mocks.stats.mockReturnValue({ data: { attachmentStorageBytes: 3221225472n }, isPending: false });
    render(<AttachmentStorageUsage />);
    expect(screen.getByText("3.0 GB")).toBeDefined();
    expect(screen.getByText("setting.account.attachment-storage-description")).toBeDefined();
  });
  it("shows a retry action on failure instead of reporting an empty account", () => {
    mocks.stats.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<AttachmentStorageUsage />);
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("0 B")).toBeNull();
  });
});
