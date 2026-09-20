/** Timestamp-first responsiveness telemetry. All times are milliseconds. */
export const voiceEventNames = [
  "user.speech_start", "user.speech_end", "vad.speech_end", "turn.committed", "agent.prepare",
  "agent.speculation_started", "agent.speculation_cancelled", "agent.speculation_accepted",
  "stt.request", "stt.first_partial", "stt.final_transcript",
  "llm.request", "llm.first_byte", "llm.first_reasoning_token", "llm.first_answer_token", "llm.first_speakable_chunk", "llm.last_token",
  "tts.text_aggregation", "tts.request", "tts.first_byte", "tts.first_audible_sample", "tts.complete",
  "audio.first_packet_out", "audio.first_packet_in", "audio.playback_start", "audio.playback_end", "audio.underrun",
  "barge_in.speech_start", "barge_in.detected", "barge_in.accepted", "barge_in.cancelled", "barge_in.audio_stopped",
  "tool.request", "tool.complete", "response.complete", "response.cancelled",
  "quality.review", "session.metadata",
] as const;
export type VoiceEventName = typeof voiceEventNames[number];
export type VoiceAttributes = Readonly<Record<string, string | number | boolean>>;
export interface VoiceEvent {
  readonly id: string;
  readonly name: VoiceEventName;
  readonly at: number;
  readonly clock: "client" | "server";
  readonly estimated: boolean;
  readonly uncertaintyMs: number;
  readonly attributes: VoiceAttributes;
}
export interface VoiceTrace {
  readonly id: string;
  readonly sessionId: string;
  readonly profileId: string | null;
  /** Final user speech when the browser receives its transcription. */
  readonly input?: string;
  /** Durable id shared by all interactions created for one user question. */
  readonly questionId?: string;
  readonly events: ReadonlyArray<VoiceEvent>;
}
/** Collapses independently-recorded root and child interactions into one card. */
export const groupVoiceTracesByQuestion = (traces: ReadonlyArray<VoiceTrace>): ReadonlyArray<VoiceTrace> => {
  const grouped = new Map<string, VoiceTrace>();
  for (const trace of traces) {
    const key = trace.questionId ?? trace.id;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, trace.questionId === undefined ? trace : { ...trace, id: key });
      continue;
    }
    const input = current.input?.trim() && current.input !== "Voice turn" ? current.input : trace.input;
    const events = [...current.events, ...trace.events]
      .filter((event, index, source) => source.findIndex((candidate) => candidate.id === event.id) === index)
      .toSorted((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    grouped.set(key, { ...current, ...(input ? { input } : {}), events });
  }
  return [...grouped.values()];
};

export const latencyMetrics = [
  ["turn.ttfa", "End-to-end TTFA", "ms", 700],
  ["turn.endpoint_delay", "Endpoint / EOU", "ms", null],
  ["vad.end_delay", "VAD end delay", "ms", null],
  ["stt.finalization_delay", "STT finalization / TTFS", "ms", null],
  ["llm.ttfb", "LLM first byte", "ms", null],
  ["llm.ttfat", "LLM first answer token", "ms", 700],
  ["llm.reasoning_delay", "Reasoning to answer", "ms", null],
  ["llm.tokens_per_second", "LLM tokens / second", "tokens/s", null],
  ["tts.text_aggregation_delay", "Text aggregation", "ms", null],
  ["tts.ttfb", "TTS first byte", "ms", null],
  ["tts.leading_silence", "TTS leading silence", "ms", null],
  ["tts.ttfa", "TTS first audible sample", "ms", null],
  ["tts.audio_duration_generated", "Audio generated", "ms", null],
  ["tts.real_time_factor", "TTS real-time factor", "ratio", null],
  ["audio.network_delay", "Audio transport", "ms", null],
  ["audio.playback_delay", "Player buffer / output delay", "ms", null],
  ["barge_in.detection_latency", "Barge-in detection", "ms", null],
  ["barge_in.audio_stop_latency", "Barge-in audio stop", "ms", null],
  ["barge_in.cancel_latency", "Barge-in cancellation", "ms", null],
  ["interruption.overlap", "Barge-in over-talk", "ms", null],
] as const;
export type LatencyMetric = typeof latencyMetrics[number][0];
export type VoiceMetrics = Partial<Record<LatencyMetric, number>>;
const first = (events: ReadonlyArray<VoiceEvent>, name: VoiceEventName) => events.filter((event) => event.name === name).toSorted((a, b) => a.at - b.at)[0];
export const deriveVoiceMetrics = (source: ReadonlyArray<VoiceEvent>): VoiceMetrics => {
  // Keep cancelled attempts visible in the trace, but measure the response delivered.
  const cancelledAt = source.filter((event) => event.name === "agent.speculation_cancelled").reduce((latest, event) => Math.max(latest, event.at), -Infinity);
  const discardedRequests = new Set(source.filter((event) =>
    (event.name === "llm.request" || event.name === "tts.request") && event.at < cancelledAt
  ).map((event) => event.attributes.requestId));
  const events = source.filter((event) => {
    if (!event.name.startsWith("llm.") && !event.name.startsWith("tts.")) return true;
    return event.at >= cancelledAt && (event.attributes.requestId === undefined || !discardedRequests.has(event.attributes.requestId));
  });
  const metrics: VoiceMetrics = {};
  const delta = (metric: LatencyMetric, start: VoiceEventName, end: VoiceEventName) => {
    const b = first(events, end);
    const a = b?.attributes.requestId === undefined ? first(events, start) : first(events.filter((event) => event.attributes.requestId === b.attributes.requestId), start);
    if (!a || !b) return;
    // Cross-clock intervals smaller than clock uncertainty are not measurements.
    const uncertainty = a.clock === b.clock ? 0 : a.uncertaintyMs + b.uncertaintyMs;
    if (b.at - a.at < uncertainty) return;
    metrics[metric] = b.at - a.at;
  };
  delta("turn.ttfa", "user.speech_end", "audio.playback_start");
  delta("turn.endpoint_delay", "user.speech_end", "turn.committed");
  delta("vad.end_delay", "user.speech_end", "vad.speech_end");
  delta("stt.finalization_delay", "user.speech_end", "stt.final_transcript");
  delta("llm.ttfb", "llm.request", "llm.first_byte");
  delta("llm.ttfat", "llm.request", "llm.first_answer_token");
  delta("llm.reasoning_delay", "llm.first_reasoning_token", "llm.first_answer_token");
  delta("tts.text_aggregation_delay", "llm.first_answer_token", "llm.first_speakable_chunk");
  delta("tts.ttfb", "tts.request", "tts.first_byte");
  delta("tts.ttfa", "tts.request", "tts.first_audible_sample");
  delta("audio.network_delay", "audio.first_packet_out", "audio.first_packet_in");
  delta("audio.playback_delay", "audio.first_packet_in", "audio.playback_start");
  delta("barge_in.detection_latency", "barge_in.speech_start", "barge_in.detected");
  delta("barge_in.cancel_latency", "barge_in.accepted", "barge_in.cancelled");
  delta("barge_in.audio_stop_latency", "barge_in.detected", "barge_in.audio_stopped");
  delta("interruption.overlap", "barge_in.speech_start", "barge_in.audio_stopped");
  const audible = first(events, "tts.first_audible_sample");
  if (typeof audible?.attributes.leadingSilenceMs === "number") {
    metrics["tts.leading_silence"] = audible.attributes.leadingSilenceMs;
    const byte = first(events.filter((event) => event.attributes.requestId === audible.attributes.requestId), "tts.first_byte");
    const request = first(events.filter((event) => event.attributes.requestId === audible.attributes.requestId), "tts.request");
    if (byte && request) metrics["tts.ttfa"] = byte.at - request.at + audible.attributes.leadingSilenceMs;
  }
  const completions = events.filter((event) => event.name === "tts.complete");
  const audioMs = completions.reduce((sum, event) => sum + (typeof event.attributes.audioDurationMs === "number" ? event.attributes.audioDurationMs : 0), 0);
  if (audioMs > 0) {
    metrics["tts.audio_duration_generated"] = audioMs;
    metrics["tts.real_time_factor"] = completions.reduce((sum, event) => sum + (typeof event.attributes.durationMs === "number" ? event.attributes.durationMs : 0), 0) / audioMs;
  }
  const last = events.filter((event) => event.name === "llm.last_token");
  const tokens = last.reduce((sum, event) => sum + (typeof event.attributes.outputTokens === "number" ? event.attributes.outputTokens : 0), 0);
  const generationMs = last.reduce((sum, event) => sum + (typeof event.attributes.durationMs === "number" ? event.attributes.durationMs : 0), 0);
  if (tokens > 0 && generationMs > 0) metrics["llm.tokens_per_second"] = tokens * 1000 / generationMs;
  return metrics;
};
export const percentile = (values: ReadonlyArray<number>, quantile: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
};
export const summarizeVoiceTraces = (traces: ReadonlyArray<VoiceTrace>) => {
  const turns = traces.map((trace) => deriveVoiceMetrics(trace.events));
  return latencyMetrics.map(([key, label, unit, goal]) => {
    const values = turns.flatMap((turn) => turn[key] === undefined ? [] : [turn[key]]);
    return { key, label, unit, goal, count: values.length, p50: percentile(values, .5), p75: percentile(values, .75), p90: percentile(values, .9), p95: percentile(values, .95), p99: percentile(values, .99) };
  });
};
export const qualityMetrics = ["false_endpoint", "user_cutoff", "false_barge_in", "missed_barge_in"] as const;
export const summarizeVoiceQuality = (traces: ReadonlyArray<VoiceTrace>) => ({
  underruns: traces.reduce((sum, turn) => sum + turn.events.filter((event) => event.name === "audio.underrun").length, 0),
  underrunTurns: traces.filter((turn) => turn.events.some((event) => event.name === "audio.underrun")).length,
  playbackTurns: traces.filter((turn) => turn.events.some((event) => event.name === "audio.playback_start")).length,
  reviewed: qualityMetrics.map((key) => {
    const values = traces.flatMap((turn) => {
      const reviewed = turn.events.filter((event) => event.name === "quality.review" && typeof event.attributes[key] === "boolean").toSorted((a, b) => b.at - a.at)[0];
      return reviewed ? [reviewed.attributes[key] === true] : [];
    });
    return { key, count: values.length, failures: values.filter(Boolean).length, rate: values.length ? values.filter(Boolean).length / values.length : null };
  }),
});

/** Detect non-silent PCM16 while preserving byte alignment across transport reads. */
export class AudiblePcmTracker {
  private remainder: number | undefined;
  private samples = 0;
  private audibleAt: number | undefined;
  feed(bytes: Uint8Array): { firstAudibleOffsetMs?: number; audioDurationMs: number } {
    let index = 0;
    const sample = (low: number, high: number) => {
      const unsigned = low | high << 8;
      const value = unsigned > 32767 ? unsigned - 65536 : unsigned;
      if (this.audibleAt === undefined && Math.abs(value) >= 128) this.audibleAt = this.samples;
      this.samples++;
    };
    if (this.remainder !== undefined && bytes.length) { sample(this.remainder, bytes[0]!); this.remainder = undefined; index = 1; }
    for (; index + 1 < bytes.length; index += 2) sample(bytes[index]!, bytes[index + 1]!);
    if (index < bytes.length) this.remainder = bytes[index];
    return { ...(this.audibleAt === undefined ? {} : { firstAudibleOffsetMs: this.audibleAt / 24 }), audioDurationMs: this.samples / 24 };
  }
}

/** Consecutive milestones on the measured response gap; never sum overlapping provider spans. */
export const voiceCriticalPath = (events: ReadonlyArray<VoiceEvent>) => {
  const start = first(events, "user.speech_end"), end = first(events, "audio.playback_start");
  if (!start || !end || end.at < start.at) return [];
  const milestones = [
    ["Endpoint", "turn.committed"], ["STT", "stt.final_transcript"],
    ["LLM", "llm.first_answer_token"], ["Aggregation", "llm.first_speakable_chunk"],
    ["TTS", "tts.first_audible_sample"], ["Playback", "audio.playback_start"],
  ] as const;
  let cursor = start.at;
  return milestones.flatMap(([label, name]) => {
    const event = first(events, name);
    if (!event || event.at <= cursor || event.at > end.at) return [];
    const segment = { label, start: cursor, end: event.at, durationMs: event.at - cursor };
    cursor = event.at;
    return [segment];
  });
};

export const p95VoiceTrace = (traces: ReadonlyArray<VoiceTrace>) => {
  const measured = traces.flatMap((trace) => { const ttfa = deriveVoiceMetrics(trace.events)["turn.ttfa"]; return ttfa === undefined ? [] : [{ trace, ttfa }]; }).sort((a, b) => a.ttfa - b.ttfa);
  return measured[Math.max(0, Math.ceil(measured.length * .95) - 1)]?.trace;
};

/** OTLP/JSON payload suitable for POSTing to an OpenTelemetry collector /v1/traces. */
export const voiceTracesToOtlp = async (traces: ReadonlyArray<VoiceTrace>) => {
  const hex = async (value: string, length: number) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
  const nanos = (at: number) => String(BigInt(Math.round(at * 1000)) * 1000n);
  const attrs = (attributes: VoiceAttributes) => Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { doubleValue: value } : { stringValue: value } }));
  const sessions = Map.groupBy(traces, (trace) => trace.sessionId);
  const spans = [];
  for (const [sessionId, turns] of sessions) {
    const all = turns.flatMap((turn) => turn.events).filter((event) => event.name !== "quality.review");
    if (!all.length) continue;
    const traceId = await hex(sessionId, 32), sessionSpanId = await hex(`session:${sessionId}`, 16);
    spans.push({ traceId, spanId: sessionSpanId, name: "voice.session", kind: 1, startTimeUnixNano: nanos(Math.min(...all.map((event) => event.at))), endTimeUnixNano: nanos(Math.max(...all.map((event) => event.at))), attributes: attrs({ "session.id": sessionId, ...all.find((event) => event.name === "session.metadata")?.attributes, "observed.window": true }) });
    for (const source of turns) {
      const turn = { ...source, events: source.events.filter((event) => event.name !== "quality.review") };
      if (!turn.events.length) continue;
      const spanId = await hex(turn.id, 16);
      spans.push({ traceId, spanId, parentSpanId: sessionSpanId, name: "voice.turn", kind: 1, startTimeUnixNano: nanos(Math.min(...turn.events.map((event) => event.at))), endTimeUnixNano: nanos(Math.max(...turn.events.map((event) => event.at))), attributes: attrs({ "turn.id": turn.id, "profile.id": turn.profileId ?? "", ...deriveVoiceMetrics(turn.events) }), events: turn.events.map((event) => ({ name: event.name, timeUnixNano: nanos(event.at), attributes: attrs({ ...event.attributes, clock: event.clock, estimated: event.estimated, "clock.uncertainty_ms": event.uncertaintyMs }) })) });
      for (const [group, events] of Map.groupBy(turn.events, (event) => event.name.split(".")[0]!)) {
        spans.push({ traceId, spanId: await hex(`${turn.id}:${group}`, 16), parentSpanId: spanId, name: group === "user" ? "audio.input" : group === "audio" ? "audio.output" : group, kind: 1, startTimeUnixNano: nanos(Math.min(...events.map((event) => event.at))), endTimeUnixNano: nanos(Math.max(...events.map((event) => event.at))), events: events.map((event) => ({ name: event.name, timeUnixNano: nanos(event.at), attributes: attrs(event.attributes) })) });
      }
    }
  }
  return { resourceSpans: [{ resource: { attributes: attrs({ "service.name": "vowel-voice" }) }, scopeSpans: [{ scope: { name: "vowel.telemetry", version: "1" }, spans }] }] };
};

/** Request intervals, distinct from instant milestones and their output sample positions. */
export const voiceOperationSpans = (events: ReadonlyArray<VoiceEvent>) => {
  const pairs = [["user", "user.speech_start", "user.speech_end"], ["vad", "user.speech_end", "vad.speech_end"], ["stt", "stt.request", "stt.final_transcript"], ["llm", "llm.request", "llm.last_token"], ["tts", "tts.request", "tts.complete"], ["tool", "tool.request", "tool.complete"], ["audio", "audio.playback_start", "audio.playback_end"]] as const;
  return pairs.flatMap(([lane, startName, endName]) => events.filter((event) => event.name === startName).flatMap((start) => {
    const end = events.filter((event) => event.name === endName && event.at >= start.at &&
      (start.attributes.requestId === undefined || event.attributes.requestId === start.attributes.requestId) &&
      (start.attributes.callId === undefined || event.attributes.callId === start.attributes.callId)).toSorted((a,b) => a.at-b.at)[0];
    return end ? [{ lane, id: start.id, start: start.at, end: end.at, events: events.filter((event) => event.at >= start.at && event.at <= end.at && event.name.startsWith(`${lane}.`) && (start.attributes.requestId === undefined || event.attributes.requestId === start.attributes.requestId)) }] : [];
  }));
};
