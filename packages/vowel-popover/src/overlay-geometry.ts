export type OverlayBounds = { left: number; top: number; width: number; height: number };
export const constrainOverlay = (bounds: OverlayBounds, viewport: { width: number; height: number }): OverlayBounds => {
  const margin = 8;
  const width = Math.min(Math.max(360, bounds.width), Math.max(1, viewport.width - margin * 2));
  const height = Math.min(Math.max(80, bounds.height), Math.max(1, viewport.height - margin * 2));
  return {
    width, height,
    left: Math.max(margin, Math.min(bounds.left, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(bounds.top, viewport.height - height - margin)),
  };
};
