import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Phones keep three fixed columns; wider cards add columns of roughly the same tile width. */
export const MEMO_IMAGE_GRID_CLASS = "grid w-full grid-cols-3 gap-1.5 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]";

export const MEMO_IMAGE_TILE_CLASS = "relative aspect-square overflow-hidden rounded-md border border-border/60 bg-muted";

export interface MemoImageGridItem {
  key: string;
  thumbnail: string;
  alt: string;
}

interface Props {
  images: MemoImageGridItem[];
  onOpen?: (index: number) => void;
  /** Extra content rendered inside each tile, e.g. a remove button in the editor. */
  renderOverlay?: (index: number) => ReactNode;
  className?: string;
}

const MemoImageGrid = ({ images, onOpen, renderOverlay, className }: Props) => {
  if (!images.length) return null;
  return (
    <div className={cn(MEMO_IMAGE_GRID_CLASS, className)} data-memo-image-grid>
      {images.map((image, index) => (
        <div key={image.key} className={MEMO_IMAGE_TILE_CLASS}>
          {onOpen ? (
            <button
              type="button"
              className="block size-full cursor-zoom-in"
              aria-label={`查看图片 ${image.alt}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(index);
              }}
            >
              <img className="size-full object-cover" src={image.thumbnail} alt={image.alt} loading="lazy" decoding="async" />
            </button>
          ) : (
            <img className="size-full object-cover" src={image.thumbnail} alt={image.alt} loading="lazy" decoding="async" />
          )}
          {renderOverlay?.(index)}
        </div>
      ))}
    </div>
  );
};

export default MemoImageGrid;
