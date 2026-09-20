import { afterEach, describe, expect, it, vi } from "vitest";
import { VowelRealtimeAdapter } from "./vowel-adapter";
import type { VoiceApi } from "./api";
import { resetTrace } from "./telemetry";
import * as Effect from "effect/Effect";
import { decodeClientRealtimeEventJson } from "./wire/protocol/index";
import { VOICE_TEST_INITIAL_ACTIONS_PROMPT } from "./voice-instructions";
const audio = vi.hoisted(() => ({ close: vi.fn(), captureClose: vi.fn(), capture: vi.fn(), interrupt: vi.fn(), play: vi.fn() }));
vi.mock("./microphone", () => ({
  resetMicLive: vi.fn(),
  pcm16ToBase64: () => "",
  startMicrophoneCapture: audio.capture,
}));
vi.mock("./pcm16-playback", () => ({
  Pcm16Player: class {
    close = audio.close;
    interrupt = audio.interrupt;
    isPlaying = false;
    playBase64 = audio.play;
    outputTime() { return performance.timeOrigin + performance.now() + 1000; }
    stopTime() { return performance.timeOrigin + performance.now() + 28; }
    drain() { return Promise.resolve(); }
  },
  parseVowelJson: (value: unknown) => typeof value === "string" ? JSON.parse(value) : undefined,
}));
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  constructor() { super(); Socket.instances.push(this); }
  send = vi.fn();
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const service = (): VoiceApi => ({
  voiceAvailability: async () => ({ available: true }),
  voiceSession: async () => ({ sessionId: "voice", clientSecret: "ek_test", realtimeUrl: "wss://example.test", expiresAt: 0 }),
  voiceTools: async () => [],
  executeVoiceTool: async (name) => ({ ok: true, operation: name }),
});
const setup = () => {
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("AudioContext", class {});
  audio.capture.mockResolvedValue({ close: audio.captureClose, setMuted: vi.fn() });
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); Socket.instances = []; resetTrace(); });

describe("Vowel voice lifecycle", () => {
  it.each([undefined, "Welcome the user back in one sentence", ""])("sends startup prompt %s once after tools and capture are ready", async initialPrompt => {
    setup();
    let releaseCapture: ((value: undefined) => void) | undefined;
    audio.capture.mockImplementation(() => new Promise<undefined>(resolve => { releaseCapture = resolve; }));
    const api: VoiceApi = { ...service(), ...(initialPrompt === undefined ? {} : { sessionInstructions: { initial_actions_prompt: initialPrompt } }) };
    let releaseTools: ((value: Awaited<ReturnType<VoiceApi["voiceTools"]>>) => void) | undefined;
    api.voiceTools = vi.fn(() => new Promise<Awaited<ReturnType<VoiceApi["voiceTools"]>>>(resolve => { releaseTools = resolve; }));
    const session = new VowelRealtimeAdapter(api).connect({});
    try {
      await vi.waitFor(() => expect(session.status.type).toBe("running"));
      const socket = Socket.instances[0];
      if (!socket) throw new Error("Expected a connected socket");
      const configurations = () => socket.send.mock.calls.map(([data]) => Effect.runSync(decodeClientRealtimeEventJson(String(data)))).filter(event => event.type === "session.update").map(event => event.session);
      expect(configurations().some(config => config.instructions?.includes("Vee"))).toBe(true);
      expect(configurations().some(config => config.initial_actions_prompt !== undefined)).toBe(false);
      releaseTools?.([]);
      await Promise.resolve();
      expect(configurations().some(config => config.initial_actions_prompt !== undefined)).toBe(false);
      releaseCapture?.(undefined);
      await vi.waitFor(() => expect(configurations().filter(config => config.initial_actions_prompt !== undefined)).toHaveLength(1));
      expect(configurations().at(-1)).toMatchObject({ tools: [], initial_actions_prompt: initialPrompt ?? VOICE_TEST_INITIAL_ACTIONS_PROMPT });
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.created", session: { turn_detection: null } }) }));
      await Promise.resolve();
      expect(api.voiceTools).toHaveBeenCalledOnce();
      expect(configurations().filter(config => config.initial_actions_prompt !== undefined)).toHaveLength(1);
    } finally { releaseCapture?.(undefined); session.disconnect(); }
  });

  it("acquires the mic before minting and releases capture and playback on disconnect", async () => {
    setup();
    const api = service();
    api.voiceSession = vi.fn(async () => {
      expect(audio.capture).toHaveBeenCalledOnce();
      return { sessionId: "voice", clientSecret: "ek_test", realtimeUrl: "wss://example.test", expiresAt: 0 };
    });
    const session = new VowelRealtimeAdapter(api).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    session.disconnect();
    expect(audio.captureClose).toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(Socket.instances[0]?.readyState).toBe(3);
  });
  it("keeps the session usable when microphone permission is denied", async () => {
    setup();
    audio.capture.mockResolvedValue(undefined);
    const session = new VowelRealtimeAdapter(service()).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    session.disconnect();
    expect(audio.close).toHaveBeenCalledOnce();
  });
  it("does not open a socket after cancellation during minting", async () => {
    setup();
    const api = service();
    let resolveMint: ((value: Awaited<ReturnType<VoiceApi["voiceSession"]>>) => void) | undefined;
    api.voiceSession = () => new Promise((resolve) => { resolveMint = resolve; });
    const controller = new AbortController();
    new VowelRealtimeAdapter(api).connect({ abortSignal: controller.signal });
    controller.abort();
    resolveMint?.({ sessionId: "voice", clientSecret: "ek_test", realtimeUrl: "wss://example.test", expiresAt: 0 });
    await vi.waitFor(() => expect(audio.captureClose).toHaveBeenCalled());
    expect(Socket.instances).toHaveLength(0);
  });
  it("reports mint failures outside the transient voice runtime state", async () => {
    setup();
    const api = service();
    api.voiceSession = async () => { throw new Error("Failed to fetch"); };
    const onError = vi.fn();
    const session = new VowelRealtimeAdapter(api, onError).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("ended"));
    expect(onError).toHaveBeenLastCalledWith("Failed to fetch");
    expect(audio.captureClose).toHaveBeenCalled();
  });
  it("shows speech recognition failures instead of silently returning to listening", async () => {
    setup();
    const onError = vi.fn();
    const session = new VowelRealtimeAdapter(service(), onError).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    Socket.instances[0]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "error", error: { type: "transcription_error", message: "Speech recognition disconnected. Please restart the voice conversation." }
    }) }));
    expect(onError).toHaveBeenLastCalledWith("Speech recognition disconnected. Please restart the voice conversation.");
    session.disconnect();
  });
  it("keeps socket failure details when the socket subsequently closes", async () => {
    setup();
    const onError = vi.fn();
    const session = new VowelRealtimeAdapter(service(), onError).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    Socket.instances[0]?.dispatchEvent(new Event("error"));
    expect(session.status).toMatchObject({ type: "ended", reason: "error" });
    expect(onError).toHaveBeenLastCalledWith("Cannot connect to Vowel. Check that the realtime server is running.");
  });

  it("finalizes one assistant reply once and ignores the duplicate transcript channel", async () => {
    setup();
    const session = new VowelRealtimeAdapter(service()).connect({});
    const transcripts: Array<{ role: string; text: string; isFinal?: boolean }> = [];
    session.onTranscript((transcript) => transcripts.push(transcript));
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    const frame = (data: unknown) => Socket.instances[0]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    frame({ type: "response.created" });
    frame({ type: "response.text.delta", delta: "It is sunny." });
    frame({ type: "response.audio_transcript.delta", delta: "It is sunny." });
    frame({ type: "response.text.done", text: "It is sunny." });
    frame({ type: "response.done" });
    expect(transcripts.filter((transcript) => transcript.isFinal)).toEqual([{ role: "assistant", text: "It is sunny.", isFinal: true }]);
    expect(transcripts.every((transcript) => transcript.text === "It is sunny.")).toBe(true);
    session.disconnect();
  });

  it("emits speaking mode once per response instead of once per audio chunk", async () => {
    setup();
    const session = new VowelRealtimeAdapter(service()).connect({});
    const modes: string[] = [];
    session.onModeChange((mode) => modes.push(mode));
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    const socket = Socket.instances[0]!;
    const frame = (data: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    frame({ type: "response.created", response: { id: "voice-response-1" } });
    for (let chunk = 0; chunk < 100; chunk++) {
      frame({ type: "response.audio.delta", response_id: "voice-response-1", delta: "AAA=" });
    }
    expect(modes.filter((mode) => mode === "speaking")).toHaveLength(1);
    frame({ type: "response.done", response: { id: "voice-response-1" } });
    frame({ type: "response.created", response: { id: "voice-response-2" } });
    for (let chunk = 0; chunk < 10; chunk++) {
      frame({ type: "response.audio.delta", response_id: "voice-response-2", delta: "AAA=" });
    }
    expect(modes).toEqual(["speaking", "listening", "speaking"]);
    session.disconnect();
  });

});


it("preserves successive speech onsets and endpointing tails while suppressing idle audio", async () => {
  setup();
  const session = new VowelRealtimeAdapter(service()).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = Socket.instances[0]!;
  const { onFrame } = audio.capture.mock.calls[0]![0];
  const now = vi.spyOn(performance, "now");
  const frame = (volume: number, time: number) => {
    now.mockReturnValue(time);
    onFrame({ volume, pcm16: new Int16Array(640), frequency: new Uint8Array(4) });
  };
  socket.send.mockClear();
  for (let turn = 0; turn < 3; turn++) {
    frame(0, turn * 10_000);
    frame(0.08, turn * 10_000 + 100);
    frame(0, turn * 10_000 + 800);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created" }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.done" }) }));
    frame(0, turn * 10_000 + 5000);
  }
  const types = socket.send.mock.calls.map(([wire]) => JSON.parse(wire).type);
  expect(types[0]).toBe("vowel.audio.idle");
  expect(types.filter(type => type === "vowel.audio.idle")).toHaveLength(4);
  expect(types.filter(type => type === "vowel.telemetry.turn.start")).toHaveLength(3);
  expect(types.filter(type => type === "input_audio_buffer.append")).toHaveLength(11);
  expect(types.at(-1)).toBe("vowel.audio.idle");
  expect(session.status.type).toBe("running");
  now.mockRestore();
  session.disconnect();
});

it("accepts normal speech volume to interrupt an active response", async () => {
  setup();
  const session = new VowelRealtimeAdapter(service()).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = Socket.instances[0]!;
  const { onFrame } = audio.capture.mock.calls[0]![0];
  const now = vi.spyOn(performance, "now");
  const frame = (volume: number, time: number) => {
    now.mockReturnValue(time);
    onFrame({ volume, pcm16: new Int16Array(640), frequency: new Uint8Array(4) });
  };
  frame(.08, 100);
  frame(0, 900);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) }));
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created" }) }));
  socket.send.mockClear();
  frame(.08, 1_000);
  expect(socket.send.mock.calls.map(([wire]) => JSON.parse(wire).type)).toEqual(["response.cancel", "vowel.telemetry.turn.start", "input_audio_buffer.append"]);
  now.mockRestore();
  session.disconnect();
});


it("does not report playback that was cancelled before its first audible sample", async () => {
  setup();
  const session = new VowelRealtimeAdapter(service()).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  vi.useFakeTimers();
  const socket = Socket.instances[0]!;
  const { onFrame } = audio.capture.mock.calls[0]![0];
  const frame = (data: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  onFrame({ volume: .1, pcm16: new Int16Array(640), frequency: new Uint8Array(4) });
  const start = socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).find((event) => event.type === "vowel.telemetry.turn.start");
  frame({ type: "vowel.telemetry.interaction.started", interaction_id: "server-turn", client_turn_id: start.client_turn_id, input: "Voice turn", started_at: Date.now() });
  frame({ type: "vowel.telemetry.clock", client_at: performance.timeOrigin + performance.now(), server_at: performance.timeOrigin + performance.now() });
  frame({ type: "response.created", interaction_id: "server-turn" });
  audio.play.mockReturnValue({ firstAudibleAt: 1, startsAt: 0, endsAt: 2 });
  frame({ type: "response.audio.delta", delta: "AAA=" });
  frame({ type: "input_audio_buffer.speech_started" });
  await vi.advanceTimersByTimeAsync(1500);
  const milestones = socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).flatMap((event) => event.events ?? []);
  expect(milestones.some((event) => event.name === "audio.first_packet_in")).toBe(true);
  expect(milestones.some((event) => event.name === "audio.playback_start")).toBe(false);
  expect(audio.interrupt).toHaveBeenCalled();
  session.disconnect();
});

it("does not start a duplicate input turn when the interrupted response finishes during new speech", async () => {
  setup();
  const session = new VowelRealtimeAdapter(service()).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = Socket.instances[0]!;
  const { onFrame } = audio.capture.mock.calls[0]![0];
  const message = (type: string) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type }) }));
  message("response.created");
  onFrame({ volume: .08, pcm16: new Int16Array(640) });
  message("response.done");
  onFrame({ volume: .08, pcm16: new Int16Array(640) });
  expect(socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).filter(e => e.type === "vowel.telemetry.turn.start")).toHaveLength(1);
  session.disconnect();
});

it("plays server-initiated speech, ignores stale PCM, and reports playback lifecycle", async () => {
  setup();
  vi.useFakeTimers();
  audio.play.mockReturnValue({ firstAudibleAt: 0, startsAt: 0, endsAt: 1 });
  const session = new VowelRealtimeAdapter(service()).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = Socket.instances[0]!;
  const frame = (data: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  const ping = socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).find((event) => event.type === "vowel.telemetry.clock");
  frame({ type: "vowel.telemetry.clock", client_at: ping.client_at, server_at: ping.client_at });
  frame({ type: "vowel.telemetry.interaction.started", interaction_id: "speech-trace", input: "The weather is clear.", scope: "speech", started_at: Date.now() });
  frame({ type: "response.created", response: { id: "speech-response" }, interaction_id: "speech-trace", speech_id: "speech-1" });
  frame({ type: "response.audio.delta", response_id: "stale-response", speech_id: "speech-1", delta: "AAA=" });
  expect(audio.play).not.toHaveBeenCalled();
  frame({ type: "response.audio.delta", response_id: "speech-response", speech_id: "speech-1", delta: "AAA=" });
  frame({ type: "response.done", response: { id: "speech-response" } });
  await vi.runAllTimersAsync();
  await Promise.resolve();
  const outbound = socket.send.mock.calls.map(([wire]) => JSON.parse(wire));
  expect(outbound.filter((event) => event.type === "vowel.playback.state")).toEqual([
    { type: "vowel.playback.state", response_id: "speech-response", state: "started" },
    { type: "vowel.playback.state", response_id: "speech-response", state: "completed" },
  ]);
  expect(outbound.flatMap((event) => event.events ?? []).some((event) => event.name === "audio.playback_end")).toBe(true);
  session.disconnect();
});

it("mirrors final voice turns to the optional Avatar Director and interrupts it on barge-in", async () => {
  setup();
  const director = { start: vi.fn(async () => undefined), userTranscript: vi.fn(async () => undefined), assistantTranscript: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const api: VoiceApi = { ...service(), avatarDirector: () => director };
  const session = new VowelRealtimeAdapter(api).connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = Socket.instances[0]!;
  const frame = (data: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  frame({ type: "conversation.item.input_audio_transcription.completed", transcript: "Tell me the forecast" });
  frame({ type: "response.created" });
  frame({ type: "response.text.delta", delta: "It will be sunny." });
  const { onFrame } = audio.capture.mock.calls[0]![0];
  onFrame({ volume: .08, pcm16: new Int16Array(640), frequency: new Uint8Array(4) });
  frame({ type: "response.done" });
  await vi.waitFor(() => {
    expect(director.userTranscript).toHaveBeenCalledWith("Tell me the forecast");
    expect(director.assistantTranscript).toHaveBeenCalledWith("It will be sunny.");
    expect(director.interrupt).toHaveBeenCalledOnce();
  });
  session.disconnect();
  await vi.waitFor(() => expect(director.close).toHaveBeenCalledOnce());
});
