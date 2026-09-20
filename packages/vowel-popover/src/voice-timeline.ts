import { telemetryPublisher } from "./telemetry-publisher";
import { useSyncExternalStore } from "react";
import { groupVoiceTracesByQuestion, type VoiceEvent, type VoiceEventName, type VoiceAttributes, type VoiceTrace } from "./wire/telemetry/voice";

const storageKey = "vowel-test-voice-timeline/v1";
const load = (): VoiceTrace[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored as VoiceTrace[] : [];
  } catch { return []; }
};
let traces: VoiceTrace[] = load();
let visibleTraces: ReadonlyArray<VoiceTrace> = groupVoiceTracesByQuestion(traces);
const listeners = new Set<() => void>();
const publish = telemetryPublisher(
  () => { for (const listener of listeners) listener(); },
  () => { try { localStorage.setItem(storageKey, JSON.stringify(traces)); } catch { /* Keep live telemetry if storage is unavailable. */ } },
);
const publishTimeline = (save = true): void => { visibleTraces = groupVoiceTracesByQuestion(traces); publish(save); };
export const addVoiceEvent = (id: string, event: VoiceEvent) => {
  const existing = traces.find((trace) => trace.id === id);
  if (existing?.events.some((value) => value.id === event.id)) return;
  traces = existing ? traces.map((trace) => trace.id === id ? { ...trace, events: [...trace.events, event] } : trace) : [...traces.slice(-49), { id, sessionId: "live", profileId: null, events: [event] }];
  publishTimeline();
};
export const updateVoiceTraceInput = (id: string, input: string): void => {
  if (!input.trim()) return;
  traces = traces.map((trace) => trace.id === id ? { ...trace, input } : trace);
  publishTimeline();
};
const registerVoiceTrace = (id: string, input: string | undefined, questionId?: string): void => {
  const existing = traces.find((trace) => trace.id === id);
  if (existing) {
    if (input && !existing.input?.trim()) updateVoiceTraceInput(id, input);
    if (questionId && existing.questionId !== questionId) {
      traces = traces.map((trace) => trace.id === id ? { ...trace, questionId } : trace);
      publishTimeline();
    }
    return;
  }
  traces = [...traces.slice(-49), { id, sessionId: "live", profileId: null, ...(input ? { input } : {}), ...(questionId ? { questionId } : {}), events: [] }];
  publishTimeline();
};
export const resetVoiceTimeline = (): void => {
  traces = [];
  try { localStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
  publishTimeline(false);
};
export const voiceTimelineSnapshot = (): ReadonlyArray<VoiceTrace> => visibleTraces;
export const useVoiceTimeline = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, voiceTimelineSnapshot, voiceTimelineSnapshot);
const now = () => performance.timeOrigin + performance.now();
type Turn = { clientId: string; id?: string; input?: string; questionId?: string; offset: number; uncertainty: number; pending: VoiceEvent[] };
/** Freeze the clock estimate for each turn so later syncs cannot distort intervals. */
export class VoiceTimelineClient {
  private offset = 0;
  private uncertainty = 60_000;
  private readonly turns = new Map<string, Turn>();
  current: string | undefined;
  constructor(private readonly send: (value: unknown) => void) {}
  clientId(serverId: string) { return [...this.turns.values()].find((turn) => turn.id === serverId)?.clientId; }
  /**
   * Coordinator deliveries have no locally-created user turn. Keep a remote
   * turn for playback milestones without changing the operator's current turn.
   */
  attachServerTurn(interactionId: string, input?: string, questionId?: string): string {
    const existing = this.clientId(interactionId);
    if (existing) {
      const turn = this.turns.get(existing);
      if (input && !turn?.input) this.input(input, existing);
      registerVoiceTrace(interactionId, input, questionId);
      return existing;
    }
    const clientId = crypto.randomUUID();
    this.turns.set(clientId, { clientId, id: interactionId, ...(input ? { input } : {}), ...(questionId ? { questionId } : {}), offset: this.offset, uncertainty: this.uncertainty, pending: [] });
    if (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value!);
    registerVoiceTrace(interactionId, input, questionId);
    return clientId;
  }
  serverId(turnId = this.current) { return turnId ? this.turns.get(turnId)?.id : undefined; }
  input(input: string, turnId = this.current) {
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn || !input.trim()) return;
    turn.input = input;
    if (turn.id) updateVoiceTraceInput(turn.id, input);
  }
  sync() { this.send({ type: "vowel.telemetry.clock", client_at: now() }); }
  start() {
    const clientId = crypto.randomUUID();
    this.turns.set(clientId, { clientId, offset: this.offset, uncertainty: this.uncertainty, pending: [] });
    if (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value!);
    this.current = clientId;
    this.send({ type: "vowel.telemetry.turn.start", client_turn_id: clientId });
    return clientId;
  }
  event(name: VoiceEventName, attributes: VoiceAttributes = {}, at = now(), estimated = false, turnId = this.current) {
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn) return;
    const event: VoiceEvent = { id: crypto.randomUUID(), name, at: at + turn.offset, clock: "client", estimated, uncertaintyMs: turn.uncertainty, attributes };
    if (turn.id && turn.uncertainty < 60_000) { addVoiceEvent(turn.id, event); this.send({ type: "vowel.telemetry.client", interaction_id: turn.id, events: [event] }); }
    else turn.pending.push(event);
  }
  private flush(turn: Turn) {
    if (!turn.id || turn.uncertainty >= 60_000) return;
    for (const event of turn.pending) addVoiceEvent(turn.id, event);
    if (turn.input) updateVoiceTraceInput(turn.id, turn.input);
    while (turn.pending.length) this.send({ type: "vowel.telemetry.client", interaction_id: turn.id, events: turn.pending.splice(0, 64) });
  }
  receive(data: { type: string; [key: string]: unknown }) {
    if (data.type === "vowel.telemetry.clock" && typeof data.client_at === "number" && typeof data.server_at === "number") {
      const received = now(), rtt = received - data.client_at;
      if (rtt >= 0 && rtt / 2 < this.uncertainty) { this.offset = data.server_at - (received + data.client_at) / 2; this.uncertainty = rtt / 2;
        for (const turn of this.turns.values()) {
          if (turn.uncertainty < 60_000) continue;
          turn.pending = turn.pending.map((event) => ({
            ...event, at: event.at + this.offset - turn.offset, uncertaintyMs: this.uncertainty,
          }));
          turn.offset = this.offset;
          turn.uncertainty = this.uncertainty;
          this.flush(turn);
        }
      }
    }
    if (data.type === "vowel.telemetry.interaction.started" && typeof data.client_turn_id === "string" && typeof data.interaction_id === "string") {
      const turn = this.turns.get(data.client_turn_id);
      if (!turn) return;
      turn.id = data.interaction_id;
      if (typeof data.question_id === "string") turn.questionId = data.question_id;
      this.flush(turn);
      registerVoiceTrace(turn.id, turn.input, turn.questionId);
    }
    if (data.type === "vowel.telemetry.interaction.started" && typeof data.interaction_id === "string" && typeof data.client_turn_id !== "string") {
      const input = data.scope === "decision" ? "Router decision"
        : data.scope === "worker" ? "Background worker"
          : data.scope === "filler" || data.speech_kind === "filler" ? "Filler delivery"
            : data.scope === "speech" ? (typeof data.input === "string" && data.input !== "Speech delivery" ? data.input : "Speech delivery")
              : undefined;
      this.attachServerTurn(data.interaction_id, input, typeof data.question_id === "string" ? data.question_id : undefined);
    }
    if (data.type === "vowel.telemetry.event" && typeof data.interaction_id === "string" && data.event && typeof data.event === "object") addVoiceEvent(data.interaction_id, data.event as VoiceEvent);
  }
}
