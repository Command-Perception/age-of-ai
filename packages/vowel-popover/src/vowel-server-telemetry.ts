import type { TracePhase, TraceScope, TraceTurn } from "./domain";

/**
 * Vowel Admin server telemetry frames (`vowel.telemetry.*`). The waterfall
 * is driven by these events first; client-side protocol mapping is fallback.
 */

export interface ServerTelemetryInteractionStarted {
  readonly client_turn_id?: string | undefined;
  readonly correlation_id?: string | undefined;
  readonly input: string;
  readonly interaction_id: string;
  readonly parent_id?: string | null | undefined;
  readonly question_id?: string | undefined;
  readonly scope?: TraceScope | undefined;
  readonly speech_kind?: "answer" | "filler" | undefined;
  readonly started_at: number;
  readonly type: "vowel.telemetry.interaction.started";
}

export interface ServerTelemetrySpanCompleted {
  readonly detail?: string | undefined;
  readonly duration_ms: number;
  readonly interaction_id: string;
  readonly question_id?: string | undefined;
  readonly scope?: TraceScope | undefined;
  readonly span_id?: string | undefined;
  readonly label: string;
  readonly phase: TracePhase;
  readonly started_at: number;
  readonly type: "vowel.telemetry.span.completed";
}

export interface ServerTelemetryInteractionCompleted {
  readonly estimated_cost_usd: number;
  readonly interaction_id: string;
  readonly question_id?: string | undefined;
  readonly scope?: TraceScope | undefined;
  readonly outcome: "error" | "success";
  readonly type: "vowel.telemetry.interaction.completed";
  readonly usage: {
    readonly llm_input_tokens: number;
    readonly llm_output_tokens: number;
    readonly stt_duration_ms: number;
    readonly tts_characters: number;
  };
}

export type ServerTelemetryEvent =
  | ServerTelemetryInteractionStarted
  | ServerTelemetrySpanCompleted
  | ServerTelemetryInteractionCompleted;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const phase = (value: unknown): TracePhase | undefined =>
  value === "input" || value === "model" || value === "output" || value === "tool" || value === "error"
    ? value
    : undefined;

export const parseServerTelemetryEvent = (value: unknown): ServerTelemetryEvent | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "vowel.telemetry.interaction.started") {
    if (
      typeof value.interaction_id !== "string" ||
      typeof value.input !== "string" ||
      typeof value.started_at !== "number"
    ) {
      return undefined;
    }
    return {
      ...(typeof value.client_turn_id === "string" ? { client_turn_id: value.client_turn_id } : {}),
      ...(typeof value.correlation_id === "string" ? { correlation_id: value.correlation_id } : {}),
      input: value.input,
      interaction_id: value.interaction_id,
      ...(typeof value.parent_id === "string" || value.parent_id === null ? { parent_id: value.parent_id } : {}),
      ...(typeof value.question_id === "string" ? { question_id: value.question_id } : {}),
      ...(value.scope === "decision" || value.scope === "worker" || value.scope === "speech" || value.scope === "filler" ? { scope: value.scope } : {}),
      ...(value.speech_kind === "answer" || value.speech_kind === "filler" ? { speech_kind: value.speech_kind } : {}),
      started_at: value.started_at,
      type: value.type,
    };
  }
  if (value.type === "vowel.telemetry.span.completed") {
    const spanPhase = phase(value.phase);
    if (
      spanPhase === undefined ||
      typeof value.interaction_id !== "string" ||
      typeof value.label !== "string" ||
      typeof value.started_at !== "number" ||
      typeof value.duration_ms !== "number"
    ) {
      return undefined;
    }
    return {
      detail: typeof value.detail === "string" ? value.detail : undefined,
      duration_ms: value.duration_ms,
      interaction_id: value.interaction_id,
      ...(typeof value.question_id === "string" ? { question_id: value.question_id } : {}),
      ...(value.scope === "decision" || value.scope === "worker" || value.scope === "speech" || value.scope === "filler" ? { scope: value.scope } : {}),
      ...(typeof value.span_id === "string" ? { span_id: value.span_id } : {}),
      label: value.label,
      phase: spanPhase,
      started_at: value.started_at,
      type: value.type,
    };
  }
  if (value.type === "vowel.telemetry.interaction.completed") {
    if (typeof value.interaction_id !== "string" || !isRecord(value.usage)) return undefined;
    const usage = value.usage;
    if (
      typeof usage.llm_input_tokens !== "number" ||
      typeof usage.llm_output_tokens !== "number" ||
      typeof usage.stt_duration_ms !== "number" ||
      typeof usage.tts_characters !== "number"
    ) {
      return undefined;
    }
    return {
      estimated_cost_usd: typeof value.estimated_cost_usd === "number" ? value.estimated_cost_usd : 0,
      interaction_id: value.interaction_id,
      ...(typeof value.question_id === "string" ? { question_id: value.question_id } : {}),
      ...(value.scope === "decision" || value.scope === "worker" || value.scope === "speech" || value.scope === "filler" ? { scope: value.scope } : {}),
      outcome: value.outcome === "error" ? "error" : "success",
      type: value.type,
      usage: {
        llm_input_tokens: usage.llm_input_tokens,
        llm_output_tokens: usage.llm_output_tokens,
        stt_duration_ms: usage.stt_duration_ms,
        tts_characters: usage.tts_characters,
      },
    };
  }
  return undefined;
};

const usageDetail = (
  usage: ServerTelemetryInteractionCompleted["usage"],
  costUsd: number,
): string =>
  [
    usage.tts_characters > 0 ? `${usage.tts_characters} TTS chars` : undefined,
    usage.stt_duration_ms > 0 ? `${Math.round(usage.stt_duration_ms / 1000)}s STT` : undefined,
    usage.llm_input_tokens + usage.llm_output_tokens > 0
      ? `${usage.llm_input_tokens + usage.llm_output_tokens} LLM tokens`
      : undefined,
    costUsd > 0 ? `$${costUsd.toFixed(4)} est.` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

export const applyServerTelemetryEvent = (
  turns: ReadonlyArray<TraceTurn>,
  event: ServerTelemetryEvent,
  sessionId?: string,
): ReadonlyArray<TraceTurn> => {
  switch (event.type) {
    case "vowel.telemetry.interaction.started":
      return [
        ...turns.slice(-9),
        {
          events: [],
          id: event.interaction_id,
          input: event.input,
          startedAt: event.started_at > 1_000_000_000_000 ? event.started_at - performance.timeOrigin : event.started_at,
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    case "vowel.telemetry.span.completed":
      return turns.map((turn) => {
        if (turn.id !== event.interaction_id) return turn;
        const at = turn.startedAt + event.started_at;
        const previous = turn.events.at(-1);
        if (previous?.label === event.label && previous.detail === event.detail) return turn;
        return {
          ...turn,
          events: [
            ...turn.events,
            {
              at,
              durationMs: Math.max(0, event.duration_ms),
              ...(event.detail ? { detail: event.detail } : {}),
              label: event.label,
              phase: event.phase,
            },
          ].sort((left, right) => left.at - right.at),
        };
      });
    case "vowel.telemetry.interaction.completed": {
      const detail = usageDetail(event.usage, event.estimated_cost_usd);
      if (detail.length === 0) return turns;
      return turns.map((turn) => {
        if (turn.id !== event.interaction_id) return turn;
        const previous = turn.events.at(-1);
        if (previous?.label === "Usage totals") return turn;
        return {
          ...turn,
          events: [
            ...turn.events,
            {
              at: performance.now(),
              detail,
              label: "Usage totals",
              phase: event.outcome === "error" ? "error" as const : "output" as const,
            },
          ].sort((left, right) => left.at - right.at),
        };
      });
    }
  }
};
