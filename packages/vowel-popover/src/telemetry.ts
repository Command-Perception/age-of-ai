import { telemetryPublisher } from "./telemetry-publisher";
import { useSyncExternalStore } from "react";
import type { TraceEvent, TraceInteraction, TracePhase, TraceScope, TraceTurn, TraceUsage } from "./domain";
import type { TraceFilter } from "./realtime-waterfall";
import { parseServerTelemetryEvent, type ServerTelemetryEvent } from "./vowel-server-telemetry";

/**
 * Client telemetry waterfall. A TraceTurn represents one user question; all
 * coordinator, worker, filler, and answer interactions for that question are
 * kept in its single, time-aligned card.
 */

const MAX_TURNS = 50;
const storageKey = "vowel-test-waterfall/v1";
const load = (): Array<TraceTurn> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored as Array<TraceTurn> : [];
  } catch { return []; }
};

let turns: Array<TraceTurn> = load();
let sessionId: string | undefined;
let activeTurnId: string | undefined;
const serverTurnIds = new Set<string>();
const listeners = new Set<() => void>();

const emit = telemetryPublisher(
  () => { for (const listener of listeners) listener(); },
  () => { try { localStorage.setItem(storageKey, JSON.stringify(turns)); } catch { /* Keep live telemetry if storage is unavailable. */ } },
);

const fromServerClock = (at: number): number => at > 1_000_000_000_000 ? at - performance.timeOrigin : at;
const interactionList = (turn: TraceTurn): ReadonlyArray<TraceInteraction> =>
  turn.interactions ?? [{ id: turn.id, startedAt: turn.startedAt }];
const interactionFor = (turn: TraceTurn, id: string): TraceInteraction | undefined =>
  interactionList(turn).find((interaction) => interaction.id === id);
const turnForInteraction = (id: string): TraceTurn | undefined =>
  turns.find((turn) => interactionFor(turn, id) !== undefined);
const turnForQuestion = (questionId: string | undefined): TraceTurn | undefined =>
  questionId === undefined ? undefined : turns.find((turn) => turn.questionId === questionId);
const scopeFor = (event: ServerTelemetryEvent): TraceScope | undefined =>
  event.scope ?? (event.type === "vowel.telemetry.interaction.started" && event.speech_kind === "filler" ? "filler" : undefined);
const scopeLabel = (scope: TraceScope): string =>
  ({ decision: "Coordinator decision", worker: "Background worker", speech: "Answer delivery", filler: "Filler delivery" })[scope];
const scopePhase = (scope: TraceScope): TracePhase =>
  scope === "worker" ? "tool" : scope === "speech" || scope === "filler" ? "output" : "model";
const usefulInput = (input: string): string | undefined =>
  input.trim() && input !== "Voice turn" && input !== "Speech delivery" ? input : undefined;
const sortEvents = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<TraceEvent> =>
  [...events].sort((left, right) => left.at - right.at || (left.id ?? "").localeCompare(right.id ?? ""));
const appendKnownEvent = (turn: TraceTurn, event: TraceEvent): TraceTurn => {
  if (event.id !== undefined && turn.events.some((previous) => previous.id === event.id)) return turn;
  return { ...turn, events: sortEvents([...turn.events, event]) };
};
const addInteraction = (turn: TraceTurn, interaction: TraceInteraction): TraceTurn => {
  const current = interactionList(turn);
  const existing = current.find((entry) => entry.id === interaction.id);
  const interactions = existing
    ? current.map((entry) => entry.id === interaction.id ? { ...entry, ...interaction } : entry)
    : [...current, interaction];
  return { ...turn, interactions };
};
const isChildInteraction = (turn: TraceTurn, interactionId: string): boolean =>
  interactionFor(turn, interactionId)?.scope !== undefined;

export const bindSession = (id: string): void => {
  sessionId = id;
  activeTurnId = undefined;
  serverTurnIds.clear();
  emit(false);
};

export const currentSessionId = (): string | undefined => sessionId;

const mergeCards = (primary: TraceTurn, secondary: TraceTurn): TraceTurn => ({
  ...primary,
  ...(primary.questionId ?? secondary.questionId ? { questionId: primary.questionId ?? secondary.questionId } : {}),
  input: usefulInput(primary.input) ?? secondary.input,
  startedAt: Math.min(primary.startedAt, secondary.startedAt),
  events: sortEvents([...primary.events, ...secondary.events].filter((event, index, source) =>
    event.id === undefined || source.findIndex((other) => other.id === event.id) === index,
  )),
  interactions: [...interactionList(primary), ...interactionList(secondary)].filter((interaction, index, source) =>
    source.findIndex((other) => other.id === interaction.id) === index,
  ),
});

const replaceCard = (before: TraceTurn, after: TraceTurn): void => {
  turns = turns.map((turn) => turn === before ? after : turn);
  if (activeTurnId === before.id) activeTurnId = after.id;
};

const startServerInteraction = (event: Extract<ServerTelemetryEvent, { type: "vowel.telemetry.interaction.started" }>): void => {
  const scope = scopeFor(event);
  const startedAt = fromServerClock(event.started_at);
  const pending = scope === undefined
    ? turns.find((turn) => turn.id === activeTurnId && !serverTurnIds.has(turn.id))
    : undefined;
  let target = turnForQuestion(event.question_id) ?? turnForInteraction(event.interaction_id);

  // A child can arrive before its root start. Merge that placeholder into the
  // locally-created user card as soon as the root identifies the question.
  if (pending) {
    if (target && target !== pending) {
      const merged = mergeCards(pending, target);
      turns = turns.filter((turn) => turn !== target).map((turn) => turn === pending ? merged : turn);
      target = merged;
    } else target = pending;
  }

  if (!target) {
    const cardId = scope !== undefined && event.question_id !== undefined ? event.question_id : event.interaction_id;
    target = {
      id: cardId,
      ...(event.question_id ? { questionId: event.question_id } : {}),
      input: usefulInput(event.input) ?? "Voice turn",
      startedAt,
      events: [],
      interactions: [],
      ...(sessionId ? { sessionId } : {}),
    };
    turns = [...turns.slice(-(MAX_TURNS - 1)), target];
  }

  const rootStart = scope === undefined;
  const nextId = rootStart ? event.interaction_id : target.id;
  let updated: TraceTurn = {
    ...target,
    id: nextId,
    ...(event.question_id ? { questionId: event.question_id } : {}),
    input: rootStart ? usefulInput(event.input) ?? target.input : target.input,
    startedAt: rootStart && interactionList(target).some((interaction) => interaction.scope !== undefined) ? Math.min(target.startedAt, startedAt) : rootStart ? startedAt : target.startedAt,
  };
  updated = addInteraction(updated, {
    id: event.interaction_id,
    startedAt,
    ...(scope ? { scope } : {}),
    ...(usefulInput(event.input) ? { input: event.input } : {}),
  });
  if (scope !== undefined) {
    updated = appendKnownEvent(updated, {
      id: `started:${event.interaction_id}`,
      at: startedAt,
      ...(usefulInput(event.input) ? { detail: event.input } : {}),
      interactionId: event.interaction_id,
      label: `${scopeLabel(scope)} started`,
      phase: scopePhase(scope),
      scope,
    });
  }
  replaceCard(target, updated);
  if (rootStart) activeTurnId = updated.id;
};

const spanAt = (turn: TraceTurn, interactionId: string, startedAt: number): number =>
  startedAt > 1_000_000_000_000
    ? fromServerClock(startedAt)
    : (interactionFor(turn, interactionId)?.startedAt ?? turn.startedAt) + startedAt;

const applyServerEvent = (event: ServerTelemetryEvent): void => {
  if (event.type === "vowel.telemetry.interaction.started") {
    if (serverTurnIds.has(event.interaction_id)) return;
    serverTurnIds.add(event.interaction_id);
    startServerInteraction(event);
    return;
  }

  const target = turnForInteraction(event.interaction_id) ?? turnForQuestion(event.question_id);
  if (!target) return;
  const scope = scopeFor(event) ?? interactionFor(target, event.interaction_id)?.scope;
  if (event.type === "vowel.telemetry.span.completed") {
    const id = event.span_id ?? `span:${event.interaction_id}:${event.label}:${event.started_at}:${event.duration_ms}`;
    replaceCard(target, appendKnownEvent(target, {
      id,
      at: spanAt(target, event.interaction_id, event.started_at),
      durationMs: Math.max(0, event.duration_ms),
      ...(event.detail ? { detail: event.detail } : {}),
      interactionId: event.interaction_id,
      label: event.label,
      phase: event.phase,
      ...(scope ? { scope } : {}),
    }));
    return;
  }

  const record: TraceUsage = {
    interactionId: event.interaction_id,
    estimatedCostUsd: event.estimated_cost_usd,
    outcome: event.outcome,
    llmInputTokens: event.usage.llm_input_tokens,
    llmOutputTokens: event.usage.llm_output_tokens,
    sttDurationMs: event.usage.stt_duration_ms,
    ttsCharacters: event.usage.tts_characters,
  };
  const records = target.usage ?? [];
  if (records.some((previous) => previous.interactionId === record.interactionId)) return;
  const usage = [...records, record];
  const total = usage.reduce((sum, current) => ({
    estimatedCostUsd: sum.estimatedCostUsd + current.estimatedCostUsd,
    llmInputTokens: sum.llmInputTokens + current.llmInputTokens,
    llmOutputTokens: sum.llmOutputTokens + current.llmOutputTokens,
    sttDurationMs: sum.sttDurationMs + current.sttDurationMs,
    ttsCharacters: sum.ttsCharacters + current.ttsCharacters,
  }), { estimatedCostUsd: 0, llmInputTokens: 0, llmOutputTokens: 0, sttDurationMs: 0, ttsCharacters: 0 });
  const detail = [
    total.ttsCharacters > 0 ? `${total.ttsCharacters} TTS chars` : undefined,
    total.sttDurationMs > 0 ? `${Math.round(total.sttDurationMs / 1000)}s STT` : undefined,
    total.llmInputTokens + total.llmOutputTokens > 0 ? `${total.llmInputTokens + total.llmOutputTokens} LLM tokens` : undefined,
    total.estimatedCostUsd > 0 ? `$${total.estimatedCostUsd.toFixed(4)} est.` : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");
  const childCompletion = isChildInteraction(target, event.interaction_id)
    ? [{
        id: `completed:${event.interaction_id}`,
        at: performance.now(),
        interactionId: event.interaction_id,
        label: `${scopeLabel(scope ?? "worker")} ${event.outcome === "error" ? "failed" : "completed"}`,
        phase: event.outcome === "error" ? "error" as const : scopePhase(scope ?? "worker"),
        scope: scope ?? "worker",
      } satisfies TraceEvent]
    : [];
  const withoutPreviousTotal = target.events.filter((previous) => previous.label !== "Usage totals");
  const next = { ...target, usage, events: sortEvents([
    ...withoutPreviousTotal,
    ...childCompletion,
    ...(detail ? [{
      id: `usage:${target.questionId ?? target.id}`,
      at: performance.now(),
      detail,
      label: "Usage totals",
      phase: usage.some((current) => current.outcome === "error") ? "error" as const : "output" as const,
    }] : []),
  ]) };
  replaceCard(target, next);
};

export const applyServerTrace = (value: unknown): boolean => {
  const event = parseServerTelemetryEvent(value);
  if (!event) return false;
  applyServerEvent(event);
  emit();
  return true;
};

const appendEvent = (turn: TraceTurn, event: Omit<TraceEvent, "at">, at = performance.now()): TraceTurn => {
  const previous = turn.events.at(-1);
  if (previous?.label === event.label && previous?.detail === event.detail) return turn;
  return { ...turn, events: [...turn.events.slice(-511), { ...event, at }] };
};

export const recordTraceEvent = (phase: TracePhase, label: string, detail?: string, turnId?: string, durationMs?: number): void => {
  const targetId = turnId ?? activeTurnId;
  const target = targetId ? turns.find((turn) => turn.id === targetId) : turns.at(-1);
  const duration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
  const event = { label, phase, ...(detail ? { detail } : {}), ...(duration === undefined ? {} : { durationMs: duration }) };
  const at = performance.now() - (duration ?? 0);
  if (target) {
    turns = turns.map((turn) => (turn.id === target.id ? appendEvent(turn, event, at) : turn));
  } else {
    const id = crypto.randomUUID();
    activeTurnId = id;
    turns = [...turns.slice(-MAX_TURNS), { id, input: "", startedAt: at, events: [{ ...event, at }], ...(sessionId ? { sessionId } : {}) }];
  }
  emit();
};

export const beginTraceTurn = (input: string, label = "Turn started"): string => {
  const at = performance.now();
  const id = crypto.randomUUID();
  activeTurnId = id;
  turns = [...turns.slice(-MAX_TURNS), { id, input, startedAt: at, events: [{ at, label, phase: "input" }], ...(sessionId ? { sessionId } : {}) }];
  emit();
  return id;
};

/** The server starts telemetry on the first audio frame, before our silence commit. */
export const beginAudioTraceTurn = (): string => {
  const active = turns.find((turn) => turn.id === activeTurnId);
  if (active && serverTurnIds.has(active.id) && !active.events.some((event) => event.label === "Audio turn committed" || event.label === "Response completed" || event.label === "Usage totals")) {
    recordTraceEvent("input", "Audio turn committed", undefined, active.id);
    return active.id;
  }
  return beginTraceTurn("", "Audio turn committed");
};

export const traceTurnTitle = (turn: TraceTurn): string => {
  if (turn.input.trim() && turn.input !== "Voice turn") return turn.input;
  if (turn.events.some((event) => event.label === "Transcription failed" || event.detail?.includes("transcription_error"))) return "Transcription failed";
  if (turn.events.some((event) => event.phase === "error")) return "Conversation failed";
  if (turn.events.some((event) => event.label === "Response completed" || event.label === "Usage totals")) return "No transcript available";
  return "Waiting for transcript…";
};

export const updateTraceTurnInput = (input: string, turnId?: string): void => {
  const targetId = turnId ?? activeTurnId;
  if (!targetId) return;
  turns = turns.map((turn) => (turn.id === targetId ? { ...turn, input } : turn));
  emit();
};

export const resetTrace = (): void => {
  turns = [];
  sessionId = undefined;
  activeTurnId = undefined;
  serverTurnIds.clear();
  try { localStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
  emit();
};

export const traceSnapshot = (): ReadonlyArray<TraceTurn> => turns;
export const subscribeTrace = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const TRACE_PHASES = ["input", "model", "tool", "output", "error"] as const;
export const filterTraceTurns = (source: ReadonlyArray<TraceTurn>, phase: string): ReadonlyArray<TraceTurn> => {
  if (!phase || phase === "all") return source;
  return source.flatMap((turn) => {
    const events = turn.events.filter((event) => event.phase === phase);
    return events.length > 0 ? [{ ...turn, events }] : [];
  });
};
export const phaseCounts = (source: ReadonlyArray<TraceTurn>): Readonly<Record<TracePhase, number>> => {
  const counts: Record<TracePhase, number> = { input: 0, model: 0, tool: 0, output: 0, error: 0 };
  for (const turn of source) for (const event of turn.events) counts[event.phase] += 1;
  return counts;
};
export const toTraceFilter = (phase: string): TraceFilter => phase && (TRACE_PHASES as ReadonlyArray<string>).includes(phase) ? phase as TracePhase : "all";
/** Wall-clock Date for a turn or event timestamp (absolute performance.now()). */
export const traceWallTime = (at: number): Date => new Date(performance.timeOrigin + at);
/** React hook for the waterfall panel. */
export const useTrace = (): ReadonlyArray<TraceTurn> => useSyncExternalStore(subscribeTrace, traceSnapshot, traceSnapshot);

export const useCurrentSessionId = () => useSyncExternalStore(subscribeTrace, currentSessionId, currentSessionId);
