import { describe, expect, it } from "vitest";
import { applyServerTrace, beginAudioTraceTurn, beginTraceTurn, bindSession, filterTraceTurns, phaseCounts, resetTrace, traceSnapshot, traceWallTime, traceTurnTitle, updateTraceTurnInput } from "./telemetry";
import type { TraceTurn } from "./domain";

const sample: ReadonlyArray<TraceTurn> = [
  {
    id: "t1",
    input: "list projects",
    startedAt: 1,
    events: [
      { at: 1, label: "Turn started", phase: "input" },
      { at: 2, label: "Tool requested", phase: "tool" },
      { at: 3, label: "Response completed", phase: "output" },
    ],
  },
  {
    id: "t2",
    input: "broken mint",
    startedAt: 4,
    events: [{ at: 4, label: "Mint failed", phase: "error" }],
  },
];

describe("telemetry waterfall filters", () => {
  it("keeps every turn when no phase is selected", () => {
    expect(filterTraceTurns(sample, "")).toEqual(sample);
  });

  it("drops turns that have no matching phase", () => {
    const filtered = filterTraceTurns(sample, "error");
    expect(filtered.map((turn) => turn.id)).toEqual(["t2"]);
    expect(filtered[0]?.events.map((event) => event.phase)).toEqual(["error"]);
  });

  it("counts phases without inventing missing ones", () => {
    expect(phaseCounts(sample)).toEqual({
      input: 1,
      model: 0,
      tool: 1,
      output: 1,
      error: 1,
    });
  });
});


describe("live server trace integration", () => {
  it("retains completed turns when a new Vowel test session connects", () => {
    resetTrace();
    bindSession("first-session");
    beginTraceTurn("First turn");
    bindSession("second-session");
    beginTraceTurn("Second turn");
    expect(traceSnapshot().map((turn) => turn.input)).toEqual(["First turn", "Second turn"]);
    resetTrace();
  });

  it("merges the pending client turn and converts epoch timestamps once", () => {
    resetTrace();
    bindSession("session");
    beginTraceTurn("Hello", "Message sent");
    const startedAt = Date.now();
    const event = { type: "vowel.telemetry.interaction.started", interaction_id: "server-turn", input: "Hello", started_at: startedAt };
    applyServerTrace(event);
    applyServerTrace(event);
    expect(traceSnapshot()).toHaveLength(1);
    expect(traceSnapshot()[0]?.id).toBe("server-turn");
    expect(traceWallTime(traceSnapshot()[0]!.startedAt).getTime()).toBeCloseTo(startedAt, 0);
    expect(traceSnapshot()[0]?.events[0]?.label).toBe("Message sent");
    resetTrace();
  });
});


describe("voice turn titles", () => {
  it("uses one server-started turn for the commit and recognized transcript", () => {
    resetTrace();
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "audio", input: "Voice turn", started_at: Date.now() });
    expect(beginAudioTraceTurn()).toBe("audio");
    updateTraceTurnInput("What time is it?");
    expect(traceSnapshot()).toHaveLength(1);
    expect(traceTurnTitle(traceSnapshot()[0]!)).toBe("What time is it?");
    resetTrace();
  });
  it("does not overwrite a transcript with a late server placeholder", () => {
    resetTrace();
    beginAudioTraceTurn();
    updateTraceTurnInput("Hello there");
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "audio", input: "Voice turn", started_at: Date.now() });
    expect(traceTurnTitle(traceSnapshot()[0]!)).toBe("Hello there");
    resetTrace();
  });
  it("keeps a server-initiated speech trace separate from the current user trace", () => {
    resetTrace();
    const user = beginTraceTurn("Find projects");
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "speech", input: "Projects are ready", scope: "speech", started_at: Date.now() });
    updateTraceTurnInput("Follow up");
    expect(traceSnapshot().find((turn) => turn.id === user)?.input).toBe("Follow up");
    expect(traceSnapshot().find((turn) => turn.id === "speech")?.input).toBe("Projects are ready");
    resetTrace();
  });
  it("distinguishes pending, failed and completed turns without transcripts", () => {
    const turn: TraceTurn = { id: "audio", input: "Voice turn", startedAt: 0, events: [] };
    expect(traceTurnTitle(turn)).toBe("Waiting for transcript…");
    expect(traceTurnTitle({ ...turn, events: [{ at: 1, phase: "error", label: "Voice request failed", detail: "transcription_error: no speech" }] })).toBe("Transcription failed");
    expect(traceTurnTitle({ ...turn, events: [{ at: 1, phase: "output", label: "Response completed" }] })).toBe("No transcript available");
  });
});

describe("question telemetry grouping", () => {
  it("keeps interleaved coordinator, worker, filler, and answer work in its user question card", () => {
    resetTrace();
    beginTraceTurn("Find the active projects");
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "question-one-root", question_id: "question-one", input: "Find the active projects", started_at: 1_000 });
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "question-two-root", question_id: "question-two", input: "Check my calendar", started_at: 1_050 });
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "question-one-worker", question_id: "question-one", scope: "worker", input: "Background worker", started_at: 1_100 });
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "question-one-filler", question_id: "question-one", scope: "filler", input: "One moment", started_at: 1_120 });
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "question-two-speech", question_id: "question-two", scope: "speech", input: "Calendar is clear", started_at: 1_130 });
    applyServerTrace({ type: "vowel.telemetry.span.completed", interaction_id: "question-one-worker", question_id: "question-one", span_id: "worker-span", label: "Search projects", phase: "tool", started_at: 20, duration_ms: 30 });

    expect(traceSnapshot()).toHaveLength(2);
    const first = traceSnapshot().find((turn) => turn.questionId === "question-one");
    const second = traceSnapshot().find((turn) => turn.questionId === "question-two");
    expect(first?.id).toBe("question-one-root");
    expect(first?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "started:question-one-worker", label: "Background worker started", at: 1_100 }),
      expect.objectContaining({ id: "started:question-one-filler", label: "Filler delivery started", at: 1_120 }),
      expect.objectContaining({ id: "worker-span", interactionId: "question-one-worker", at: 1_120, durationMs: 30 }),
    ]));
    expect(second?.events.some((event) => event.interactionId === "question-one-worker")).toBe(false);
    resetTrace();
  });

  it("shows root aggregate usage once while retaining a child completion", () => {
    resetTrace();
    beginTraceTurn("Find projects");
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "root", question_id: "q", input: "Find projects", started_at: 1_000 });
    applyServerTrace({ type: "vowel.telemetry.interaction.started", interaction_id: "worker", question_id: "q", scope: "worker", input: "Background worker", started_at: 1_010 });
    applyServerTrace({ type: "vowel.telemetry.interaction.completed", interaction_id: "worker", question_id: "q", scope: "worker", outcome: "success", estimated_cost_usd: 2, usage: { llm_input_tokens: 10, llm_output_tokens: 20, stt_duration_ms: 0, tts_characters: 0 } });
    applyServerTrace({ type: "vowel.telemetry.interaction.completed", interaction_id: "root", question_id: "q", outcome: "success", estimated_cost_usd: 2, usage: { llm_input_tokens: 10, llm_output_tokens: 20, stt_duration_ms: 0, tts_characters: 0 } });

    applyServerTrace({ type: "vowel.telemetry.interaction.completed", interaction_id: "worker", question_id: "q", scope: "worker", outcome: "success", estimated_cost_usd: 2, usage: { llm_input_tokens: 10, llm_output_tokens: 20, stt_duration_ms: 0, tts_characters: 0 } });
    const turn = traceSnapshot()[0]!;
    const events = turn.events;
    expect(events.filter((event) => event.label === "Usage totals")).toHaveLength(1);
    expect(events.find((event) => event.label === "Usage totals")?.detail).toBe("60 LLM tokens · $4.0000 est.");
    expect(turn.usage?.map((record) => record.interactionId)).toEqual(["worker", "root"]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Background worker completed", interactionId: "worker" })]));
    resetTrace();
  });
});
