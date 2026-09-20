import { summarizeVoiceTraces, summarizeVoiceQuality, p95VoiceTrace, voiceCriticalPath, voiceOperationSpans, type VoiceTrace } from "./voice.ts";
import { useEffect, useState } from "react";
const format = (value: number | null | undefined, unit = "ms") => value === undefined || value === null ? "—" : unit === "ms" ? value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms` : value.toFixed(2);
const lanes = ["user", "vad", "turn", "stt", "agent", "llm", "tool", "tts", "audio", "barge_in"];
const stageLane = (label: string): string => ({ Endpoint: "turn", VAD: "vad", STT: "stt", LLM: "llm", Aggregation: "agent", Tool: "tool", TTS: "tts", Playback: "audio" })[label] ?? "turn";
const spanLabel = (lane: string): string => ({ user: "User", vad: "VAD", stt: "STT", llm: "LLM", tool: "Tool", tts: "TTS", audio: "Playback" })[lane] ?? lane;
const ChevronIcon = ({ expanded }: { expanded: boolean }) => <svg aria-hidden="true" viewBox="0 0 16 16"><path d={expanded ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>;
const TrashIcon = () => <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 4h10M6 4V2h4v2m-6 0 .6 9h6.8L12 4M6.5 7v3M9.5 7v3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" /></svg>;
export const VoiceTurnTimeline = ({ trace, forceSpansExpanded, spanExpansionVersion, onHide }: { trace: VoiceTrace; forceSpansExpanded?: boolean | undefined; spanExpansionVersion?: number | undefined; onHide?: (() => void) | undefined }) => {
  const measured = trace.events.filter((event) => event.name !== "quality.review" && event.name !== "session.metadata");
  if (!measured.length) return <p>No responsiveness measurements for this turn.</p>;
  const start = Math.min(...measured.map((event) => event.at)), end = Math.max(...measured.map((event) => event.at)), duration = Math.max(1, end - start);
  const path = voiceCriticalPath(trace.events);
  const spans = voiceOperationSpans(trace.events);
  // A complete response gap is preferred. In-progress or partial turns still
  // retain their measured provider intervals when collapsed.
  const aggregate = path.length ? path : spans.map((span) => ({ label: spanLabel(span.lane), start: span.start, end: span.end, durationMs: span.end - span.start }));
  const aggregateDuration = aggregate.reduce((total, segment) => total + segment.durationMs, 0);
  const [spansExpanded, setSpansExpanded] = useState(true);
  useEffect(() => {
    if (forceSpansExpanded !== undefined) setSpansExpanded(forceSpansExpanded);
  }, [forceSpansExpanded, spanExpansionVersion]);
  const trigger = trace.input?.trim() && trace.input !== "Voice turn" ? trace.input : "Transcript unavailable";
  return <section className="voice-responsiveness voice-turn-timeline" aria-label="Voice turn responsiveness" data-spans-collapsed={!spansExpanded || undefined}>
    <header className="voice-turn-timeline__header"><span className="voice-turn-trigger" title={trigger}>{trigger}</span><div className="voice-turn-actions">{onHide ? <button type="button" className="voice-span-toggle" aria-label="Hide telemetry card" title="Hide telemetry card" onClick={onHide}><TrashIcon /></button> : null}<button type="button" className="voice-span-toggle" aria-label={spansExpanded ? "Collapse spans" : "Show spans"} aria-expanded={spansExpanded} title={spansExpanded ? "Collapse spans" : "Show spans"} onClick={() => setSpansExpanded((value) => !value)}><ChevronIcon expanded={spansExpanded} /></button></div></header>
    {!spansExpanded && aggregate.length > 0 ? <div className="voice-critical-path" aria-label="Response gap aggregate">{aggregate.map((segment, index) => {
      const compact = segment.durationMs / aggregateDuration < .12;
      const label = `${segment.label}: ${format(segment.durationMs)}`;
      return <span aria-label={label} data-compact={compact ? "true" : undefined} data-lane={stageLane(segment.label)} data-tooltip={label} key={`${segment.label}-${segment.start}-${index}`} style={{ flexGrow: segment.durationMs }}><span className="voice-aggregate-label">{segment.label}</span></span>;
    })}</div> : null}
    {spansExpanded ? <div className="voice-lanes" role="img" aria-label={`Overlapping turn timeline spanning ${format(duration)}`}>
      {lanes.filter((lane) => measured.some((event) => event.name.startsWith(`${lane}.`))).map((lane) => {
        const events = measured.filter((event) => event.name.startsWith(`${lane}.`));
        return <div className="voice-lane" data-lane={lane} key={lane}><span>{lane}</span><div className="voice-lane-track"><>{spans.filter((span) => span.lane === lane).map((span) => <i data-lane={lane} data-tooltip={`${lane} duration: ${format(span.end-span.start)}`} key={span.id} style={{ left: `${(span.start-start)/duration*100}%`, width: `${Math.max(.3,(span.end-span.start)/duration*100)}%` }} />)}</>{events.map((event) => <span className="voice-milestone" data-lane={lane} data-tooltip={`${event.name}: +${format(event.at - start)}${event.estimated ? " (derived)" : ""}`} key={event.id} style={{ left: `${(event.at - start) / duration * 100}%` }} />)}</div></div>;
      })}
      <div className="voice-lane"><span>Elapsed</span><div className="voice-axis"><span>0</span><span>{format(duration / 2)}</span><span>{format(duration)}</span></div></div>
    </div> : null}
    <details><summary>Milestones and provider metadata</summary><table><thead><tr><th>Event</th><th>Elapsed</th><th>Attributes</th></tr></thead><tbody>{measured.toSorted((a,b) => a.at-b.at).map((event) => <tr key={event.id}><td>{event.name}{event.estimated ? " ≈" : ""}</td><td>{format(event.at-start)}</td><td>{Object.entries(event.attributes).map(([key,value]) => `${key}=${value}`).join(" · ")}</td></tr>)}</tbody></table></details>
  </section>;
};
export const VoiceResponsiveness = ({ traces }: { traces: ReadonlyArray<VoiceTrace> }) => {
  const metrics = summarizeVoiceTraces(traces), quality = summarizeVoiceQuality(traces), tail = p95VoiceTrace(traces);
  const ttfa = metrics.find((metric) => metric.key === "turn.ttfa")!;
  return <section className="voice-responsiveness" aria-label="Voice responsiveness dashboard">
    <h3>Voice responsiveness</h3><p className="voice-response-note">Measured turns only. Missing values are unavailable, not zero. Goals are directional. Percentiles use the nearest observed rank.</p>
    <div className="voice-metric-table"><table><thead><tr><th>Metric</th><th>Turns</th><th>P50</th><th>P75</th><th>P90</th><th>P95</th><th>P99</th><th>Goal</th></tr></thead><tbody>{metrics.map((metric) => <tr key={metric.key}><th>{metric.label}</th><td>{metric.count}</td>{(["p50", "p75", "p90", "p95", "p99"] as const).map((key) => <td key={key} data-over-goal={metric.goal !== null && metric[key] !== null && metric[key] > metric.goal}>{format(metric[key], metric.unit)}</td>)}<td>{metric.goal === null ? metric.key === "llm.tokens_per_second" ? "↑" : metric.key === "tts.audio_duration_generated" ? "—" : "↓" : `<${metric.goal} ms`}</td></tr>)}</tbody></table></div>
    <details open><summary>TTFA distribution</summary><div className="voice-distribution">{(["p50", "p75", "p90", "p95", "p99"] as const).map((key) => <div key={key}><span>{key.toUpperCase()}</span><meter min={0} max={Math.max(1500, ttfa.p99 ?? 0)} value={ttfa[key] ?? 0} /><b>{format(ttfa[key])}</b></div>)}</div></details>
    {tail && <details><summary>P95 turn composition · {tail.id.slice(0,8)}</summary><p className="voice-response-note">The actual turn at the P95 rank, split at response-gap milestones. These are not summed stage percentiles; lanes preserve overlap.</p><VoiceTurnTimeline trace={tail} /></details>}
    <details open><summary>Quality guardrails</summary><p>Audio underruns: {quality.underruns} gaps in {quality.underrunTurns} / {quality.playbackTurns} playback turns ({quality.playbackTurns ? `${(quality.underrunTurns / quality.playbackTurns * 100).toFixed(1)}%` : "unavailable"}).</p><div className="voice-quality">{quality.reviewed.map((metric) => <span key={metric.key}>{metric.key.replaceAll("_", " ")}<b>{metric.rate === null ? "Unreviewed" : `${(metric.rate * 100).toFixed(1)}%`}</b><small>{metric.failures} failures / {metric.count} reviewed turns</small></span>)}</div></details>
  </section>;
};
