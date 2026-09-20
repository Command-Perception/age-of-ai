/** Preserve speech onset and an endpointing tail, then stop sending idle PCM. */
export class AudioActivityFilter {
  private readonly preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private lastSpeechAt = -Infinity;
  private active = false;
  private idleReported = false;
  constructor(private readonly tailMs = 1500, private readonly preRollLimit = 4000) {}
  frame(pcm: Int16Array, voiced: boolean, now: number): { frames: ReadonlyArray<Int16Array>; idle: boolean } {
    if (voiced) {
      this.lastSpeechAt = now;
      this.idleReported = false;
      const frames = this.active ? [pcm] : [...this.preRoll, pcm];
      this.active = true;
      this.preRoll.length = 0;
      this.preRollSamples = 0;
      return { frames, idle: false };
    }
    if (this.active && now - this.lastSpeechAt <= this.tailMs) return { frames: [pcm], idle: false };
    this.active = false;
    this.preRoll.push(pcm.slice());
    this.preRollSamples += pcm.length;
    while (this.preRollSamples > this.preRollLimit && this.preRoll.length > 1) this.preRollSamples -= this.preRoll.shift()?.length ?? 0;
    const idle = !this.idleReported;
    this.idleReported = true;
    return { frames: [], idle };
  }
}
