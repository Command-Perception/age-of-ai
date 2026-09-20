import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { constrainOverlay, type OverlayBounds } from "./overlay-geometry";

export const useOverlayLayout = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<OverlayBounds | null>(null);
  const [resized, setResized] = useState(false);
  const gesture = useRef<{ kind: "move" | "resize"; x: number; y: number; bounds: OverlayBounds } | null>(null);
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const measure = () => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
  };
  useEffect(() => {
    const clamp = () => setBounds((previous) => previous ? constrainOverlay({ ...previous, height: ref.current?.offsetHeight ?? previous.height }, viewport()) : previous);
    window.addEventListener("resize", clamp);
    const observer = new ResizeObserver(clamp);
    if (ref.current) observer.observe(ref.current);
    return () => { window.removeEventListener("resize", clamp); observer.disconnect(); };
  }, []);
  const start = (kind: "move" | "resize", event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const initial = measure();
    if (!initial) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, x: event.clientX, y: event.clientY, bounds: initial };
    if (kind === "resize") setResized(true);
    setBounds(initial);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const next = active.kind === "move"
      ? { ...active.bounds, left: active.bounds.left + dx, top: active.bounds.top + dy }
      : { ...active.bounds, width: Math.min(active.bounds.width + dx, window.innerWidth - active.bounds.left - 8), height: Math.min(active.bounds.height + dy, window.innerHeight - active.bounds.top - 8) };
    setBounds(constrainOverlay(next, viewport()));
  };
  const end = () => { gesture.current = null; };
  const keyboard = (kind: "move" | "resize", event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") { event.preventDefault(); setBounds(null); setResized(false); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const initial = measure();
    if (!initial) return;
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (kind === "resize") setResized(true);
    setBounds(constrainOverlay(kind === "move" ? { ...initial, left: initial.left + dx, top: initial.top + dy } : { ...initial, width: initial.width + dx, height: initial.height + dy }, viewport()));
  };
  const handle = (kind: "move" | "resize") => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => start(kind, event),
    onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => keyboard(kind, event),
    onDoubleClick: () => { setBounds(null); setResized(false); },
  });
  const style: CSSProperties = bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: resized ? bounds.height : undefined, translate: "none" } : {};
  const releaseHeight = () => setResized(false);
  return { ref, style, resized, releaseHeight, moveHandle: handle("move"), resizeHandle: handle("resize") };
};
