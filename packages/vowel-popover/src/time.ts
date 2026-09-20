/**
 * Relative time via Intl.RelativeTimeFormat (DESIGN.MD §8 i18n: never hardcode
 * formats). Pair with the absolute date as a hover title — never color/short
 * labels alone.
 */

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** "2 days ago" style, locale-aware. */
export const timeAgo = (date: Date): string => {
  const elapsed = (Date.now() - date.getTime()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsInUnit] of UNITS) {
    if (Math.abs(elapsed) >= secondsInUnit || unit === "second") {
      return formatter.format(Math.round(-elapsed / secondsInUnit), unit);
    }
  }
  return absoluteFormatter.format(date);
};

/** Full locale date+time for the hover title. */
export const absoluteDate = (date: Date): string => absoluteFormatter.format(date);

export const formatDuration = (value: number): string => {
  const milliseconds = Math.max(0, Math.round(value));
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
};
