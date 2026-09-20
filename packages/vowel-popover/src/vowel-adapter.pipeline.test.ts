import { describe, expect, it, vi } from "vitest";
import type { VoiceApi } from "./api";
import { Pcm16Player } from "./pcm16-playback";
import { VowelRealtimeAdapter, type VowelClientRuntime, type VowelSocket } from "./vowel-adapter";

class TestSocket extends EventTarget implements VowelSocket {
  readyState = 1;
  readonly sent = vi.fn<(data: string) => void>();
  readonly closed = vi.fn<(code?: number, reason?: string) => void>();
  send(data: string): void { this.sent(data); }
  close(code?: number, reason?: string): void {
    this.closed(code, reason);
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

class TestAudioContext {
  currentTime = 0;
  state = "running";
  baseLatency = 0;
  outputLatency = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly buffers: Float32Array[] = [];
  readonly close = vi.fn(async () => undefined);
  createGain() {
    return {
      gain: { value: 1, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    } as unknown as GainNode;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    this.buffers.push(channel);
    return { duration: length / sampleRate, getChannelData: () => channel } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const source = new EventTarget() as EventTarget & { buffer: AudioBuffer | null; connect: () => void; start: () => void; stop: () => void };
    source.buffer = null;
    source.connect = vi.fn();
    source.start = vi.fn();
    source.stop = () => source.dispatchEvent(new Event("ended"));
    return source as unknown as AudioBufferSourceNode;
  }
}

const voiceApi = (): VoiceApi => ({
  voiceAvailability: async () => ({ available: true }),
  voiceSession: async () => ({ sessionId: "session", clientSecret: "secret", realtimeUrl: "ws://voice.test", expiresAt: 0 }),
  voiceTools: async () => [],
  executeVoiceTool: async (operation) => ({ ok: true, operation }),
});

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const createHarness = () => {
  const sockets: TestSocket[] = [];
  const contexts: TestAudioContext[] = [];
  const frames: Array<(frame: { speechProbability?: number; pcm16: Int16Array; volume: number; frequency: Uint8Array }) => void> = [];
  const micClosed = vi.fn();
  const runtime: VowelClientRuntime = {
    socketOpenState: 1,
    createSocket: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    createPlayback: () => {
      const context = new TestAudioContext();
      contexts.push(context);
      return new Pcm16Player(context as unknown as AudioContext);
    },
    startCapture: async ({ onFrame }) => {
      frames.push(onFrame);
      return { close: micClosed, setMuted: vi.fn() };
    },
    resetMic: vi.fn(),
  };
  return { adapter: new VowelRealtimeAdapter(voiceApi(), undefined, runtime), contexts, frames, micClosed, runtime, sockets };
};

const runTurn = (
  socket: TestSocket,
  frame: (frame: { speechProbability?: number; pcm16: Int16Array; volume: number; frequency: Uint8Array }) => void,
  text: string,
) => {
  frame({ pcm16: new Int16Array([1, -2]), volume: 0.08, frequency: new Uint8Array(4) });
  frame({ pcm16: new Int16Array(2), volume: 0, frequency: new Uint8Array(4) });
  socket.message({ type: "input_audio_buffer.speech_stopped" });
  socket.message({ type: "response.created" });
  socket.message({ type: "response.audio.delta", delta: "AQD+/w==" });
  socket.message({ type: "response.text.delta", delta: text });
  socket.message({ type: "response.done" });
};

describe("VowelRealtimeAdapter injected client pipeline", () => {
  it("streams two turns through real PCM encode, decode, and scheduling", async () => {
    const harness = createHarness();
    const session = harness.adapter.connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    const socket = harness.sockets[0]!;
    const frame = harness.frames[0]!;
    runTurn(socket, frame, "First reply");
    runTurn(socket, frame, "Second reply");

    const appends = socket.sent.mock.calls.map(([wire]) => JSON.parse(wire)).filter((message) => message.type === "input_audio_buffer.append");
    expect(appends).toHaveLength(4);
    expect(appends[0]?.audio).toBe("AQD+/w==");
    expect(harness.contexts[0]?.buffers).toHaveLength(2);
    expect([...harness.contexts[0]!.buffers[0]!]).toEqual([1 / 0x8000, -2 / 0x8000]);
    session.disconnect();
    expect(harness.micClosed).toHaveBeenCalledOnce();
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(socket.closed).toHaveBeenCalledOnce();
  });

  it("restarts the adapter and streams a third turn on a fresh transport", async () => {
    const harness = createHarness();
    const first = harness.adapter.connect({});
    await vi.waitFor(() => expect(first.status.type).toBe("running"));
    runTurn(harness.sockets[0]!, harness.frames[0]!, "First reply");
    first.disconnect();

    const restarted = harness.adapter.connect({});
    await vi.waitFor(() => expect(restarted.status.type).toBe("running"));
    runTurn(harness.sockets[1]!, harness.frames[1]!, "Third reply");
    expect(harness.sockets).toHaveLength(2);
    expect(harness.contexts[1]?.buffers).toHaveLength(1);
    restarted.disconnect();
  });

  it("closes a microphone that resolves after the user stops the session", async () => {
    const harness = createHarness();
    const lateMic = deferred<{ close: () => void; setMuted: (muted: boolean) => void } | undefined>();
    const lateClose = vi.fn();
    const runtime: VowelClientRuntime = { ...harness.runtime, startCapture: async ({ onFrame }) => {
      harness.frames.push(onFrame);
      return lateMic.promise;
    } };
    const adapter = new VowelRealtimeAdapter(voiceApi(), undefined, runtime);
    const session = adapter.connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    session.disconnect();
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
    lateMic.resolve({ close: lateClose, setMuted: vi.fn() });
    await vi.waitFor(() => expect(lateClose).toHaveBeenCalled());
  });

  it("ends the session and closes playback when late microphone setup fails", async () => {
    const harness = createHarness();
    let rejectCapture: (error: Error) => void = () => undefined;
    const runtime: VowelClientRuntime = {
      ...harness.runtime,
      startCapture: async ({ onFrame }) => {
        harness.frames.push(onFrame);
        return new Promise((_, reject: (error: Error) => void) => { rejectCapture = reject; });
      },
    };
    const onError = vi.fn();
    const session = new VowelRealtimeAdapter(voiceApi(), onError, runtime).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    rejectCapture(new Error("Permission device failed"));
    await vi.waitFor(() => expect(session.status).toMatchObject({ type: "ended", reason: "error" }));
    expect(onError).toHaveBeenLastCalledWith("Permission device failed");
    expect(harness.sockets[0]?.closed).toHaveBeenCalledOnce();
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it("mutes a capture that resolves after the user muted during permission setup", async () => {
    const harness = createHarness();
    const lateMic = deferred<{ close: () => void; setMuted: (muted: boolean) => void } | undefined>();
    const setMuted = vi.fn();
    const runtime: VowelClientRuntime = {
      ...harness.runtime,
      startCapture: async ({ onFrame }) => {
        harness.frames.push(onFrame);
        return lateMic.promise;
      },
    };
    const session = new VowelRealtimeAdapter(voiceApi(), undefined, runtime).connect({});
    await vi.waitFor(() => expect(session.status.type).toBe("running"));
    session.mute();
    lateMic.resolve({ close: vi.fn(), setMuted });
    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(true));
    session.disconnect();
  });
});

it("resumes once after all tool calls in a response have completed", async () => {
  const harness = createHarness();
  const session = harness.adapter.connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = harness.sockets[0]!;
  for (const call_id of ["call-1", "call-2"]) socket.message({ type: "response.function_call_arguments.done", response_id: "tools", call_id, name: "calculate", arguments: "{}" });
  await vi.waitFor(() => expect(socket.sent.mock.calls.filter(([wire]) => JSON.parse(wire).item?.type === "function_call_output")).toHaveLength(2));
  expect(socket.sent.mock.calls.filter(([wire]) => JSON.parse(wire).type === "response.create")).toHaveLength(0);
  socket.message({ type: "response.done", response: { id: "tools", status: "completed" } });
  await vi.waitFor(() => expect(socket.sent.mock.calls.filter(([wire]) => JSON.parse(wire).type === "response.create")).toHaveLength(1));
  session.disconnect();
});


it("negotiates client endpointing and uploads only complete speech turns", async () => {
  const harness = createHarness();
  const session = harness.adapter.connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = harness.sockets[0]!;
  const frame = harness.frames[0]!;
  socket.message({ type: "session.created", session: { turn_detection: null } });
  const sendFrame = (speechProbability: number) => frame({ pcm16: new Int16Array(512).fill(speechProbability ? 1000 : 0), volume: speechProbability, speechProbability, frequency: new Uint8Array(4) });
  for (let i = 0; i < 30; i++) sendFrame(0);
  for (let i = 0; i < 5; i++) sendFrame(.9);
  expect(socket.sent.mock.calls.map(([wire]) => JSON.parse(wire)).filter(event => event.type === "input_audio_buffer.append")).toHaveLength(0);
  for (let i = 0; i < 10; i++) sendFrame(0);
  const events = socket.sent.mock.calls.map(([wire]) => JSON.parse(wire));
  expect(events.some(event => event.type === "session.update" && event.session.turn_detection === null)).toBe(true);
  expect(events.filter(event => event.type === "input_audio_buffer.commit")).toHaveLength(1);
  expect(events.filter(event => event.type === "response.create")).toHaveLength(0);
  const count = socket.sent.mock.calls.length;
  for (let i = 0; i < 100; i++) sendFrame(0);
  expect(socket.sent.mock.calls).toHaveLength(count);
  session.disconnect();
});

it("returns background tool output without creating a foreground continuation", async () => {
  const harness = createHarness();
  const session = harness.adapter.connect({});
  await vi.waitFor(() => expect(session.status.type).toBe("running"));
  const socket = harness.sockets[0]!;
  socket.message({ type: "response.function_call_arguments.done", job_id: "job-1", response_id: "job-1", call_id: "worker_call_1", name: "calculate", arguments: "{}" });
  await vi.waitFor(() => expect(socket.sent.mock.calls.some(([wire]) => JSON.parse(wire).item?.call_id === "worker_call_1")).toBe(true));
  socket.message({ type: "response.done", response: { id: "foreground", status: "completed" } });
  expect(socket.sent.mock.calls.filter(([wire]) => JSON.parse(wire).type === "response.create")).toHaveLength(0);
  session.disconnect();
});
