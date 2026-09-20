export type TracePhase = "input" | "model" | "tool" | "output" | "error";

/** Server-side work that belongs to one user question. */
export type TraceScope = "decision" | "worker" | "speech" | "filler";

export interface TraceEvent {
  /** Stable server span/event identifier when one is available. */
  readonly id?: string;
  readonly at: number;
  readonly durationMs?: number;
  readonly label: string;
  readonly phase: TracePhase;
  readonly detail?: string;
  /** The interaction that emitted this event, for concurrent child work. */
  readonly interactionId?: string;
  readonly scope?: TraceScope;
}

export interface TraceInteraction {
  readonly id: string;
  readonly startedAt: number;
  readonly scope?: TraceScope;
  readonly input?: string;
}

export interface TraceUsage {
  readonly interactionId: string;
  readonly estimatedCostUsd: number;
  readonly outcome: "error" | "success";
  readonly llmInputTokens: number;
  readonly llmOutputTokens: number;
  readonly sttDurationMs: number;
  readonly ttsCharacters: number;
}

export interface TraceTurn {
  readonly id: string;
  /** Durable server question id; child interactions with this value share a card. */
  readonly questionId?: string;
  readonly input: string;
  readonly startedAt: number;
  readonly events: ReadonlyArray<TraceEvent>;
  readonly interactions?: ReadonlyArray<TraceInteraction>;
  /** One record per completed interaction, used to derive question totals exactly once. */
  readonly usage?: ReadonlyArray<TraceUsage>;
  readonly sessionId?: string;
}

export interface VoiceSession {
  readonly sessionId: string;
  readonly clientSecret: string;
  readonly expiresAt: number;
  readonly realtimeUrl: string;
}

export interface VoiceTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly operation: string;
  readonly result?: unknown;
  readonly error?: {
    readonly recoverable: boolean;
    readonly code: string;
    readonly message: string;
  };
}

export interface VoiceAvailability {
  readonly available: boolean;
  readonly reason?: string;
}
