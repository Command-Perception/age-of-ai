import { afterEach, describe, expect, it, vi } from "vitest";
import { fromThreadMessageLike, type ChatModelRunOptions } from "@assistant-ui/react";
import { vowelChatModel } from "./voice-panel";
import type { VoiceApi } from "./api";
import { resetTrace, traceSnapshot } from "./telemetry";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) { super(); Socket.instances.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
const api = (): VoiceApi => ({
  voiceAvailability: async () => ({ available: true }),
  voiceSession: async () => ({ sessionId: "test-session", clientSecret: "ek_test", realtimeUrl: "wss://example.test/v1/realtime", expiresAt: 0 }),
  voiceTools: async () => [],
  executeVoiceTool: vi.fn(async (name) => ({ ok: true, operation: name, result: 391 })),
});
const start = async (service = api()) => {
  vi.stubGlobal("WebSocket", Socket);
  const controller = new AbortController();
  const message = fromThreadMessageLike({ role: "user", content: [{ type: "text", text: "17 times 23" }] }, "user-1", { type: "complete", reason: "stop" });
  const options: ChatModelRunOptions = { messages: [message], abortSignal: controller.signal, runConfig: {}, context: {}, unstable_getMessage: () => message };
  const output = vowelChatModel(service).run(options);
  if (!(Symbol.asyncIterator in output)) throw new Error("Expected a streaming adapter");
  const iterator = output[Symbol.asyncIterator]();
  const next = iterator.next();
  await vi.waitFor(() => expect(Socket.instances.length).toBe(1));
  const socket = Socket.instances[0]!;
  socket.dispatchEvent(new Event("open"));
  return { socket, iterator, next, controller };
};
afterEach(() => { vi.unstubAllGlobals(); Socket.instances = []; resetTrace(); });

describe("Vowel typed transport", () => {
  it("streams deltas before response.done and closes its ephemeral socket", async () => {
    const { socket, iterator, next } = await start();
    expect(socket.url).toContain("token=ek_test");
    socket.frame({ type: "response.text.delta", delta: "391" });
    expect((await next).value).toMatchObject({ content: [{ text: "391" }] });
    const completed = iterator.next();
    socket.frame({ type: "response.done" });
    await completed;
    while (!(await iterator.next()).done) { /* drain the final snapshot */ }
    expect(socket.readyState).toBe(3);
    expect(traceSnapshot().flatMap((turn) => turn.events).map((event) => event.label)).toContain("First text received");
  });

  it("keeps the socket open for an immediate tool's follow-up response", async () => {
    const service = api();
    const { socket, iterator, next } = await start(service);
    socket.frame({ type: "response.function_call_arguments.done", response_id: "tool-response", call_id: "call-1", name: "calculate", arguments: '{"left":17,"right":23,"operation":"multiply"}' });
    await vi.waitFor(() => expect(socket.sent.some((event) => event.type === "conversation.item.create" && JSON.stringify(event).includes("function_call_output"))).toBe(true));
    socket.frame({ type: "response.done", response: { id: "tool-response" } });
    expect(socket.readyState).toBe(1);
    socket.frame({ type: "response.created", response: { id: "answer" } });
    socket.frame({ type: "response.text.delta", delta: "391" });
    await next;
    socket.frame({ type: "response.done", response: { id: "answer" } });
    while (!(await iterator.next()).done) { /* drain */ }
    expect(service.executeVoiceTool).toHaveBeenCalledWith("calculate", { left: 17, right: 23, operation: "multiply" });
  });

  it("rejects an unexpected socket close and records the error", async () => {
    const { socket, next } = await start();
    const rejected = expect(next).rejects.toThrow("closed before");
    socket.close();
    await rejected;
    expect(traceSnapshot().flatMap((turn) => turn.events).some((event) => event.phase === "error")).toBe(true);
  });

  it("closes promptly when typed generation is cancelled", async () => {
    const { socket, next, controller } = await start();
    controller.abort();
    expect((await next).done).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});

it("keeps typed chat alive through background acknowledgement, progress, and final delivery", async () => {
  const { socket, iterator, next } = await start();
  socket.frame({ type: "response.created", response: { id: "ack" } });
  socket.frame({ type: "response.text.delta", delta: "Checking." });
  socket.frame({ type: "vowel.worker.status", job_id: "job-1", status: "started", message: "Working" });
  socket.frame({ type: "response.done", response: { id: "ack" } });
  await next;
  expect(socket.readyState).toBe(1);
  socket.frame({ type: "response.function_call_arguments.done", job_id: "job-1", response_id: "job-1", call_id: "worker_call_1", name: "calculate", arguments: "{}" });
  await vi.waitFor(() => expect(socket.sent.some(event => JSON.stringify(event).includes("worker_call_1"))).toBe(true));
  expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
  socket.frame({ type: "vowel.worker.status", job_id: "job-1", status: "completed", message: "391" });
  socket.frame({ type: "response.created", response: { id: "progress" }, job_id: "job-1", worker_status: "progress" });
  socket.frame({ type: "response.done", response: { id: "progress" } });
  expect(socket.readyState).toBe(1);
  socket.frame({ type: "response.created", response: { id: "final" }, job_id: "job-1", worker_status: "completed" });
  socket.frame({ type: "response.text.delta", delta: "391" });
  socket.frame({ type: "response.done", response: { id: "final" } });
  while (!(await iterator.next()).done) { /* drain */ }
  expect(socket.readyState).toBe(3);
});

it("waits for the coordinator to become idle after an acknowledgement response", async () => {
  const { socket, iterator, next } = await start();
  socket.frame({ type: "vowel.coordinator.state", phase: "working", pending_jobs: 1, pending_speech: 0 });
  socket.frame({ type: "response.created", response: { id: "ack" } });
  socket.frame({ type: "response.done", response: { id: "ack" } });
  await Promise.resolve();
  expect(socket.readyState).toBe(1);
  socket.frame({ type: "vowel.coordinator.state", phase: "idle", pending_jobs: 0, pending_speech: 0 });
  await next;
  while (!(await iterator.next()).done) { /* drain */ }
  expect(socket.readyState).toBe(3);
});
