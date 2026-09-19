import { type PointerEvent, useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
type Point = { x: number; y: number };
type Transform = Point & { scale: number };
const initial: Transform = { x: 0, y: 0, scale: 1 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const center = (points: Point[]) => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});

/** Zoom around the gesture center and keep the image within its viewport. */
export function useImageGestures(resetKey: string, enabled: boolean) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [transform, setTransform] = useState<Transform>(initial);
  const current = useRef(initial);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ point: Point; distance: number; transform: Transform } | null>(null);
  const tap = useRef<{ time: number; point: Point } | null>(null);
  const down = useRef<Point | null>(null);
  const moved = useRef(false);
  const lastTouch = useRef(0);

  const apply = (next: Transform) => {
    const surface = surfaceRef.current;
    const image = imageRef.current;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next.scale));
    const maxX = Math.max(0, ((image?.clientWidth ?? 0) * scale - (surface?.clientWidth ?? 0)) / 2);
    const maxY = Math.max(0, ((image?.clientHeight ?? 0) * scale - (surface?.clientHeight ?? 0)) / 2);
    current.current = { scale, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
    setTransform(current.current);
  };
  const reset = () => apply(initial);
  const zoom = (scale: number) => {
    const ratio = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale)) / current.current.scale;
    apply({ scale, x: current.current.x * ratio, y: current.current.y * ratio });
  };
  const toggleZoom = () => zoom(current.current.scale === 1 ? 2 : 1);

  useEffect(() => {
    current.current = initial;
    setTransform(initial);
    pointers.current.clear();
    gesture.current = null;
    tap.current = null;
    down.current = null;
  }, [resetKey, enabled]);

  const point = (event: PointerEvent): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect ? rect.left + rect.width / 2 : 0), y: event.clientY - (rect ? rect.top + rect.height / 2 : 0) };
  };
  const rebase = () => {
    const points = [...pointers.current.values()];
    gesture.current = points.length
      ? {
          point: center(points),
          distance: points.length > 1 ? distance(points[0], points[1]) : 0,
          transform: current.current,
        }
      : null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.pointerType === "touch") lastTouch.current = Date.now();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point(event));
    if (pointers.current.size === 1) {
      down.current = point(event);
      moved.current = false;
    } else {
      moved.current = true;
      tap.current = null;
    }
    rebase();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    const next = point(event);
    if (down.current && distance(next, down.current) > 6) moved.current = true;
    pointers.current.set(event.pointerId, next);
    const points = [...pointers.current.values()];
    const start = gesture.current;
    const midpoint = center(points);
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        MAX_SCALE,
        points.length > 1 && start.distance > 0
          ? (start.transform.scale * distance(points[0], points[1])) / start.distance
          : start.transform.scale,
      ),
    );
    const ratio = scale / start.transform.scale;
    apply({
      scale,
      x: midpoint.x - (start.point.x - start.transform.x) * ratio,
      y: midpoint.y - (start.point.y - start.transform.y) * ratio,
    });
  };
  const finishPointer = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    if (!cancelled && event.pointerType === "touch" && pointers.current.size === 1 && !moved.current) {
      const next = point(event);
      const now = Date.now();
      if (tap.current && now - tap.current.time < 300 && distance(next, tap.current.point) < 24) {
        toggleZoom();
        tap.current = null;
      } else tap.current = { time: now, point: next };
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    rebase();
  };

  return {
    surfaceRef,
    imageRef,
    transform,
    reset,
    zoom,
    toggleZoom: () => {
      if (Date.now() - lastTouch.current > 500) toggleZoom();
    },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finishPointer(event, false),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finishPointer(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finishPointer(event, true),
    },
  };
}
