import { useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import { useUpdateUserGeneralSetting } from "@/hooks/useUserQueries";
import { getActiveSpace, switchSpace } from "@/lib/personal-space";

export default function SpaceSwitcher() {
  const { currentUser, userGeneralSetting, refetchSettings } = useAuth();
  const update = useUpdateUserGeneralSetting(currentUser?.name);
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  if (!currentUser) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <label className="text-sm text-muted-foreground" htmlFor="personal-space">
        空间
      </label>
      <select
        id="personal-space"
        className="max-w-52 rounded-md border bg-card px-3 py-1.5 text-sm"
        value={getActiveSpace()}
        onChange={(event) => switchSpace(event.target.value)}
      >
        <option value="">个人</option>
        {Object.entries(userGeneralSetting?.spaces || {}).map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
      </select>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" />}>新建空间</PopoverTrigger>
        <PopoverContent className="p-3 w-64" align="start">
          <form
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const title = name.trim();
              if (!title) return;
              try {
                const id = crypto.randomUUID();
                await update.mutateAsync({
                  generalSetting: { spaces: { ...userGeneralSetting?.spaces, [id]: title } },
                  updateMask: ["spaces"],
                });
                await refetchSettings();
                setName("");
                setOpen(false);
                switchSpace(id);
              } catch {
                toast.error("创建空间失败，请重试");
              }
            }}
          >
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="例如：公司"
              aria-label="空间名称"
            />
            <Button type="submit" disabled={update.isPending || !name.trim()}>
              创建
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
