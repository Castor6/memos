import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PreviewImageDialog from "@/components/PreviewImageDialog";

vi.mock("@/hooks/useMediaQuery", () => ({
  __esModule: true,
  default: () => false,
}));

describe("<PreviewImageDialog>", () => {
  it("provides a dialog description without accessibility warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[{ id: "image-1", kind: "image", sourceUrl: "/image.jpg", posterUrl: "/image.jpg", filename: "image.jpg" }]}
      />,
    );

    await waitFor(() => {
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Missing `Description`"));
    });
  });

  it("keeps hook order stable when preview items appear after an empty render", () => {
    const { rerender } = render(<PreviewImageDialog open onOpenChange={vi.fn()} items={[]} />);

    expect(() => {
      rerender(
        <PreviewImageDialog
          open
          onOpenChange={vi.fn()}
          items={[{ id: "image-1", kind: "image", sourceUrl: "/image.jpg", posterUrl: "/image.jpg", filename: "image.jpg" }]}
        />,
      );
    }).not.toThrow();

    expect(screen.getByAltText("Preview image 1 of 1")).toBeInTheDocument();
  });

  it("shows zoom controls for image previews", () => {
    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[{ id: "image-1", kind: "image", sourceUrl: "/image.jpg", posterUrl: "/image.jpg", filename: "image.jpg" }]}
      />,
    );

    expect(screen.getByRole("button", { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset zoom/i })).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("toggles image zoom on double click", () => {
    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[{ id: "image-1", kind: "image", sourceUrl: "/image.jpg", posterUrl: "/image.jpg", filename: "image.jpg" }]}
      />,
    );

    const image = screen.getByAltText("Preview image 1 of 1");

    fireEvent.doubleClick(image);

    expect(image).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(2)" });
    expect(screen.getByText("200%")).toBeInTheDocument();
  });

  it("zooms image previews with the wheel", () => {
    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[{ id: "image-1", kind: "image", sourceUrl: "/image.jpg", posterUrl: "/image.jpg", filename: "image.jpg" }]}
      />,
    );

    fireEvent.wheel(screen.getByTestId("preview-zoom-surface"), { deltaY: -100 });

    expect(screen.getByText("120%")).toBeInTheDocument();
  });

  it("does not show zoom controls for video previews", () => {
    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[{ id: "video-1", kind: "video", sourceUrl: "/video.mp4", posterUrl: "/poster.jpg", filename: "video.mp4" }]}
      />,
    );

    expect(screen.queryByRole("button", { name: /zoom in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /zoom out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset zoom/i })).not.toBeInTheDocument();
  });

  it("keeps previous and next controls available for mobile image galleries", () => {
    render(
      <PreviewImageDialog
        open
        onOpenChange={vi.fn()}
        items={[
          { id: "image-1", kind: "image", sourceUrl: "/image-1.jpg", posterUrl: "/image-1.jpg", filename: "image-1.jpg" },
          { id: "image-2", kind: "image", sourceUrl: "/image-2.jpg", posterUrl: "/image-2.jpg", filename: "image-2.jpg" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /previous item/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next item/i })).toBeInTheDocument();
  });
});

describe("image pointer gestures", () => {
  const setup = () => {
    const view = render(<PreviewImageDialog open onOpenChange={vi.fn()} items={[
      { id: "one", kind: "image", sourceUrl: "/one.png", posterUrl: "/one.png", filename: "one" },
      { id: "two", kind: "image", sourceUrl: "/two.png", posterUrl: "/two.png", filename: "two" },
    ]} />);
    const image = screen.getByAltText("Preview image 1 of 2");
    const surface = image.parentElement!;
    for (const el of [image, surface]) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: 300 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 300 });
    }
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = () => false;
    const pointer = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y });
    return { ...view, image, surface, pointer };
  };
  it("pinches around the midpoint and continues with one-finger panning without jumping", () => {
    const { image, surface, pointer } = setup();
    fireEvent.pointerDown(surface, pointer(1, 100, 150));
    fireEvent.pointerDown(surface, pointer(2, 200, 150));
    fireEvent.pointerMove(surface, pointer(1, 50, 150));
    fireEvent.pointerMove(surface, pointer(2, 250, 150));
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.pointerUp(surface, pointer(2, 250, 150));
    fireEvent.pointerMove(surface, pointer(1, 100, 150));
    expect(image).toHaveStyle({ transform: "translate3d(50px, 0px, 0) scale(2)" });
    fireEvent.pointerMove(surface, pointer(1, 1000, 150));
    expect(image).toHaveStyle({ transform: "translate3d(150px, 0px, 0) scale(2)" });
  });
  it("supports double tap, caps pinch zoom, and resets when switching images", () => {
    const { surface, pointer } = setup();
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(surface, pointer(1, 150, 150));
      fireEvent.pointerUp(surface, pointer(1, 150, 150));
    }
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.pointerDown(surface, pointer(1, 100, 150));
    fireEvent.pointerDown(surface, pointer(2, 200, 150));
    fireEvent.pointerMove(surface, pointer(2, 1200, 150));
    expect(screen.getByText("400%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByAltText("Preview image 2 of 2")).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1)" });
  });
  it("ends a cancelled gesture so later moves do not drag the image", () => {
    const { image, surface, pointer } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.pointerDown(surface, pointer(1, 150, 150));
    fireEvent.pointerCancel(surface, pointer(1, 150, 150));
    fireEvent.pointerMove(surface, pointer(1, 190, 150));
    expect(image).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1.2)" });
  });
});
