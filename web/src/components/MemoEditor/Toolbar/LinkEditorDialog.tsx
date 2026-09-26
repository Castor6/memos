import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { FormattingController } from "../types/editorController";

export function LinkEditorDialog({
  open,
  onOpenChange,
  controller,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller?: FormattingController;
  onReturnFocus?: () => void;
}) {
  const [url, setURL] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) controller?.restoreSelection?.();
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="sm"
        initialFocus={true}
        finalFocus={() => {
          onReturnFocus?.();
          return false;
        }}
      >
        <DialogTitle>插入链接</DialogTitle>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^https?:\/\//i.test(url)) return;
            controller?.restoreSelection?.();
            controller?.run("link", { url });
            onOpenChange(false);
            setURL("");
          }}
        >
          <Input aria-label="链接地址" placeholder="https://" value={url} onChange={(event) => setURL(event.target.value)} />
          <Button type="submit" disabled={!/^https?:\/\//i.test(url)}>
            插入
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
