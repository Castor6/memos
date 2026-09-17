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
vi.mock("@/components/TagEmojiPicker", () => ({
  default: ({ onSelect, disabled }: { onSelect: (emoji: string) => void; disabled: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect("📚")}>
      选择图标 📚
    </button>
  ),
}));
beforeEach(() => vi.clearAllMocks());
it("offers common icons and preserves inherited metadata and unrelated rules", async () => {
  const close = vi.fn();
  render(<TagActionDialog tag="work/a" action="icon" onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: "选择图标 📚" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "选择图标 📚" }));
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText("自定义图标")).toHaveValue("📚");
});

it("restores the default icon without removing other metadata", async () => {
  render(<TagActionDialog tag="work/a" action="icon" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0][0].setting.value.value.tags["work/a"]).toMatchObject({ emoji: "", blurContent: true });
});
