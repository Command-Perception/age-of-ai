import { describe, expect, it } from "vitest";
import {
  SILENCE_COMMIT_MS,
  SPEECH_VOLUME,
  idleSilenceCommit,
  stepSilenceCommit,
} from "./silence-commit";

describe("stepSilenceCommit", () => {
  it("does not commit silence before any speech", () => {
    const first = stepSilenceCommit(idleSilenceCommit(), 0, 0);
    expect(first.commit).toBe(false);
    const later = stepSilenceCommit(first.state, 0, SILENCE_COMMIT_MS * 4);
    expect(later.commit).toBe(false);
  });

  it("commits after speech followed by enough silence", () => {
    const speaking = stepSilenceCommit(idleSilenceCommit(), SPEECH_VOLUME, 100);
    expect(speaking.commit).toBe(false);
    expect(speaking.state.armed).toBe(true);
    const stillQuiet = stepSilenceCommit(speaking.state, 0, 100 + SILENCE_COMMIT_MS - 1);
    expect(stillQuiet.commit).toBe(false);
    const done = stepSilenceCommit(stillQuiet.state, 0, 100 + SILENCE_COMMIT_MS);
    expect(done.commit).toBe(true);
    expect(done.state.armed).toBe(false);
  });

  it("resets the silence clock when speech resumes", () => {
    const speaking = stepSilenceCommit(idleSilenceCommit(), SPEECH_VOLUME, 0);
    const pause = stepSilenceCommit(speaking.state, 0, 400);
    const resume = stepSilenceCommit(pause.state, SPEECH_VOLUME, 500);
    const tooSoon = stepSilenceCommit(resume.state, 0, 500 + SILENCE_COMMIT_MS - 1);
    expect(tooSoon.commit).toBe(false);
    const done = stepSilenceCommit(resume.state, 0, 500 + SILENCE_COMMIT_MS);
    expect(done.commit).toBe(true);
  });
});
