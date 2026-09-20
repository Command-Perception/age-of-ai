import { useSyncExternalStore } from "react";

/** Mini equalizer width — keep this tight so it does not crowd the overlay. */
export const WAVEFORM_BAR_COUNT = 4;
export const WAVEFORM_WIDTH = 36;
export const WAVEFORM_HEIGHT = 18;
// The destination worker transcribes PCM16 at 16 kHz; playback remains 24 kHz.
export const VOWEL_INPUT_RATE = 16_000;

export type MicLiveState = {
  readonly live: boolean;
  readonly denied: boolean;
  readonly volume: number;
  readonly frequency: Uint8Array;
};

const frozenFrequency = (): Uint8Array => new Uint8Array(WAVEFORM_BAR_COUNT);

const idleState = (): MicLiveState => ({
  live: false,
  denied: false,
  volume: 0,
  frequency: frozenFrequency(),
});

let micLive: MicLiveState = idleState();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

export const getMicLive = (): MicLiveState => micLive;

export const subscribeMicLive = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setMicLive = (patch: Partial<MicLiveState>): void => {
  micLive = { ...micLive, ...patch };
  notify();
};

export const resetMicLive = (): void => {
  micLive = idleState();
  notify();
};

export const useMicLive = (): MicLiveState =>
  useSyncExternalStore(subscribeMicLive, getMicLive, getMicLive);

export const getMicLiveFlag = (): boolean => micLive.live;

/**
 * Subscribes only to the mic live flag. The full snapshot changes identity on
 * every ~32 ms meter frame, so broad subscribers (e.g. the Admin shell) must
 * use this stable boolean instead — volume/frequency updates then bail out of
 * rendering while the tiny LiveMicLevelMeter keeps the full snapshot.
 */
export const useMicLiveFlag = (): boolean =>
  useSyncExternalStore(subscribeMicLive, getMicLiveFlag, getMicLiveFlag);

export const pcm16AtRate = (
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Int16Array => {
  const outputLength = Math.max(1, Math.floor((samples.length * targetRate) / sourceRate));
  const pcm = new Int16Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const blend = position - left;
    const sample = (samples[left] ?? 0) * (1 - blend) + (samples[right] ?? 0) * blend;
    pcm[index] = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff);
  }
  return pcm;
};

export const pcm16ToBase64 = (pcm: Int16Array): string => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

export const frequencyFromSamples = (samples: Float32Array, barCount: number): Uint8Array => {
  const out = new Uint8Array(barCount);
  const chunk = Math.max(1, Math.floor(samples.length / barCount));
  for (let bar = 0; bar < barCount; bar++) {
    const start = bar * chunk;
    const end = bar === barCount - 1 ? samples.length : start + chunk;
    let energy = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index] ?? 0;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    out[bar] = Math.round(Math.min(1, rms * 36) * 255);
  }
  return out;
};

export const rmsVolume = (samples: Float32Array): number => {
  let energy = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index] ?? 0;
    energy += sample * sample;
  }
  return Math.min(1, Math.sqrt(energy / Math.max(1, samples.length)) * 6);
};

export type MicrophoneCapture = {
  readonly close: () => void;
  readonly setMuted: (muted: boolean) => void;
};

/**
 * Open the mic during the same turn as the click (call getUserMedia before
 * awaiting mint) so the permission prompt is not dropped. Denied permission
 * returns undefined — the session stays text-only.
 */
export const startMicrophoneCapture = async (options: {
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
  readonly onFrame: (frame: {
    readonly speechProbability?: number;
    readonly pcm16: Int16Array;
    readonly volume: number;
    readonly frequency: Uint8Array;
  }) => void;
}): Promise<MicrophoneCapture | undefined> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicLive({ live: false, denied: true, volume: 0, frequency: frozenFrequency() });
    return undefined;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch {
    if (options.signal?.aborted) return undefined;
    setMicLive({ live: false, denied: true, volume: 0, frequency: frozenFrequency() });
    return undefined;
  }

  if (options.signal?.aborted) {
    for (const track of stream.getTracks()) track.stop();
    return undefined;
  }
  let context: AudioContext | undefined;
  let processor: { close: () => void } | undefined;
  let closed = false;
  let muted = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    processor?.close();
    for (const track of stream.getTracks()) track.stop();
    if (context) void context.close().catch(() => undefined);
    resetMicLive();
  };
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    context = new AudioContext();
    await context.resume();
    if (closed) return undefined;
    const { createSpeechCapture } = await import("./speech-capture");
    if (closed) return undefined;
    processor = await createSpeechCapture({
      context, stream,
      ...(options.signal ? { signal: options.signal } : {}),
      onError: (error) => { if (!closed) options.onError?.(error); },
      onFrame: (input, probability) => {
        if (closed) return;
        const samples = muted ? new Float32Array(input.length) : input;
        const volume = rmsVolume(samples);
        const frequency = frequencyFromSamples(samples, WAVEFORM_BAR_COUNT);
        setMicLive({ live: !muted, denied: false, volume, frequency });
        options.onFrame({ pcm16: pcm16AtRate(samples, VOWEL_INPUT_RATE, VOWEL_INPUT_RATE), volume, frequency, speechProbability: muted ? 0 : probability });
      },
    });
    if (closed) { processor.close(); return undefined; }
    setMicLive({ live: true, denied: false });
    return {
      setMuted: (next) => {
        if (closed) return;
        muted = next;
        for (const track of stream.getAudioTracks()) track.enabled = !next;
        if (next) setMicLive({ live: false, volume: 0, frequency: frozenFrequency() });
      },
      close,
    };
  } catch (error) {
    if (closed) return undefined;
    close();
    throw error;
  }
};
