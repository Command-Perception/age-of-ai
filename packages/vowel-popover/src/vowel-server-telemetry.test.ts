import { describe, expect, it } from "vitest";
import {
  applyServerTelemetryEvent,
  parseServerTelemetryEvent,
} from "./vowel-server-telemetry";

describe("parseServerTelemetryEvent", () => {
  it("accepts an interaction start", () => {
    expect(
      parseServerTelemetryEvent({
        type: "vowel.telemetry.interaction.started",
        interaction_id: "int-1",
        input: "Voice turn",
        started_at: 10,
      }),
    ).toEqual({
      type: "vowel.telemetry.interaction.started",
      interaction_id: "int-1",
      input: "Voice turn",
      started_at: 10,
    });
  });

  it("ignores protocol events", () => {
    expect(parseServerTelemetryEvent({ type: "response.created" })).toBeUndefined();
  });
});

describe("applyServerTelemetryEvent", () => {
  it("opens a turn then appends a span", () => {
    const started = applyServerTelemetryEvent([], {
      type: "vowel.telemetry.interaction.started",
      interaction_id: "int-1",
      input: "Voice turn",
      started_at: 100,
    });
    expect(started).toHaveLength(1);
    expect(started[0]?.id).toBe("int-1");
    const next = applyServerTelemetryEvent(started, {
      type: "vowel.telemetry.span.completed",
      interaction_id: "int-1",
      label: "Response started",
      phase: "model",
      started_at: 25,
      duration_ms: 10,
    });
    expect(next[0]?.events.map((event) => event.label)).toEqual(["Response started"]);
    expect(next[0]?.events[0]?.at).toBe(125);
    expect(next[0]?.events[0]?.durationMs).toBe(10);
  });
});
