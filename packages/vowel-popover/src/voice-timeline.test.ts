import { afterEach, expect, it, vi } from "vitest";
import { VoiceTimelineClient, addVoiceEvent, resetVoiceTimeline, updateVoiceTraceInput, voiceTimelineSnapshot } from "./voice-timeline.ts";
afterEach(() => {
  resetVoiceTimeline();
  vi.restoreAllMocks();
});

it("retains prior playback traces when a new client is constructed", () => {
  resetVoiceTimeline();
  addVoiceEvent("prior", { id: "prior-event", name: "audio.playback_end", at: 1, clock: "client", estimated: true, uncertaintyMs: 0, attributes: {} });
  new VoiceTimelineClient(vi.fn());
  expect(voiceTimelineSnapshot()).toHaveLength(1);
  resetVoiceTimeline();
});
it("stores the finalized user speech on its voice trace", () => {
  addVoiceEvent("spoken-turn", { id: "speech-end", name: "user.speech_end", at: 1, clock: "client", estimated: false, uncertaintyMs: 0, attributes: {} });
  updateVoiceTraceInput("spoken-turn", "Find my active projects");
  expect(voiceTimelineSnapshot()[0]?.input).toBe("Find my active projects");
});
it("keeps STT text until the server assigns its interaction id", () => {
  const timeline = new VoiceTimelineClient(vi.fn());
  const clientId = timeline.start();
  timeline.event("user.speech_start", {}, undefined, true, clientId);
  timeline.input("What is the temperature in Japan today?", clientId);
  timeline.receive({ type: "vowel.telemetry.interaction.started", client_turn_id: clientId, interaction_id: "stt-turn" });
  timeline.receive({ type: "vowel.telemetry.clock", client_at: performance.timeOrigin + performance.now(), server_at: performance.timeOrigin + performance.now() });
  expect(voiceTimelineSnapshot().find((trace) => trace.id === "stt-turn")?.input).toBe("What is the temperature in Japan today?");
});
it("buffers events until turn acknowledgement and freezes a synchronized clock for late playback", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const send = vi.fn();
  const timeline = new VoiceTimelineClient(send);
  timeline.sync();
  const ping = send.mock.calls[0]?.[0];
  clock.mockReturnValue(120);
  timeline.receive({ type: "vowel.telemetry.clock", client_at: ping.client_at, server_at: performance.timeOrigin + 1110 });
  const first = timeline.start();
  timeline.event("user.speech_end", {}, performance.timeOrigin + 200, true);
  expect(send.mock.calls).toHaveLength(2);
  timeline.receive({ type: "vowel.telemetry.interaction.started", client_turn_id: first, interaction_id: "server-first" });
  expect(send.mock.calls[2]?.[0]).toMatchObject({ interaction_id: "server-first", events: [{ at: performance.timeOrigin + 1200, uncertaintyMs: 10 }] });
  timeline.start();
  clock.mockReturnValue(205);
  timeline.receive({ type: "vowel.telemetry.clock", client_at: performance.timeOrigin + 200, server_at: performance.timeOrigin + 5200 });
  timeline.event("audio.playback_end", {}, performance.timeOrigin + 500, true, first);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ interaction_id: "server-first", events: [{ at: performance.timeOrigin + 1500, uncertaintyMs: 10 }] });
});

it("corrects events captured before the first clock reply, even after turn acknowledgement", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const send = vi.fn();
  const timeline = new VoiceTimelineClient(send);
  timeline.sync();
  const first = timeline.start();
  timeline.event("user.speech_end", {}, performance.timeOrigin + 105, true);
  timeline.receive({ type: "vowel.telemetry.interaction.started", client_turn_id: first, interaction_id: "early" });
  expect(send.mock.calls).toHaveLength(2);
  clock.mockReturnValue(120);
  timeline.receive({ type: "vowel.telemetry.clock", client_at: performance.timeOrigin + 100, server_at: performance.timeOrigin + 1110 });
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ interaction_id: "early", events: [{ at: performance.timeOrigin + 1105, uncertaintyMs: 10 }] });
});

it("attaches server-initiated speech without replacing the current user turn", () => {
  const send = vi.fn();
  const timeline = new VoiceTimelineClient(send);
  const local = timeline.start();
  const remote = timeline.attachServerTurn("speech-1");
  expect(timeline.current).toBe(local);
  expect(timeline.serverId(remote)).toBe("speech-1");
  timeline.receive({ type: "vowel.telemetry.clock", client_at: performance.timeOrigin + performance.now(), server_at: performance.timeOrigin + performance.now() });
  timeline.event("audio.playback_start", {}, undefined, true, remote);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ interaction_id: "speech-1" });
});

it("labels coordinator traces and replaces the speech placeholder with delivered text", () => {
  const timeline = new VoiceTimelineClient(vi.fn());
  const user = timeline.start();
  timeline.receive({ type: "vowel.telemetry.interaction.started", interaction_id: "decision-1", scope: "decision" });
  timeline.receive({ type: "vowel.telemetry.interaction.started", interaction_id: "worker-1", scope: "worker" });
  timeline.receive({ type: "vowel.telemetry.interaction.started", interaction_id: "speech-1", scope: "speech", input: "Speech delivery" });
  const speech = timeline.clientId("speech-1");
  if (!speech) throw new Error("Expected speech trace");
  timeline.input("It is partly cloudy in Paris.", speech);
  expect(timeline.current).toBe(user);
  expect(voiceTimelineSnapshot().map((trace) => ({ id: trace.id, input: trace.input }))).toEqual(expect.arrayContaining([
    { id: "decision-1", input: "Router decision" },
    { id: "worker-1", input: "Background worker" },
    { id: "speech-1", input: "It is partly cloudy in Paris." },
  ]));
});

it("groups child playback traces with their root question", () => {
  const timeline = new VoiceTimelineClient(vi.fn());
  const user = timeline.start();
  timeline.receive({ type: "vowel.telemetry.interaction.started", client_turn_id: user, interaction_id: "root", question_id: "question" });
  timeline.receive({ type: "vowel.telemetry.interaction.started", interaction_id: "worker", question_id: "question", scope: "worker" });
  timeline.receive({ type: "vowel.telemetry.interaction.started", interaction_id: "filler", question_id: "question", scope: "filler", speech_kind: "filler" });
  addVoiceEvent("root", { id: "root-event", name: "user.speech_end", at: 1, clock: "client", estimated: false, uncertaintyMs: 0, attributes: {} });
  addVoiceEvent("filler", { id: "filler-event", name: "audio.playback_start", at: 2, clock: "client", estimated: false, uncertaintyMs: 0, attributes: {} });

  expect(voiceTimelineSnapshot()).toHaveLength(1);
  expect(voiceTimelineSnapshot()[0]).toMatchObject({ id: "question", questionId: "question" });
  expect(voiceTimelineSnapshot()[0]?.events.map((event) => event.id)).toEqual(["root-event", "filler-event"]);
});
