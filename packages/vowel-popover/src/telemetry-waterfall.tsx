import "./wire/telemetry/voice-responsiveness.css";
import { VoiceTurnTimeline } from "./wire/telemetry/voice-responsiveness";
import { resetVoiceTimeline, useVoiceTimeline } from "./voice-timeline";
import { memo, useCallback, useState, useLayoutEffect, useRef } from "react";
import type { VoiceTrace } from "./wire/telemetry/voice";
import { ChevronsDownUp, ChevronsUpDown, Expand as IoExpandOutline, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { RealtimeWaterfall, type TraceFilter } from "./realtime-waterfall";
import { resetTrace, toTraceFilter, useTrace, useCurrentSessionId } from "./telemetry";
import { notify } from "./lib/notify";

const hiddenTraceStorageKey = "vowel-test-hidden-voice-traces/v1";
const loadHiddenTraceIds = (): ReadonlySet<string> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(hiddenTraceStorageKey) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
};

const TimelineRow = memo(({ trace, input, onHideTrace, forceSpansExpanded, spanExpansionVersion }: {
  trace: VoiceTrace; input: string | undefined; onHideTrace: ((id: string) => void) | undefined;
  forceSpansExpanded: boolean | undefined; spanExpansionVersion: number | undefined;
}) => <VoiceTurnTimeline trace={input === undefined || input === trace.input ? trace : { ...trace, input }}
  onHide={onHideTrace ? () => onHideTrace(trace.id) : undefined}
  forceSpansExpanded={forceSpansExpanded} spanExpansionVersion={spanExpansionVersion} />);

export const TelemetryWaterfall = ({
  phase,
  onPhaseChange,
  empty,
  view = "conversations",
  forceSpansExpanded,
  spanExpansionVersion,
  hiddenTraceIds,
  onHideTrace,
  currentSessionOnly = false,
}: {
  readonly currentSessionOnly?: boolean;
  readonly phase: string;
  readonly onPhaseChange?: (phase: string) => void;
  readonly empty: string;
  readonly view?: "responsiveness" | "conversations";
  readonly forceSpansExpanded?: boolean | ((trace: VoiceTrace, latest: boolean) => boolean | undefined);
  readonly spanExpansionVersion?: number;
  readonly hiddenTraceIds?: ReadonlySet<string>;
  readonly onHideTrace?: (id: string) => void;
}) => {
  const allTurns = useTrace();
  const sessionId = useCurrentSessionId();
  const turns = currentSessionOnly ? allTurns.filter(turn => sessionId !== undefined && turn.sessionId === sessionId) : allTurns;
  const allVoiceTraces = useVoiceTimeline();
  const voiceTraces = currentSessionOnly ? allVoiceTraces.filter(trace => turns.some(turn => turn.id === trace.id || turn.questionId === trace.id)) : allVoiceTraces;
  const [sort, setSort] = useState<"ascending" | "descending">("ascending");
  const [expanded, setExpanded] = useState(false);
  const [expansionVersion, setExpansionVersion] = useState(0);
  const filter = toTraceFilter(phase);

  return (
    <>
    {view === "responsiveness" ? voiceTraces.filter((trace) => !hiddenTraceIds?.has(trace.id)).length ? <div className="voice-timeline-list">{voiceTraces.filter((trace) => !hiddenTraceIds?.has(trace.id)).map((trace, index) => {
      const traceInput = trace.input?.trim();
      const input = traceInput && traceInput !== "Voice turn" ? traceInput : turns.find((turn) => turn.id === trace.id)?.input;
      return <TimelineRow forceSpansExpanded={typeof forceSpansExpanded === "function" ? forceSpansExpanded(trace, index === voiceTraces.length - 1) : forceSpansExpanded} key={trace.id} onHideTrace={onHideTrace} spanExpansionVersion={spanExpansionVersion} trace={trace} input={input} />;
    })}</div> : <p className="py-3 text-sm text-muted-foreground">No visible voice responsiveness measurements.</p> : null}
    {view === "conversations" ? <RealtimeWaterfall
      turns={turns}
      filter={filter}
      onFilterChange={(value) => onPhaseChange?.(value === "all" ? "" : value)}
      sort={sort}
      onToggleSort={() => setSort((current) => (current === "ascending" ? "descending" : "ascending"))}
      expanded={expanded}
      onToggleAll={() => {
        setExpanded((current) => !current);
        setExpansionVersion((current) => current + 1);
      }}
      onClear={() => {
        resetTrace();
        resetVoiceTimeline();
      }}
      expansionVersion={expansionVersion}
      emptyMessage={empty}
    /> : null}
    </>
  );
};

/** Overlay fold above the mic bar (≤ 2/3 page). */
export const TelemetryDropdown = ({ onClose, onCollapseAll }: { readonly onClose: () => void; readonly onCollapseAll?: () => void }) => {
  // "auto" keeps only the current turn's spans expanded; prior turns collapse.
  const [spanMode, setSpanMode] = useState<"auto" | "all" | "none">("auto");
  const [spanExpansionVersion, setSpanExpansionVersion] = useState(0);
  const [hiddenTraceIds, setHiddenTraceIds] = useState(loadHiddenTraceIds);
  const sessionId = useCurrentSessionId();
  const turns = useTrace();
  const voiceTraces = useVoiceTimeline().filter(trace => sessionId !== undefined && turns.some(turn => turn.sessionId === sessionId && (turn.id === trace.id || turn.questionId === trace.id)));
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const followLatest = () => { element.scrollTop = element.scrollHeight; };
    followLatest();
    const observer = new ResizeObserver(followLatest);
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [voiceTraces, spanMode, spanExpansionVersion, hiddenTraceIds]);
  const setHidden = useCallback((next: ReadonlySet<string>) => {
    setHiddenTraceIds(next);
    try { localStorage.setItem(hiddenTraceStorageKey, JSON.stringify([...next])); } catch { /* The current view still hides the trace. */ }
  }, []);
  const hideTrace = useCallback((id: string) => {
    const previous = hiddenTraceIds;
    setHidden(new Set(previous).add(id));
    notify({ action: { label: "Undo", onClick: () => setHidden(previous) }, body: "Telemetry card hidden", id: `hide-telemetry-${id}` });
  }, [hiddenTraceIds, setHidden]);
  const hideAll = () => {
    const previous = hiddenTraceIds;
    setHidden(new Set([...previous, ...voiceTraces.map((trace) => trace.id)]));
    notify({ action: { label: "Undo", onClick: () => setHidden(previous) }, body: "Telemetry cards hidden", id: "hide-all-telemetry" });
  };
  const toggleSpans = () => {
    const next = spanMode === "auto" ? "all" : spanMode === "all" ? "none" : "auto";
    setSpanMode(next);
    setSpanExpansionVersion((current) => current + 1);
    if (next !== "all") onCollapseAll?.();
  };
  return (
    <div
      role="region"
      aria-label="Vowel telemetry"
      className="vowel-telemetry-panel min-h-0 flex max-h-[66dvh] flex-col overflow-hidden border-b border-[var(--subtle)]"
    >
      <header className="flex shrink-0 items-center gap-2 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open full telemetry page"
                onClick={() => {
                  onClose();
                  history.pushState({}, "", "/telemetry");
                  dispatchEvent(new PopStateEvent("popstate"));
                }}
              >
            <IoExpandOutline aria-hidden="true" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>Open full page</TooltipContent>
        </Tooltip>
        <h2 className="text-sm font-medium">Telemetry</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Hide all telemetry cards" className="ml-auto" disabled={voiceTraces.every((trace) => hiddenTraceIds.has(trace.id))} onClick={hideAll}>
              <Trash2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide all telemetry cards</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={spanMode === "auto" ? "Expand all spans" : spanMode === "all" ? "Collapse all spans" : "Follow the current turn"}
              onClick={toggleSpans}
            >
              {spanMode === "all" ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{spanMode === "auto" ? "Expand all spans" : spanMode === "all" ? "Collapse all spans" : "Follow the current turn"}</TooltipContent>
        </Tooltip>
      </header>
      <div ref={viewport} className="vowel-telemetry-content min-h-0 overflow-x-hidden overflow-y-auto px-3 pb-3">
        <div ref={content}>
        <TelemetryWaterfall
          currentSessionOnly
          phase=""
          empty="No voice responsiveness measurements yet."
          forceSpansExpanded={(_trace, latest) => spanMode === "auto" ? latest : spanMode === "all"}
          hiddenTraceIds={hiddenTraceIds}
          onHideTrace={hideTrace}
          spanExpansionVersion={spanExpansionVersion}
          view="responsiveness"
        />
        </div>
      </div>
    </div>
  );
};

export type { TraceFilter };
