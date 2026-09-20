/**
 * PCM16 playback from Vowel Admin (`vowel/cloudflare` apps/admin voice/audio.ts).
 * Odd-length chunks must carry the leftover byte — dropping it desyncs every
 * following sample and sounds like crackle.
 */

export const VOWEL_OUTPUT_RATE = 24_000;

export interface AudioSchedule {
  readonly firstAudibleAt?: number;
  readonly endsAt: number;
  readonly startsAt: number;
}

export interface ScheduledPcmSource {
  readonly source: AudioBufferSourceNode;
}

export const stitchPcm16Bytes = (
  remainder: Uint8Array,
  incoming: Uint8Array,
): { readonly playable: Uint8Array; readonly remainder: Uint8Array } => {
  const bytes = new Uint8Array(remainder.length + incoming.length);
  bytes.set(remainder);
  bytes.set(incoming, remainder.length);
  const playableLength = bytes.length - (bytes.length % 2);
  return {
    playable: bytes.subarray(0, playableLength),
    remainder: bytes.slice(playableLength),
  };
};

export const createPcmPlaybackBus = (context: AudioContext) => {
  const gain = context.createGain();
  gain.gain.setValueAtTime(1, context.currentTime);
  gain.connect(context.destination);
  return gain;
};

export const playPcmBytes = (
  context: AudioContext,
  bus: GainNode,
  incoming: Uint8Array,
  playAt: { current: number },
  remainder: { current: Uint8Array },
  sources: { current: Set<ScheduledPcmSource> },
): AudioSchedule | undefined => {
  const stitched = stitchPcm16Bytes(remainder.current, incoming);
  remainder.current = stitched.remainder;
  if (stitched.playable.length === 0) return undefined;
  const samples = new Int16Array(
    stitched.playable.buffer,
    stitched.playable.byteOffset,
    stitched.playable.length / Int16Array.BYTES_PER_ELEMENT,
  );
  const buffer = context.createBuffer(1, samples.length, VOWEL_OUTPUT_RATE);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) {
    channel[index] = (samples[index] ?? 0) / 0x8000;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  if (sources.current.size === 0) {
    bus.gain.cancelScheduledValues(context.currentTime);
    bus.gain.setValueAtTime(1, context.currentTime);
  }
  source.connect(bus);
  const scheduled = { source };
  sources.current.add(scheduled);
  source.addEventListener("ended", () => sources.current.delete(scheduled), { once: true });
  const at = Math.max(context.currentTime, playAt.current);
  source.start(at);
  playAt.current = at + buffer.duration;
  const audibleIndex = samples.findIndex((sample) => Math.abs(sample) >= 128);
  return { endsAt: playAt.current, startsAt: at, ...(audibleIndex < 0 ? {} : { firstAudibleAt: at + audibleIndex / VOWEL_OUTPUT_RATE }) };
};

export const playPcm = (
  context: AudioContext, bus: GainNode, value: string,
  playAt: { current: number }, remainder: { current: Uint8Array }, sources: { current: Set<ScheduledPcmSource> },
): AudioSchedule | undefined => playPcmBytes(context, bus, Uint8Array.from(atob(value), (character) => character.charCodeAt(0)), playAt, remainder, sources);

export const stopPcmPlayback = (
  context: AudioContext | undefined,
  bus: GainNode | undefined,
  playAt: { current: number },
  remainder: { current: Uint8Array },
  sources: { current: Set<ScheduledPcmSource> },
) => {
  const now = context?.currentTime ?? 0;
  if (bus !== undefined) {
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(0.0001, now + 0.024);
  }
  for (const { source } of sources.current) {
    source.stop(now + 0.028);
  }
  sources.current.clear();
  remainder.current = new Uint8Array();
  playAt.current = context?.currentTime ?? 0;
};

export class Pcm16Player {
  private closed = false;
  private readonly bus: GainNode;
  private readonly playAt = { current: 0 };
  private readonly remainder = { current: new Uint8Array() };
  private readonly sources = { current: new Set<ScheduledPcmSource>() };

  constructor(private readonly context: AudioContext) {
    this.bus = createPcmPlaybackBus(context);
    this.playAt.current = context.currentTime;
  }

  outputTime(at: number): number {
    const stamp = this.context.getOutputTimestamp?.();
    if (stamp?.contextTime && stamp.performanceTime) return performance.timeOrigin + stamp.performanceTime + (at - stamp.contextTime) * 1000;
    return performance.timeOrigin + performance.now() + (at - this.context.currentTime + (this.context.baseLatency || 0) + (this.context.outputLatency || 0)) * 1000;
  }

  stopTime(): number { return this.outputTime(this.context.currentTime + 0.028); }

  get isPlaying(): boolean { return this.sources.current.size > 0; }

  playBase64(base64: string): AudioSchedule | undefined {
    if (this.closed) return undefined;
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
    return playPcm(this.context, this.bus, base64, this.playAt, this.remainder, this.sources);
  }

  playBytes(bytes: Uint8Array): AudioSchedule | undefined {
    if (this.closed) return undefined;
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
    return playPcmBytes(this.context, this.bus, bytes, this.playAt, this.remainder, this.sources);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.sources.current].map(({ source }) => new Promise<void>((resolve) => {
      source.addEventListener("ended", () => resolve(), { once: true });
    })));
  }

  interrupt(): void {
    stopPcmPlayback(this.context, this.bus, this.playAt, this.remainder, this.sources);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    void this.context.close().catch(() => undefined);
  }
}

export const parseVowelJson = (
  data: unknown,
): { readonly type: string; readonly [key: string]: unknown } | undefined => {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return undefined;
    const type = (parsed as { type: unknown }).type;
    if (typeof type !== "string") return undefined;
    return parsed as { type: string; [key: string]: unknown };
  } catch {
    return undefined;
  }
};
