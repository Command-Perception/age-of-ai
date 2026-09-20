import { expect, it } from "vitest";
import { formatDuration } from "./time";
it.each([[42, "42 ms"], [999, "999 ms"], [1000, "1.00 s"], [19008, "19.01 s"], [-2, "0 ms"]])("formats %s with the appropriate unit", (value, expected) => {
  expect(formatDuration(Number(value))).toBe(expected);
});
