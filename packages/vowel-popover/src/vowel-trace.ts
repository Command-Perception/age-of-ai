import type { TracePhase } from "./domain";

// The Admin catalog contains only immediate, read-only sample tools.
export const HUMAN_VOICE_TOOLS: ReadonlyArray<string> = [];

export type VowelTraceAction =
  | { readonly kind: "begin-audio" }
  | { readonly kind: "cancel" }
  | { readonly kind: "first-audio" }
  | { readonly kind: "first-text" }
  | {
      readonly kind: "event";
      readonly phase: TracePhase;
      readonly label: string;
      readonly detail?: string;
      readonly followUp?: { readonly phase: TracePhase; readonly label: string };
    };

const errorDetail = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { readonly type?: unknown; readonly message?: unknown };
  const parts = [record.type, record.message].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(": ") : undefined;
};

export const vowelTraceAction = (
  type: string,
  payload: { readonly name?: string; readonly error?: unknown } = {},
): VowelTraceAction | null => {
  switch (type) {
    case "input_audio_buffer.committed":
      return { kind: "begin-audio" };
    case "conversation.item.input_audio_transcription.completed":
      return { kind: "event", phase: "input", label: "Speech transcribed" };
    case "response.created":
      return { kind: "event", phase: "model", label: "Response started" };
    case "response.function_call_arguments.done": {
      const name = payload.name ?? "";
      const human = (HUMAN_VOICE_TOOLS as ReadonlyArray<string>).includes(name);
      return {
        kind: "event",
        phase: "tool",
        label: name ? `Tool requested: ${name}` : "Tool requested",
        ...(human ? { followUp: { phase: "tool" as const, label: "Waiting for confirmation" } } : {}),
      };
    }
    case "response.text.delta":
    case "response.audio_transcript.delta":
      return { kind: "first-text" };
    case "response.audio.delta":
      return { kind: "first-audio" };
    case "response.done":
      return { kind: "event", phase: "output", label: "Response completed" };
    case "response.cancelled":
    case "response.cancel":
      return { kind: "cancel" };
    case "error": {
      const detail = errorDetail(payload.error);
      return {
        kind: "event",
        phase: "error",
        label: detail?.includes("transcription_error") ? "Transcription failed" : "Voice request failed",
        ...(detail ? { detail } : {}),
      };
    }
    default:
      return null;
  }
};

export const toolExecutionDetail = (
  ok: boolean,
  latencyMs: number,
  target?: string,
  status?: string,
): string => {
  const code = status ?? (ok ? "ok" : "error");
  const where = target ? `, ${target}` : "";
  return `${code}, ${latencyMs}ms${where}`;
};
