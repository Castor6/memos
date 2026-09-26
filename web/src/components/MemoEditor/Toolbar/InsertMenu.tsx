import { uniqBy } from "lodash-es";
import { FileIcon, ImageIcon, LinkIcon, LoaderIcon, MapPinIcon, MicIcon, PanelTopCloseIcon, PlusIcon } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { LinkMemoDialog, LocationDialog } from "@/components/MemoMetadata";
import type { MapPoint } from "@/components/map/types";
import { useReverseGeocoding } from "@/components/map/useReverseGeocoding";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDebouncedEffect } from "@/hooks";
import type { MemoRelation } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { useFileUpload, useLinkMemo, useLocation } from "../hooks";
import { useEditorContext, useEditorSelector } from "../state";
import type { InsertMenuProps } from "../types";
import type { LocalFile } from "../types/attachment";
import type { EditorController } from "../types/editorController";
import { TOOL_TRIGGER } from "./CommandMenu";
import { LinkEditorDialog } from "./LinkEditorDialog";

const InsertMenu = (props: InsertMenuProps & { controllerRef: RefObject<EditorController | null>; compact?: boolean }) => {
  const t = useTranslate();
  const { actions, dispatch } = useEditorContext();
  const isTodo = useEditorSelector((s) => s.metadata.isTodo);
  const relations = useEditorSelector((s) => s.metadata.relations);
  const { location: initialLocation, onLocationChange, isUploading: isUploadingProp } = props;

  const activeAction = useRef<string | undefined>(undefined);
  const [urlDialogOpen, setURLDialogOpen] = useState(false);
  const controller = props.controllerRef.current?.formatting;
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);

  const { fileInputRef, selectingFlag, handleFileInputChange, handleUploadClick } = useFileUpload((newFiles: LocalFile[]) => {
    newFiles.forEach((file) => dispatch(actions.addLocalFile(file)));
  });

  const linkMemo = useLinkMemo({
    isOpen: linkDialogOpen,
    currentMemoName: props.memoName,
    existingRelations: relations,
    onAddRelation: (relation: MemoRelation) => {
      dispatch(actions.setMetadata({ relations: uniqBy([...relations, relation], (r) => r.relatedMemo?.name) }));
      if (relation.relatedMemo) {
        props.controllerRef.current?.formatting?.restoreSelection?.();
        props.onInsertReference?.(relation.relatedMemo);
      }
      setLinkDialogOpen(false);
    },
  });

  const location = useLocation(props.location);
  const {
    state: locationState,
    locationInitialized,
    handlePositionChange: handleLocationPositionChange,
    getLocation,
    reset: locationReset,
    updateCoordinate,
    setPlaceholder,
  } = location;

  const [debouncedPosition, setDebouncedPosition] = useState<MapPoint | undefined>(undefined);

  useDebouncedEffect(
    () => {
      setDebouncedPosition(locationState.position);
    },
    1000,
    [locationState.position],
  );

  const { data: displayName } = useReverseGeocoding(debouncedPosition?.lat, debouncedPosition?.lng);

  useEffect(() => {
    if (displayName) {
      setPlaceholder(displayName);
    }
  }, [displayName, setPlaceholder]);

  const isUploading = selectingFlag || isUploadingProp;

  const handleOpenLinkDialog = useCallback(() => {
    setLinkDialogOpen(true);
  }, []);

  const handleLocationClick = useCallback(() => {
    setLocationDialogOpen(true);
    if (!initialLocation && !locationInitialized) {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            handleLocationPositionChange({ lat: position.coords.latitude, lng: position.coords.longitude });
          },
          (error) => {
            console.error("Geolocation error:", error);
          },
        );
      }
    }
  }, [initialLocation, locationInitialized, handleLocationPositionChange]);

  const handleLocationConfirm = useCallback(() => {
    const newLocation = getLocation();
    if (newLocation) {
      onLocationChange(newLocation);
      setLocationDialogOpen(false);
    }
  }, [getLocation, onLocationChange]);

  const handleLocationCancel = useCallback(() => {
    locationReset();
    setLocationDialogOpen(false);
  }, [locationReset]);

  const handleMediaUploadClick = useCallback(() => {
    handleUploadClick("image/*,video/*");
  }, [handleUploadClick]);

  const handleFileUploadClick = useCallback(() => {
    handleUploadClick();
  }, [handleUploadClick]);

  // Insert actions (add content).
  const insertItems = [
    {
      key: "details",
      label: "折叠区",
      icon: PanelTopCloseIcon,
      onClick: () => {
        controller?.restoreSelection?.();
        controller?.run("insertDetails");
      },
    },
    { key: "url", label: "链接", icon: LinkIcon, onClick: () => setURLDialogOpen(true) },
    { key: "media", label: t("attachment-library.tabs.media"), icon: ImageIcon, onClick: handleMediaUploadClick },
    { key: "audio", label: t("editor.audio-recorder.trigger"), icon: MicIcon, onClick: props.onAudioRecorderClick },
    { key: "file", label: t("common.file"), icon: FileIcon, onClick: handleFileUploadClick },
    { key: "link", label: t("editor.insert-menu.link-memo"), icon: LinkIcon, onClick: handleOpenLinkDialog },
    { key: "location", label: t("editor.insert-menu.add-location"), icon: MapPinIcon, onClick: handleLocationClick },
  ];

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            activeAction.current = undefined;
            controller?.captureSelection?.();
          } else if (!activeAction.current) {
            controller?.restoreSelection?.();
          }
        }}
      >
        <DropdownMenuTrigger className={TOOL_TRIGGER} disabled={isUploading} aria-label="插入内容" title="插入内容">
          {isUploading ? <LoaderIcon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
          <span className={props.compact ? "sr-only" : ""}>插入</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          finalFocus={() => {
            if (!activeAction.current || activeAction.current === "details") props.controllerRef.current?.focus();
            return false;
          }}
        >
          {insertItems.map((item) => (
            <DropdownMenuItem
              className="min-h-11"
              key={item.key}
              onClick={() => {
                activeAction.current = item.key;
                // Only text-insertion dialogs need to retain the mapped selection.
                if (item.key !== "url" && item.key !== "link") controller?.restoreSelection?.();
                item.onClick?.();
              }}
              disabled={item.key === "link" && isTodo}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <LinkEditorDialog
        onReturnFocus={() => props.controllerRef.current?.focus()}
        open={urlDialogOpen}
        onOpenChange={setURLDialogOpen}
        controller={controller}
      />

      {/* Hidden file input */}
      <input
        className="hidden"
        ref={fileInputRef}
        disabled={isUploading}
        onChange={handleFileInputChange}
        type="file"
        multiple={true}
        accept="*"
      />

      <LinkMemoDialog
        open={linkDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            controller?.restoreSelection?.();
            props.controllerRef.current?.focus();
          }
          setLinkDialogOpen(open);
        }}
        searchText={linkMemo.searchText}
        onSearchChange={linkMemo.setSearchText}
        filteredMemos={linkMemo.filteredMemos}
        isFetching={linkMemo.isFetching}
        onSelectMemo={linkMemo.addMemoRelation}
        isAlreadyLinked={linkMemo.isAlreadyLinked}
      />

      <LocationDialog
        open={locationDialogOpen}
        onOpenChange={setLocationDialogOpen}
        state={locationState}
        onPositionChange={handleLocationPositionChange}
        onUpdateCoordinate={updateCoordinate}
        onPlaceholderChange={setPlaceholder}
        onCancel={handleLocationCancel}
        onConfirm={handleLocationConfirm}
      />
    </>
  );
};

export default InsertMenu;
