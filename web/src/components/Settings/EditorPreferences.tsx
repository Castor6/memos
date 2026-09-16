import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { useUpdateUserGeneralSetting } from "@/hooks/useUserQueries";
import SettingGroup from "./SettingGroup";

export default function EditorPreferences() {
  const { currentUser, userGeneralSetting, refetchSettings } = useAuth();
  const update = useUpdateUserGeneralSetting(currentUser?.name);
  const [enter, setEnter] = useState(false);
  const [words, setWords] = useState("");
  const [limit, setLimit] = useState(0);
  useEffect(() => {
    setEnter(userGeneralSetting?.enterToSave ?? false);
    setWords(userGeneralSetting?.commonWords.join("\n") ?? "");
    setLimit(userGeneralSetting?.previewCharacters ?? 0);
  }, [userGeneralSetting]);
  return (
    <SettingGroup title="编辑与阅读" description="保存在服务器，同一账号的桌面和手机共用。" showSeparator>
      <div className="space-y-5">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            桌面 Enter 保存<small className="block text-muted-foreground mt-1">开启后 Ctrl / Shift + Enter 换行；手机回车始终换行。</small>
          </span>
          <Switch checked={enter} onCheckedChange={setEnter} />
        </label>
        <label className="block text-sm">
          列表预览字数（0 表示不按字数折叠）
          <Input
            type="number"
            min={0}
            max={100000}
            className="mt-2 max-w-40"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
        <label className="block text-sm">
          常用词（每行一个，支持中文和英文）
          <textarea
            className="mt-2 w-full min-h-32 rounded-md border p-3 bg-background"
            value={words}
            onChange={(event) => setWords(event.target.value)}
            placeholder={"tactus\nbrowserrig\n会议记录"}
          />
        </label>
        <Button
          disabled={update.isPending || !Number.isInteger(limit) || limit < 0 || limit > 100000}
          onClick={async () => {
            try {
              await update.mutateAsync({
                generalSetting: {
                  enterToSave: enter,
                  commonWords: Array.from(
                    new Set(
                      words
                        .split("\n")
                        .map((word) => word.trim())
                        .filter(Boolean),
                    ),
                  ),
                  previewCharacters: limit,
                },
                updateMask: ["enter_to_save", "common_words", "preview_characters"],
              });
              await refetchSettings();
              toast.success("已保存");
            } catch {
              toast.error("保存失败，请重试");
            }
          }}
        >
          保存编辑与阅读设置
        </Button>
      </div>
    </SettingGroup>
  );
}
