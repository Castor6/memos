import { create } from "@bufbuild/protobuf";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys, useTagCounts, useUpdateUserSetting } from "@/hooks/useUserQueries";
import { handleError } from "@/lib/error";
import { renamedTag, renameTagInMemos } from "@/lib/rename-tag";
import { buildUserSettingName } from "@/lib/resource-names";
import { findTagMetadata } from "@/lib/tag";
import {
  UserSetting_Key,
  UserSetting_TagMetadataSchema,
  UserSetting_TagsSettingSchema,
  UserSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

const ICON_GROUPS = [
  ["常用", "⭐ 🌟 ❤️ 📌 🔖 💡 ✅ 🔥 🎯 🚀 💬 📝"],
  ["工作与学习", "💼 📁 📂 📋 📊 📈 📅 ⏰ 📚 📖 🎓 🧠 💻 🛠️ 🔍 🔗"],
  ["生活", "🏠 👨‍👩‍👧‍👦 👤 🐱 🐶 🌱 🌸 ☀️ 🌙 ☕ 🍜 🍎 🛒 🎁 💰 🧾"],
  ["兴趣与出行", "🎨 🎵 🎬 📷 🎮 ⚽ 🏃 🚲 ✈️ 🚗 🗺️ 🏖️ 🏔️ 🧳"],
  ["状态", "😀 😊 🤔 😴 🎉 🏆 💪 🙏 ⚠️ 🚧 ⏳ ❓ 🔒 💤"],
];

export default function TagActionDialog({ tag, action, onClose }: { tag: string; action: "rename" | "icon"; onClose: () => void }) {
  const { currentUser, userTagsSetting, refetchSettings } = useAuth();
  const { filters, setFilters } = useMemoFilterContext();
  const { data: counts = {} } = useTagCounts(true);
  const queryClient = useQueryClient();
  const { mutateAsync: updateSetting } = useUpdateUserSetting();
  const [value, setValue] = useState(action === "rename" ? tag : (userTagsSetting && findTagMetadata(tag, userTagsSetting)?.emoji) || "");
  const attemptedName = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!currentUser || saving) return;
    const next = value.trim();
    if (
      action === "rename" &&
      (!next ||
        new TextEncoder().encode(next).length > 256 ||
        [...next].some((character) => [0, 10, 13, 31].includes(character.charCodeAt(0))))
    ) {
      toast.error("请输入有效标签名称（最多 256 字节）");
      return;
    }
    if (
      action === "rename" &&
      next !== tag &&
      attemptedName.current !== next &&
      Array.from(new Set([tag, ...Object.keys(counts), ...Object.keys(userTagsSetting?.tags || {})])).some((name) => {
        const renamed = renamedTag(name, tag, next);
        return renamed !== name && (counts[renamed] !== undefined || userTagsSetting?.tags[renamed] !== undefined);
      })
    ) {
      toast.error("目标标签已存在，请使用其他名称");
      return;
    }
    if (action === "rename" && next.startsWith(`${tag}/`)) {
      toast.error("不能将标签重命名为它自己的子标签");
      return;
    }
    setSaving(true);
    try {
      const tags = { ...userTagsSetting?.tags };
      if (action === "rename") {
        if (next === tag) {
          onClose();
          return;
        }
        attemptedName.current = next;
        await renameTagInMemos(currentUser.name, tag, next);
        for (const [name, metadata] of Object.entries(tags)) {
          const renamed = renamedTag(name, tag, next);
          if (renamed !== name) {
            delete tags[name];
            tags[renamed] = metadata;
          }
        }
      } else {
        tags[tag] = create(UserSetting_TagMetadataSchema, {
          ...(findTagMetadata(tag, create(UserSetting_TagsSettingSchema, { tags })) || create(UserSetting_TagMetadataSchema)),
          emoji: next,
        });
      }
      await updateSetting({
        setting: create(UserSettingSchema, {
          name: buildUserSettingName(currentUser.name, UserSetting_Key.TAGS),
          value: { case: "tagsSetting", value: create(UserSetting_TagsSettingSchema, { tags }) },
        }),
        updateMask: ["tags"],
      });
      await refetchSettings();
      if (action === "rename")
        setFilters(
          filters.map((filter) => (filter.factor === "tagSearch" ? { ...filter, value: renamedTag(filter.value, tag, next) } : filter)),
        );
      onClose();
    } catch (error) {
      await handleError(error, toast.error, { context: action === "rename" ? "重命名未完成，已更新的笔记会保留，可重试" : "保存图标失败" });
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: memoKeys.all }),
        queryClient.invalidateQueries({ queryKey: userKeys.all }),
      ]);
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent initialFocus onContextMenu={(event) => event.stopPropagation()}>
        <DialogTitle>{action === "rename" ? "重命名标签" : "设置图标"}</DialogTitle>
        <p className="my-3 break-all text-sm text-muted-foreground">{tag}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex min-h-0 flex-col gap-4"
        >
          <Input
            aria-label={action === "rename" ? "标签名称" : "自定义图标"}
            value={value}
            disabled={saving}
            maxLength={action === "icon" ? 16 : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
          {action === "rename" ? (
            <p className="text-sm text-muted-foreground">同时重命名当前空间笔记、待办和归档中的此标签及子标签，正文不变。</p>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto space-y-3">
              {ICON_GROUPS.map(([title, icons]) => (
                <div key={title}>
                  <p className="mb-1 text-xs text-muted-foreground">{title}</p>
                  <div className="grid grid-cols-8 gap-1">
                    {icons.split(" ").map((icon) => (
                      <Button
                        key={icon}
                        type="button"
                        variant={value === icon ? "secondary" : "ghost"}
                        className="h-9 p-0 text-xl"
                        aria-label={`选择图标 ${icon}`}
                        aria-pressed={value === icon}
                        disabled={saving}
                        onClick={() => setValue(icon)}
                      >
                        {icon}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            {action === "icon" && (
              <Button type="button" variant="ghost" disabled={saving} onClick={() => setValue("")}>
                恢复默认
              </Button>
            )}
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving || (action === "rename" && (!value.trim() || value.trim() === tag))}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
