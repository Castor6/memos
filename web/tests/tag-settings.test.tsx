import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TagsSection from "@/components/Settings/TagsSection";
import { UserSetting_TagsSettingSchema } from "@/types/proto/api/v1/user_service_pb";

const mocks = vi.hoisted(() => ({ update: vi.fn(), refetch: vi.fn(), error: vi.fn(), auth: {} as Record<string, unknown> }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/hooks/useUserQueries", () => ({
  useTagCounts: () => ({ data: {} }),
  useUpdateUserSetting: () => ({ mutateAsync: mocks.update, isPending: false }),
}));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
vi.mock("@/lib/error", () => ({ handleError: (...args: unknown[]) => mocks.error(...args) }));

beforeEach(() => {
  mocks.auth = {
    currentUser: { name: "users/test" },
    refetchSettings: mocks.refetch,
    userTagsSetting: create(UserSetting_TagsSettingSchema, {
      tags: {
        "project/.*": { emoji: "📁", blurContent: true },
        unrelated: { emoji: "🌲", blurContent: false },
      },
    }),
  };
});

describe("sidebar tag settings", () => {
  it("edits one tag while preserving inherited defaults and unrelated rules", async () => {
    const saved = vi.fn();
    render(<TagsSection tag="project/work" onSaved={saved} />);
    expect(screen.getByLabelText("标签 project/work 的 Emoji")).toHaveValue("📁");
    expect(screen.queryByLabelText("标签 unrelated 的 Emoji")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("标签 project/work 的 Emoji"), { target: { value: "📚" } });
    fireEvent.change(screen.getByLabelText("setting.tags.background-color"), { target: { value: "#4488ee" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const tags = mocks.update.mock.calls[0][0].setting.value.value.tags;
    expect(tags["project/work"]).toMatchObject({ emoji: "📚", blurContent: true });
    expect(tags["project/work"].backgroundColor.red).toBeCloseTo(68 / 255);
    expect(tags["project/.*"]).toMatchObject({ emoji: "📁", blurContent: true });
    expect(tags.unrelated).toMatchObject({ emoji: "🌲", blurContent: false });
  });

  it("keeps the editor open and reports a failed save", async () => {
    mocks.update.mockRejectedValueOnce(new Error("offline"));
    const saved = vi.fn();
    render(<TagsSection tag="new" onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("标签 new 的 Emoji"), { target: { value: "🧪" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("标签 new 的 Emoji")).toHaveValue("🧪");
  });
});
