import type { VoiceApi } from "./api";
import { recordTraceEvent } from "./telemetry";

export type SocketToolTransport = {
  readonly readyState: number;
  send(data: string): void;
};

export const executeSocketTool = async (
  api: VoiceApi,
  socket: SocketToolTransport,
  data: Record<string, unknown>,
  openState: number = WebSocket.OPEN,
  resumeResponse = true,
): Promise<void> => {
  if (typeof data["name"] !== "string" || typeof data["call_id"] !== "string") return;
  const name = data["name"];
  let args: unknown;
  try { args = JSON.parse(String(data["arguments"] ?? "{}")); }
  catch { args = undefined; }
  recordTraceEvent("tool", `Tool execution started: ${name}`, JSON.stringify(args));
  const result = await api.executeVoiceTool(name, args);
  recordTraceEvent(result.ok ? "tool" : "error", `Tool execution ${result.ok ? "completed" : "failed"}: ${name}`, result.error?.message);
  if (socket.readyState !== openState) return;
  socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: data["call_id"], output: JSON.stringify(result) } }));
  if (resumeResponse) socket.send(JSON.stringify({ type: "response.create" }));
};
