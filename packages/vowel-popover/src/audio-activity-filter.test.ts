import { expect, it } from "vitest";
import { AudioActivityFilter } from "./audio-activity-filter";
it("stops idle traffic, retains pre-roll, and sends enough silence to finalize speech", () => {
  const filter = new AudioActivityFilter();
  const quiet = new Int16Array(640);
  expect(filter.frame(quiet, false, 0)).toEqual({ frames: [], idle: true });
  for (let time = 40; time < 1000; time += 40) expect(filter.frame(quiet, false, time)).toEqual({ frames: [], idle: false });
  const speech = new Int16Array(640).fill(8000);
  const onset = filter.frame(speech, true, 1000);
  expect(onset.frames).toHaveLength(7);
  expect(onset.frames.at(-1)).toBe(speech);
  expect(filter.frame(quiet, false, 2000).frames).toHaveLength(1);
  expect(filter.frame(quiet, false, 2520)).toEqual({ frames: [], idle: true });
  expect(filter.frame(quiet, false, 3000)).toEqual({ frames: [], idle: false });
  expect(filter.frame(speech, true, 3500).frames.at(-1)).toBe(speech);
});
