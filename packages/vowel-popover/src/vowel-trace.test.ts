import { describe, expect, it } from "vitest";
import { vowelTraceAction } from "./vowel-trace";

describe("vowelTraceAction", () => {
  it("starts a turn only on audio buffer commit, not speech_started", () => {
    expect(vowelTraceAction("input_audio_buffer.speech_started")).toBeNull();
    expect(vowelTraceAction("input_audio_buffer.committed")).toEqual({ kind: "begin-audio" });
  });

  it("maps lifecycle events from the spec table", () => {
    expect(vowelTraceAction("conversation.item.input_audio_transcription.completed")).toEqual({
      kind: "event",
      phase: "input",
      label: "Speech transcribed",
    });
    expect(vowelTraceAction("response.created")).toEqual({
      kind: "event",
      phase: "model",
      label: "Response started",
    });
    expect(vowelTraceAction("response.text.delta")).toEqual({ kind: "first-text" });
    expect(vowelTraceAction("response.audio_transcript.delta")).toEqual({ kind: "first-text" });
    expect(vowelTraceAction("response.audio.delta")).toEqual({ kind: "first-audio" });
    expect(vowelTraceAction("response.done")).toEqual({
      kind: "event",
      phase: "output",
      label: "Response completed",
    });
  });

  it("includes tool names without registering unrelated project mutations", () => {
    expect(vowelTraceAction("response.function_call_arguments.done", { name: "list_projects" })).toEqual({
      kind: "event",
      phase: "tool",
      label: "Tool requested: list_projects",
    });
    expect(
      vowelTraceAction("response.function_call_arguments.done", { name: "create_project" }),
    ).toEqual({
      kind: "event",
      phase: "tool",
      label: "Tool requested: create_project",
    });
  });

  it("passes provider error detail through", () => {
    expect(
      vowelTraceAction("error", { error: { type: "invalid_request", message: "bad session" } }),
    ).toEqual({
      kind: "event",
      phase: "error",
      label: "Voice request failed",
      detail: "invalid_request: bad session",
    });
  });
});
