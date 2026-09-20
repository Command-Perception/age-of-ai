import { describe, expect, it } from "vitest";
import {
  frequencyFromSamples,
  pcm16AtRate,
  pcm16ToBase64,
  rmsVolume,
  WAVEFORM_BAR_COUNT,
  VOWEL_INPUT_RATE,
} from "./microphone";

describe("microphone pcm helpers", () => {
  it("resamples a full-scale sample to int16 at the target rate", () => {
    const samples = Float32Array.from([1, 1, 1, 1]);
    const pcm = pcm16AtRate(samples, 48_000, 24_000);
    expect(pcm.length).toBe(2);
    expect(pcm[0]).toBe(0x7fff);
  });

  it("encodes pcm16 as base64 without dropping bytes", () => {
    const pcm = Int16Array.from([0x1234, 0x7fff]);
    const decoded = atob(pcm16ToBase64(pcm));
    expect(decoded.length).toBe(4);
  });

  it("maps silent samples to a frozen equalizer and zero volume", () => {
    const silence = new Float32Array(64);
    const bars = frequencyFromSamples(silence, WAVEFORM_BAR_COUNT);
    expect(bars.length).toBe(WAVEFORM_BAR_COUNT);
    expect([...bars].every((value) => value === 0)).toBe(true);
    expect(rmsVolume(silence)).toBe(0);
  });

  it("raises frequency bars when a bucket is loud", () => {
    const samples = new Float32Array(16);
    samples.fill(0.8, 0, 4);
    const bars = frequencyFromSamples(samples, 4);
    expect(bars[0]!).toBeGreaterThan(bars[1]!);
  });
});


it("sends one second of browser audio as one second of the worker's 16 kHz PCM input", () => {
  for (const sourceRate of [44_100, 48_000]) {
    const samples = Float32Array.from({ length: sourceRate }, (_, index) => Math.sin(2 * Math.PI * 440 * index / sourceRate) * 0.5);
    const pcm = pcm16AtRate(samples, sourceRate, VOWEL_INPUT_RATE);
    const bytes = atob(pcm16ToBase64(pcm));
    expect(VOWEL_INPUT_RATE).toBe(16_000);
    expect(bytes.length).toBe(32_000);
    expect(bytes.length / (16_000 * 2)).toBe(1);
  }
});
