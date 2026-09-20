/** 16 kHz utterance buffer, bounded to 180 seconds including 256 ms pre-roll. */
interface ClientEndpointResult {
  started: boolean;
  voiced: boolean;
  ended: boolean;
  frames: Int16Array[];
  limit: boolean;
}

/** Long-read utterances commit on a longer pause threshold than short conversational turns. */
const LONG_FORM_SAMPLES = 16_000 * 8;
const LONG_FORM_SILENCE_MS = 800;

export class ClientEndpoint {
  private frames: Int16Array[] = [];
  private samples = 0;
  private voicedSamples = 0;
  private quietSamples = 0;
  private active = false;
  /** The utterance already submitted once at the cap; continued speech appends as a follow-up turn. */
  private flushes = 0;
  constructor(private readonly silenceMs = 320, private readonly maximumSamples = 16_000 * 180) {}
  reset() { this.frames = []; this.samples = 0; this.voicedSamples = 0; this.quietSamples = 0; this.active = false; }
  frame(pcm: Int16Array, probability: number): ClientEndpointResult {
    const voiced = probability >= (this.active ? 0.35 : 0.5);
    const started = voiced && !this.active;
    this.frames.push(pcm.slice());
    this.samples += pcm.length;
    if (voiced) { this.active = true; this.voicedSamples += pcm.length; this.quietSamples = 0; }
    else if (this.active) this.quietSamples += pcm.length;
    else while (this.samples > 4096 && this.frames.length > 1) this.samples -= this.frames.shift()?.length ?? 0;

    if (!this.active) return { started: false, voiced: false, ended: false, frames: [], limit: false };

    // Long reads commit only after a clearly longer pause, so breath silence mid-paragraph
    // does not commit the turn early; conversational turns keep the snappier default.
    const thresholdMs = Math.max(this.silenceMs, this.flushes > 0 || this.voicedSamples >= LONG_FORM_SAMPLES ? LONG_FORM_SILENCE_MS : this.silenceMs);
    const ended = this.quietSamples >= thresholdMs * 16;
    const limit = this.samples >= this.maximumSamples;
    if (!ended && !limit) return { started, voiced, ended: false, frames: [], limit: false };
    // Reject clicks/short noise; at the cap, submit the buffered turn instead of discarding it —
    // speech continuing after the boundary restarts as a follow-up turn.
    const frames = this.voicedSamples >= 16 * 96 ? this.frames : [];
    this.flushes += 1;
    this.reset();
    return { started, voiced, ended: true, frames, limit };
  }
}
