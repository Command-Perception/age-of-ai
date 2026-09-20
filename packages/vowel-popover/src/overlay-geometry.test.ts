import { expect, it } from "vitest";
import { constrainOverlay } from "./overlay-geometry";

it("keeps a dragged or oversized window inside a smaller viewport", () => {
  expect(constrainOverlay({ left: 900, top: 700, width: 600, height: 500 }, { width: 400, height: 300 }))
    .toEqual({ left: 8, top: 8, width: 384, height: 284 });
});
it("preserves useful minimum dimensions while clamping negative positions", () => {
  expect(constrainOverlay({ left: -10, top: -40, width: 50, height: 20 }, { width: 1200, height: 800 }))
    .toEqual({ left: 8, top: 8, width: 360, height: 80 });
});
