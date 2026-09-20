import { describe, expect, it, vi } from "vitest";
import { pcm16ToBase64 } from "./microphone";
import { parseVowelJson, stitchPcm16Bytes, Pcm16Player } from "./pcm16-playback";

describe("stitchPcm16Bytes", () => {
  it("carries an odd leftover byte into the next chunk", () => {
    const first = stitchPcm16Bytes(new Uint8Array(), Uint8Array.from([0x34, 0x12, 0xaa]));
    expect([...first.playable]).toEqual([0x34, 0x12]);
    expect([...first.remainder]).toEqual([0xaa]);
    const second = stitchPcm16Bytes(first.remainder, Uint8Array.from([0xbb, 0x01, 0x00]));
    expect([...second.playable]).toEqual([0xaa, 0xbb, 0x01, 0x00]);
    expect(second.remainder.length).toBe(0);
  });

  it("round-trips even pcm16 payloads without remainder", () => {
    const pcm = Int16Array.from([0x1234, 0x7fff]);
    const binary = atob(pcm16ToBase64(pcm));
    const incoming = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const stitched = stitchPcm16Bytes(new Uint8Array(), incoming);
    expect(stitched.playable.length).toBe(4);
    expect(stitched.remainder.length).toBe(0);
  });
});

describe("parseVowelJson", () => {
  it("accepts a JSON text frame", () => {
    expect(parseVowelJson('{"type":"response.done"}')).toEqual({ type: "response.done" });
  });

  it("ignores binary frames and invalid JSON so one bad message cannot kill the session", () => {
    expect(parseVowelJson(new ArrayBuffer(4))).toBeUndefined();
    expect(parseVowelJson("[object ArrayBuffer]")).toBeUndefined();
    expect(parseVowelJson("{")).toBeUndefined();
    expect(parseVowelJson('{"nope":true}')).toBeUndefined();
  });
});


it("schedules the first complete PCM sample immediately and joins later bytes continuously", () => {
  const start = vi.fn();
  const gain = { gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() }, connect: vi.fn() };
  const context = {
    currentTime: 10, state: "running",
    createGain: () => gain,
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ connect: vi.fn(), addEventListener: vi.fn(), start }),
  } as unknown as AudioContext;
  const player = new Pcm16Player(context);
  expect(player.playBytes(new Uint8Array([0x34]))).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  player.playBytes(new Uint8Array([0x12]));
  expect(start).toHaveBeenCalledWith(10);
  player.playBytes(new Uint8Array([0, 0]));
  expect(start).toHaveBeenLastCalledWith(10 + 1 / 24_000);
});
