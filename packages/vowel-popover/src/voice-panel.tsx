import { attachmentInput } from "./attachments";
import {
  makeAssistantToolUI,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { ApiError, type VoiceApi } from "./api";
import { VOICE_TEST_INSTRUCTIONS } from "./voice-instructions";
import { executeSocketTool } from "./socket-tools";
import { parseVowelJson } from "./pcm16-playback";
import { applyServerTrace, bindSession, beginTraceTurn, recordTraceEvent } from "./telemetry";
import { HUMAN_VOICE_TOOLS, toolExecutionDetail } from "./vowel-trace";

/** Typed messages stream through a short-lived Vowel socket, without mic access. */
export const vowelChatModel = (api: VoiceApi): ChatModelAdapter => ({
  async *run({ messages, abortSignal }) {
    const last = messages.at(-1);
    const files = last?.role === "user" ? last.attachments ?? [] : [];
    const input = last?.content.map((part) => part.type === "text" ? part.text : "").join(" ") ?? "";
    if (abortSignal.aborted) return;
    const avatarDirector = api.avatarDirector?.();
    void avatarDirector?.start().catch(() => undefined);
    const avatar = (action: (director: NonNullable<typeof avatarDirector>) => Promise<void>) => { if (avatarDirector) void action(avatarDirector).catch(() => undefined); };
    const availability = await api.voiceAvailability();
    if (!availability.available) {
      recordTraceEvent("error", "Vowel not configured");
      yield { content: [{ type: "text", text: "Configure the Admin connection in Settings and select a session profile to use Vowel." }] };
      return;
    }
    let session;
    try { session = await api.voiceSession(); }
    catch (error) { recordTraceEvent("error", "Mint failed", String(error)); throw error; }
    if (abortSignal.aborted) return;
    bindSession(session.sessionId);
    beginTraceTurn(input, "Message sent");
    avatar((director) => director.userTranscript(input));
    const tools = await api.voiceTools();
    if (abortSignal.aborted) return;
    const socket = new WebSocket(`${session.realtimeUrl}?session_id=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.clientSecret)}`);
    let text = "";
    let finished = false;
    let failure: Error | undefined;
    let revision = 0;
    let wake: (() => void) | undefined;
    let responseHasTool = false;
    const toolResponses = new Set<string>();
    const backgroundJobs = new Set<string>();
    const finalDeliveries = new Map<string, ReadonlyArray<string>>();
    let coordinatorKnown = false;
    let coordinatorIdle = false;
    let observerConnected = false;
    const changed = () => { revision++; wake?.(); };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      failure = error;
      if (error) recordTraceEvent("error", "Vowel request failed", error.message);
      changed();
    };
    const coordinatorIsIdle = (data: Record<string, unknown>): boolean =>
      data["phase"] === "idle" &&
      data["pending_jobs"] === 0 &&
      !data["pending_speech"] &&
      data["next_wake_at"] === undefined;
    const finishIfIdle = () => {
      if (backgroundJobs.size || responseHasTool || (coordinatorKnown && !coordinatorIdle)) return;
      recordTraceEvent("output", "Response completed");
      finish();
    };
    const abort = () => { recordTraceEvent("error", "response.cancel"); avatar((director) => director.interrupt()); finish(); };
    const timeout = setTimeout(() => finish(new Error("Vowel response timed out")), 90_000);
    abortSignal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      if (finished) return;
      observerConnected = true;
      api.sessionObserver?.connected();
      socket.send(JSON.stringify({ type: "session.update", session: { ...VOICE_TEST_INSTRUCTIONS, ...api.sessionInstructions, initial_actions_prompt: "", modalities: ["text"], tools, tool_choice: "auto" } }));
      if (files.length) {
        socket.send(JSON.stringify({ type: "vowel.input.attachments", attachments: files.map(attachmentInput) }));
        recordTraceEvent("input", "Files attached", files.map(file => file.name).join(", "));
      }
      socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: input }] } }));
      socket.send(JSON.stringify({ type: "response.create" }));
    });
    socket.addEventListener("message", (event) => {
      if (finished) return;
      const data = parseVowelJson(event.data);
      if (data) api.sessionObserver?.event(data);
      if (!data || applyServerTrace(data)) return;
      if (data.type === "vowel.worker.status" && typeof data["job_id"] === "string") {
        if (data["status"] === "cancelled") backgroundJobs.delete(data["job_id"]);
        else backgroundJobs.add(data["job_id"]);
        recordTraceEvent(data["status"] === "failed" ? "error" : "tool", `Worker ${String(data["status"])}`, String(data["message"]));
      }
      if (data.type === "vowel.coordinator.state") {
        coordinatorKnown = true;
        coordinatorIdle = coordinatorIsIdle(data);
        if (coordinatorIdle) finishIfIdle();
        return;
      }
      if (data.type === "response.created") {
        const response = data["response"];
        const jobIds = [
          ...(typeof data["job_id"] === "string" ? [data["job_id"]] : []),
          ...(Array.isArray(data["job_ids"]) ? data["job_ids"].filter((value): value is string => typeof value === "string") : []),
        ];
        if (jobIds.length && typeof response === "object" && response !== null && "id" in response && typeof response.id === "string") finalDeliveries.set(response.id, jobIds);
        if (text) text += "\n\n";
        responseHasTool = false;
        recordTraceEvent("model", "Response started");
      }
      if (data.type === "response.function_call_arguments.done") {
        const jobId = typeof data["job_id"] === "string" ? data["job_id"] : undefined;
        if (jobId !== undefined) backgroundJobs.add(jobId);
        responseHasTool = jobId === undefined;
        if (jobId === undefined && typeof data["response_id"] === "string") toolResponses.add(data["response_id"]);
        void executeSocketTool(api, socket, data, WebSocket.OPEN, jobId === undefined).catch((error: unknown) => finish(new Error(String(error))));
      }
      if (data.type === "response.text.delta" || data.type === "response.audio_transcript.delta") {
        if (!text) recordTraceEvent("output", "First text received");
        text += typeof data["delta"] === "string" ? data["delta"] : "";
        changed();
      }
      if (data.type === "response.text.done" && !text && typeof data["text"] === "string") {
        text = data["text"];
        changed();
      }
      if (data.type === "response.done") {
        const response = data["response"];
        const id = typeof response === "object" && response !== null && "id" in response ? response.id : undefined;
        if (typeof id === "string") {
          const completedJobs = finalDeliveries.get(id);
          if (completedJobs) { for (const jobId of completedJobs) backgroundJobs.delete(jobId); finalDeliveries.delete(id); }
        }
        if (typeof id === "string" ? toolResponses.has(id) : responseHasTool) return;
        finishIfIdle();
      }
      if (data.type === "error") finish(new Error(JSON.stringify(data["error"]) ?? "Vowel error"));
    });
    socket.addEventListener("error", () => finish(new Error("Vowel unreachable")));
    socket.addEventListener("close", () => { if (!finished) finish(new Error("Vowel connection closed before the response completed")); });
    try {
      if (abortSignal.aborted) abort();
      let seen = revision;
      while (!finished) {
        if (seen === revision) await new Promise<void>((resolve) => { wake = resolve; });
        seen = revision;
        if (text) yield { content: [{ type: "text", text }] };
      }
      if (failure) throw failure;
      if (!abortSignal.aborted) {
        avatar((director) => director.assistantTranscript(text));
        yield { content: [{ type: "text", text: text || "(no response)" }] };
      }
    } finally {
      if (observerConnected) api.sessionObserver?.disconnected();
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", abort);
      socket.close(1000, "finished");
      avatar((director) => director.close());
    }
  },
});

const toolTitle = (name: string): string => name.replaceAll("_", " ");

const identityLabel = (args: unknown): string => {
  const decoded = args as {
    id?: string;
    name?: string;
    projectId?: string;
    featureId?: string;
    appUrl?: string;
  };
  return [decoded.projectId, decoded.id ?? decoded.featureId, decoded.name, decoded.appUrl]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(":");
};

function makeMutationRenderer(name: string, api: VoiceApi) {
  return ({ args, result, addResult }: {
    readonly args: unknown;
    readonly result?: unknown;
    readonly addResult: (result: unknown) => void;
  }) => {
    if (result !== undefined) {
      const outcome = result as { ok?: boolean };
      return (
        <div className="rounded-[8px] p-3 shadow-border text-[13px]">
          <span className="font-medium">{toolTitle(name)}</span>
          <span className="ml-2 num text-[var(--muted-foreground)]">{identityLabel(args)}</span>
          <span className={outcome.ok ? "ml-2 text-[var(--success)]" : "ml-2 text-[var(--danger)]"}>
            {outcome.ok ? "ok" : "rejected"}
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2 rounded-[8px] p-3 shadow-border text-[13px]">
        <div className="flex items-center gap-2">
          <strong>{toolTitle(name)}</strong>
          <span className="num text-[var(--muted-foreground)]">{identityLabel(args)}</span>
        </div>
        <pre className="max-h-40 overflow-auto rounded-[6px] bg-[var(--subtle)] p-2 font-mono text-xs">
          {JSON.stringify(args, null, 2)}
        </pre>
        <p className="text-[var(--muted-foreground)]">
          This mutation runs against Vowel only after you approve it.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-[6px] bg-[var(--foreground)] px-3 py-1.5 text-xs font-medium text-[var(--background)] transition-standard hover:opacity-85 focus-ring"
            onClick={() => {
              recordTraceEvent("tool", `Tool execution started: ${name}`);
              const started = performance.now();
              void api
                .executeVoiceTool(name, args)
                .then((toolResult) => {
                  recordTraceEvent(
                    "tool",
                    `Tool execution completed: ${name}`,
                    toolExecutionDetail(
                      toolResult.ok === true,
                      Math.round(performance.now() - started),
                      identityLabel(args),
                      toolResult.ok ? "ok" : toolResult.error?.code,
                    ),
                  );
                  addResult(toolResult);
                })
                .catch((error: unknown) =>
                  addResult({
                    ok: false,
                    error: {
                      recoverable: true,
                      code: error instanceof ApiError ? error.code : "InternalError",
                      message: error instanceof Error ? error.message : String(error),
                    },
                  }),
                );
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-muted-foreground transition-standard hover:bg-[var(--subtle)] focus-ring"
            onClick={() => {
              recordTraceEvent("tool", `Declined: ${name}`, "mutation_rejected");
              addResult({
                ok: false,
                error: { recoverable: true, code: "mutation_rejected", message: "Declined by operator" },
              });
            }}
          >
            Decline
          </button>
        </div>
      </div>
    );
  };
}

export const HumanToolUIs = ({ api }: { readonly api: VoiceApi }) => (
  <>
    {HUMAN_VOICE_TOOLS.map((tool) => {
      const Component = makeAssistantToolUI({
        toolName: tool,
        render: makeMutationRenderer(tool, api),
      });
      return <Component key={tool} />;
    })}
  </>
);
