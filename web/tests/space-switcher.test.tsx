import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SpaceSwitcher from "@/components/SpaceSwitcher";

const auth = vi.hoisted(() => ({
  currentUser: { name: "users/test" },
  isInitialized: false,
  userGeneralSetting: undefined as { spaces: Record<string, string> } | undefined,
  refetchSettings: vi.fn(async () => undefined),
}));
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => undefined), isPending: false }));
const switchSpace = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/useUserQueries", () => ({ useUpdateUserGeneralSetting: () => update }));
vi.mock("@/lib/personal-space", () => ({ getActiveSpace: () => "", switchSpace }));

describe("SpaceSwitcher during startup", () => {
  beforeEach(() => {
    auth.isInitialized = false;
    auth.userGeneralSetting = undefined;
    vi.clearAllMocks();
  });

  it("waits for settings before exposing actions and preserves existing spaces when creating one", async () => {
    const view = render(<SpaceSwitcher />);
    expect(screen.getByRole("combobox", { name: "空间" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建空间" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "新建空间" }));
    expect(screen.queryByRole("textbox", { name: "空间名称" })).not.toBeInTheDocument();
    expect(update.mutateAsync).not.toHaveBeenCalled();

    auth.userGeneralSetting = { spaces: { existing: "已有空间" } };
    auth.isInitialized = true;
    view.rerender(<SpaceSwitcher />);
    expect(screen.getByRole("combobox", { name: "空间" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "新建空间" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "空间名称" }), { target: { value: "新空间" } });
    fireEvent.click(screen.getByRole("button", { name: "创建", exact: true }));

    await waitFor(() => expect(switchSpace).toHaveBeenCalledOnce());
    const newId = switchSpace.mock.calls[0][0];
    expect(update.mutateAsync).toHaveBeenCalledWith({
      generalSetting: { spaces: { existing: "已有空间", [newId]: "新空间" } },
      updateMask: ["spaces"],
    });
    expect(auth.refetchSettings).toHaveBeenCalledOnce();
  });
});
