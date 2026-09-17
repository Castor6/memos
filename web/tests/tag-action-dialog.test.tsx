import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import TagActionDialog from "@/components/TagActionDialog";
import { UserSetting_TagsSettingSchema } from "@/types/proto/api/v1/user_service_pb";

const mocks = vi.hoisted(() => ({ update: vi.fn(), refetch: vi.fn(), invalidate: vi.fn(), error: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("@/hooks/useMemoQueries", () => ({ memoKeys: { all: ["memos"] } }));
vi.mock("@/lib/rename-tag", () => ({ renamedTag: vi.fn(), renameTagInMemos: vi.fn() }));
vi.mock("@/lib/error", () => ({ handleError: mocks.error }));
vi.mock("@/hooks/useUserQueries", () => ({
  useTagCounts: () => ({ data: {} }),
  userKeys: { all: ["users"] },
  useUpdateUserSetting: () => ({ mutateAsync: mocks.update }),
}));
vi.mock("@/contexts/MemoFilterContext", () => ({ useMemoFilterContext: () => ({ filters: [], setFilters: vi.fn() }) }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { name: "users/1" },
    refetchSettings: mocks.refetch,
    userTagsSetting: create(UserSetting_TagsSettingSchema, {
      tags: { "work/.*": { emoji: "📁", blurContent: true }, other: { emoji: "⭐" } },
    }),
  }),
}));
beforeEach(() => vi.clearAllMocks());
it("offers common icons and preserves inherited metadata and unrelated rules", async () => {
  const close = vi.fn();
  render(<TagActionDialog tag="work/a" action="icon" onClose={close} />);
  expect(screen.getAllByRole("button", { name: /^选择图标/ }).length).toBeGreaterThan(60);
  fireEvent.click(screen.getByRole("button", { name: "选择图标 📚" }));
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const tags = mocks.update.mock.calls[0][0].setting.value.value.tags;
  expect(tags["work/a"]).toMatchObject({ emoji: "📚", blurContent: true });
  expect(tags.other.emoji).toBe("⭐");
});
it("keeps the selection on save failure", async () => {
  mocks.update.mockRejectedValueOnce(new Error("offline"));
  const close = vi.fn();
  render(<TagActionDialog tag="work/a" action="icon" onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "选择图标 📚" }));
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText("自定义图标")).toHaveValue("📚");
});
