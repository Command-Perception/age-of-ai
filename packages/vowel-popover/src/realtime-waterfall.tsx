import { useEffect, useMemo, useState } from "react";
import { ArrowDownUp, ChevronsDown, ChevronsUp, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import type { TracePhase, TraceTurn } from "./domain";
import { absoluteDate, timeAgo, formatDuration } from "./time";
import { traceTurnTitle, traceWallTime } from "./telemetry";
import "./realtime-waterfall.css";

export type TraceFilter = TracePhase | "all";

const formatMs = formatDuration;

const ToolbarAction = ({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button type="button" variant="outline" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

const phaseLabel = (phase: TracePhase): string =>
  ({ error: "Error", input: "Input", model: "Model", output: "Output", tool: "Tool" })[phase];

const turnHasError = (turn: TraceTurn): boolean =>
  turn.events.some((event) => event.phase === "error");

const turnEndAt = (turn: TraceTurn): number => Math.max(turn.startedAt, ...turn.events.map((event) => event.at + (event.durationMs ?? 0)));

const turnDuration = (turn: TraceTurn): number => Math.max(0, turnEndAt(turn) - turn.startedAt);

const firstSoundMs = (turn: TraceTurn): number | null => {
  const event = turn.events.find((item) => item.label === "First response sound");
  return event ? event.at - turn.startedAt : null;
};

type TraceSegment = { readonly phase: TracePhase; readonly left: number; readonly width: number };

const turnSegments = (turn: TraceTurn): ReadonlyArray<TraceSegment> => {
  const duration = turnDuration(turn);
  if (duration === 0 || turn.events.length === 0) return [];
  const endAt = turnEndAt(turn);
  return turn.events.map((event, index) => {
    const nextAt = event.durationMs === undefined ? turn.events[index + 1]?.at ?? endAt : event.at + event.durationMs;
    return {
      phase: event.phase,
      left: ((event.at - turn.startedAt) / duration) * 100,
      width: Math.max(2, ((nextAt - event.at) / duration) * 100),
    };
  });
};

const AggregateBar = ({ segments }: { readonly segments: ReadonlyArray<TraceSegment> }) => (
  <div className="vowel-waterfall__aggregate" aria-hidden="true">
    {segments.map((segment, index) => (
      <i
        key={index}
        data-phase={segment.phase}
        style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
      />
    ))}
  </div>
);

const TurnRow = ({
  turn,
  expanded,
  expansionVersion,
}: {
  readonly turn: TraceTurn;
  readonly expanded: boolean;
  readonly expansionVersion: number;
}) => {
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(expanded), [expanded, expansionVersion]);

  const duration = turnDuration(turn);
  const firstSound = firstSoundMs(turn);
  const segments = useMemo(() => turnSegments(turn), [turn]);
  const started = traceWallTime(turn.startedAt);

  return (
    <article className="vowel-waterfall__turn" data-error={turnHasError(turn) ? "true" : "false"} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="vowel-waterfall__summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="vowel-waterfall__caret" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
        <span className="vowel-waterfall__input">{turn.input}</span>
        <time className="vowel-waterfall__when" dateTime={started.toISOString()} title={absoluteDate(started)}>
          {timeAgo(started)}
        </time>
        <span className="vowel-waterfall__stats">
          {turn.events.length} events
          {firstSound != null ? ` · First sound ${formatMs(firstSound)}` : ""}
          {duration > 0 ? ` · ${formatMs(duration)}` : ""}
        </span>
        {!open ? <AggregateBar segments={segments} /> : null}
      </button>
      {open ? (
        <ol className="vowel-waterfall__events" aria-label="Events with elapsed time since turn start">
          {turn.events.map((event, index) => {
            const offset = Math.max(0, event.at - turn.startedAt);
            const nextAt = event.durationMs === undefined ? turn.events[index + 1]?.at ?? turnEndAt(turn) : event.at + event.durationMs;
            const width = duration === 0 ? 100 : Math.max(3, ((nextAt - event.at) / duration) * 100);
            const left = duration === 0 ? 0 : Math.min(97, (offset / duration) * 100);
            return (
              <li key={`${turn.id}-${index}`} className="vowel-waterfall__event" data-phase={event.phase}>
                <div className="vowel-waterfall__label">
                  <span>{phaseLabel(event.phase)}</span>
                  <strong>{event.label}</strong>
                  {event.detail ? <code className="vowel-waterfall__detail">{event.detail}</code> : null}
                </div>
                <div
                  className="vowel-waterfall__timeline"
                  aria-label={`${event.label}, ${formatMs(offset)} after request`}
                >
                  <i style={{ width: `${width}%`, left: `${left}%` }} />
                </div>
                <time title={`${formatMs(offset)} elapsed since turn start${event.durationMs === undefined ? "" : `; duration ${formatMs(event.durationMs)}`}`}>
                  +{formatMs(offset)}
                  {event.durationMs !== undefined && <small className="block">{formatMs(event.durationMs)} duration</small>}
                </time>
              </li>
            );
          })}
        </ol>
      ) : null}
    </article>
  );
};

export const RealtimeWaterfall = ({
  turns,
  filter,
  onFilterChange,
  sort,
  onToggleSort,
  expanded,
  onToggleAll,
  expansionVersion,
  onClear,
  emptyMessage = "No turns recorded yet.",
}: {
  readonly turns: ReadonlyArray<TraceTurn>;
  readonly filter: TraceFilter;
  readonly onFilterChange: (filter: TraceFilter) => void;
  readonly sort: "ascending" | "descending";
  readonly onToggleSort: () => void;
  readonly expanded: boolean;
  readonly onToggleAll: () => void;
  readonly expansionVersion: number;
  readonly onClear?: () => void;
  readonly emptyMessage?: string;
}) => {
  const visibleTurns = useMemo(() => {
    const titled = turns.map((turn) => ({ ...turn, input: traceTurnTitle(turn) }));
    const filtered =
      filter === "all"
        ? titled
        : titled.flatMap((turn) => {
            const events = turn.events.filter((event) => event.phase === filter);
            return events.length > 0 ? [{ ...turn, events }] : [];
          });
    return sort === "ascending" ? filtered : [...filtered].reverse();
  }, [filter, sort, turns]);

  return (
    <section aria-label="Realtime waterfall" className="vowel-waterfall">
      <div className="vowel-waterfall__toolbar">
        <label>
          Phase
          <select
            aria-label="Filter by phase"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value as TraceFilter)}
          >
            <option value="all">All</option>
            <option value="input">Input</option>
            <option value="model">Model</option>
            <option value="tool">Tool</option>
            <option value="output">Output</option>
            <option value="error">Error</option>
          </select>
        </label>
        <ToolbarAction label={`Sort: ${sort === "ascending" ? "Oldest first" : "Newest first"}`} onClick={onToggleSort}>
          <ArrowDownUp aria-hidden="true" />
        </ToolbarAction>
        <ToolbarAction label={expanded ? "Collapse all" : "Expand all"} onClick={onToggleAll}>
          {expanded ? <ChevronsUp aria-hidden="true" /> : <ChevronsDown aria-hidden="true" />}
        </ToolbarAction>
        {onClear ? (
          <ToolbarAction label="Clear telemetry" disabled={turns.length === 0} onClick={onClear}>
            <Trash2 aria-hidden="true" />
          </ToolbarAction>
        ) : null}
      </div>
      <div className="vowel-waterfall__list">
        {visibleTurns.length === 0 ? (
          <p>{emptyMessage}</p>
        ) : (
          visibleTurns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} expanded={expanded} expansionVersion={expansionVersion} />
          ))
        )}
      </div>
    </section>
  );
};
