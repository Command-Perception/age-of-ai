import { expect, it } from "vitest";
import { ClientEndpoint } from "./client-endpoint";
const audio = (value = 0) => new Int16Array(512).fill(value);

it("retains pre-roll and commits once after 320 ms of silence", () => {
  const endpoint = new ClientEndpoint();
  for (let i = 0; i < 100; i++) expect(endpoint.frame(audio(), 0).frames).toEqual([]);
  expect(endpoint.frame(audio(10), .9).started).toBe(true);
  endpoint.frame(audio(20), .9);
  endpoint.frame(audio(30), .9);
  for (let i = 0; i < 9; i++) expect(endpoint.frame(audio(), 0).ended).toBe(false);
  const result = endpoint.frame(audio(), 0);
  expect(result.ended).toBe(true);
  expect(result.frames).toHaveLength(21);
  expect(result.frames[8]?.[0]).toBe(10);
  for (let i = 0; i < 100; i++) expect(endpoint.frame(audio(), 0).ended).toBe(false);
});

it("keeps a natural short pause inside the same utterance and rejects clicks", () => {
  const endpoint = new ClientEndpoint();
  endpoint.frame(audio(1), .9);
  for (let i = 0; i < 6; i++) expect(endpoint.frame(audio(), 0).ended).toBe(false);
  expect(endpoint.frame(audio(2), .9).started).toBe(false);
  endpoint.frame(audio(3), .9);
  for (let i = 0; i < 9; i++) endpoint.frame(audio(), 0);
  expect(endpoint.frame(audio(), 0).frames.some(value => value[0] === 2)).toBe(true);
  endpoint.frame(audio(4), .9);
  for (let i = 0; i < 9; i++) endpoint.frame(audio(), 0);
  expect(endpoint.frame(audio(), 0).frames).toEqual([]);
});

it("submits a capped utterance and continues seamlessly instead of discarding its tail", () => {
  const endpoint = new ClientEndpoint(320, 4096);
  const first = endpoint.frame(audio(1), .9);
  expect(first.started).toBe(true);
  let flushed = false;
  let continuation = false;
  for (let i = 1; i < 60; i++) {
    const result = endpoint.frame(audio(1), .9);
    if (result.ended) {
      expect(flushed).toBe(false);
      flushed = true;
      expect(result.limit).toBe(true);
      expect(result.frames.length).toBeGreaterThan(0);
      const next = endpoint.frame(audio(2), .9);
      expect(next.started).toBe(true);
      continuation = true;
      break;
    }
  }
  expect(flushed).toBe(true);
  expect(continuation).toBe(true);
  for (let i = 0; i < 5; i++) endpoint.frame(audio(3), .9);
  let tailFlushed = false;
  for (let i = 0; i < 30; i++) {
    const result = endpoint.frame(audio(), 0);
    if (result.ended) {
      tailFlushed = true;
      expect(result.limit).toBe(true);
      expect(result.frames[0]?.[0]).toBe(2);
      expect(result.frames.some(value => value[0] === 3)).toBe(true);
      break;
    }
  }
  expect(tailFlushed).toBe(true);
  expect(endpoint.frame(audio(), 0).ended).toBe(false);
});

it("uses a longer commit threshold once the utterance is clearly a long read", () => {
  const endpoint = new ClientEndpoint();
  endpoint.frame(audio(1), .9);
  for (let i = 0; i < 16_000 * 9 / 512; i++) endpoint.frame(audio(1), .9);
  for (let i = 0; i < 24; i++) expect(endpoint.frame(audio(), 0).ended).toBe(false);
  expect(endpoint.frame(audio(), 0).ended).toBe(true);
});
