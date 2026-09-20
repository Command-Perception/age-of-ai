import { afterEach, expect, it, vi } from "vitest";
import { getMicLive, resetMicLive, setMicLive, startMicrophoneCapture } from "./microphone";

vi.mock("./speech-capture", () => ({ createSpeechCapture: async () => ({ close: () => undefined }) }));

afterEach(() => { vi.unstubAllGlobals(); resetMicLive(); });

const fixture = () => {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }], getAudioTracks: () => [{ stop }] };
  const close = vi.fn(async () => undefined);
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const Context = vi.fn(function() {
    return { state: "running", resume: async () => undefined, close, destination: {},
      createMediaStreamSource: node, createScriptProcessor: node, createGain: () => ({ ...node(), gain: { value: 0 } }) };
  });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  return { stream, stop, close, Context };
};

it("closes a microphone AudioContext only once when teardown repeats", async () => {
  const { close, stop } = fixture();
  const capture = await startMicrophoneCapture({ onFrame: () => undefined });
  capture?.close();
  capture?.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});

it("does not create an AudioContext when permission resolves after session cancellation", async () => {
  const { stream, stop, Context } = fixture();
  const controller = new AbortController();
  let allow: ((value: typeof stream) => void) | undefined;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(resolve => { allow = resolve; }) } });
  const capture = startMicrophoneCapture({ signal: controller.signal, onFrame: () => undefined });
  controller.abort();
  allow?.(stream);
  expect(await capture).toBeUndefined();
  expect(Context).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});

it("ignores an old permission rejection after a new microphone becomes live", async () => {
  fixture();
  const controller = new AbortController();
  let rejectPermission: ((error: Error) => void) | undefined;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((_, reject) => { rejectPermission = reject; }) } });
  const capture = startMicrophoneCapture({ signal: controller.signal, onFrame: () => undefined });
  controller.abort();
  setMicLive({ live: true, denied: false });
  rejectPermission?.(new Error("permission denied"));
  expect(await capture).toBeUndefined();
  expect(getMicLive()).toMatchObject({ live: true, denied: false });
});
