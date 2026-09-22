import { FileAudioIcon, FileStackIcon, ImageIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import type { AttachmentLibraryTab } from "@/hooks/useAttachmentLibrary";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

interface AttachmentLibraryToolbarProps {
  activeTab: AttachmentLibraryTab;
  onTabChange: (tab: AttachmentLibraryTab) => void;
}

const TAB_CONFIG: Array<{
  key: AttachmentLibraryTab;
  labelKey: "media" | "documents" | "audio";
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: "media", labelKey: "media", icon: ImageIcon },
  { key: "audio", labelKey: "audio", icon: FileAudioIcon },
  { key: "documents", labelKey: "documents", icon: FileStackIcon },
];

const AttachmentLibraryToolbar = ({ activeTab, onTabChange }: AttachmentLibraryToolbarProps) => {
  const t = useTranslate();

  return (
    <div className="-mx-1 overflow-x-auto px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max items-center gap-1.5">
        {TAB_CONFIG.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;

          return (
            <Button
              key={tab.key}
              type="button"
              variant="ghost"
              className={cn(
                "h-9 rounded-md px-2.5 text-sm font-medium sm:px-3",
                isActive ? "bg-muted/60 text-foreground shadow-none" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
              onClick={() => onTabChange(tab.key)}
            >
              <Icon className="h-4 w-4" />
              <span>{t(`attachment-library.tabs.${tab.labelKey}`)}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
};

export default AttachmentLibraryToolbar;
