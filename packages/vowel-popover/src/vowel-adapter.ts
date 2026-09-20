import { VoiceAttachmentSender } from "./voice-attachment-sender";
import type { AttachmentStore } from "./attachments";
import type { CompleteAttachment } from "@assistant-ui/react";
import { ClientEndpoint } from "./client-endpoint.ts";
import { AudioActivityFilter } from "./audio-activity-filter.ts";
import {
  createVoiceSession,
  type RealtimeVoiceAdapter,
  type VoiceSessionHelpers,
  type VoiceSessionControls,
} from "@assistant-ui/react";
import type { VoiceApi } from "./api";
import { VOICE_TEST_INITIAL_ACTIONS_PROMPT, VOICE_TEST_INSTRUCTIONS } from "./voice-instructions";
import type { AvatarDirectorClient } from "./avatar-director";
import { executeSocketTool } from "./socket-tools";
import {
  applyServerTrace,
  beginAudioTraceTurn,
  bindSession,
  recordTraceEvent,
  updateTraceTurnInput,
} from "./telemetry";
import { vowelTraceAction } from "./vowel-trace";
import {
  pcm16ToBase64,
  resetMicLive,
  startMicrophoneCapture,
  type MicrophoneCapture,
} from "./microphone";
import { VoiceTimelineClient } from "./voice-timeline";
import { Pcm16Player, parseVowelJson, type AudioSchedule } from "./pcm16-playback";
import { SPEECH_VOLUME } from "./silence-commit";

/**
 * VowelRealtimeAdapter (ALCHEMY-FLOCI-VOWEL.MD + Vowel Admin audio/telemetry).
 * Flux streams audio with server endpointing; batch STT uses bounded client VAD turns. Playback
 * carries odd PCM bytes. Assistant
 * transcript deltas are accumulated (assistant-ui replaces the bubble text).
 */

type MicrophoneFrame = {
  readonly speechProbability?: number;
  readonly pcm16: Int16Array;
  readonly volume: number;
  readonly frequency: Uint8Array;
};

export interface VowelSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}

export interface VowelPlayback {
  readonly isPlaying: boolean;
  playBase64(value: string): AudioSchedule | undefined;
  outputTime(at: number): number;
  stopTime(): number;
  drain(): Promise<void>;
  interrupt(): void;
  close(): void;
}

/**
 * The adapter owns turn state; these boundaries own browser I/O. Supplying
 * them lets tests mount the production adapter without Web Audio or a browser
 * WebSocket implementation.
 */
export interface VowelClientRuntime {
  readonly socketOpenState: number;
  readonly createSocket: (url: string) => VowelSocket;
  readonly createPlayback: () => VowelPlayback;
  readonly startCapture: (options: {
    readonly signal?: AbortSignal;
    readonly onError?: (error: Error) => void;
    readonly onFrame: (frame: MicrophoneFrame) => void;
  }) => Promise<MicrophoneCapture | undefined>;
  readonly resetMic: () => void;
}

const createBrowserRuntime = (): VowelClientRuntime => ({
  socketOpenState: WebSocket.OPEN,
  createSocket: (url) => new WebSocket(url),
  createPlayback: () => new Pcm16Player(new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" })),
  startCapture: startMicrophoneCapture,
  resetMic: resetMicLive,
});

export class VowelRealtimeAdapter implements RealtimeVoiceAdapter {
  constructor(
    private readonly api: VoiceApi,
    private readonly onError: (message: string | null) => void = () => {},
    private readonly runtime: VowelClientRuntime = createBrowserRuntime(),
    private readonly attachments?: { readonly store: AttachmentStore; readonly onTranscript: (files: ReadonlyArray<CompleteAttachment>) => void },
  ) {}

  connect(options: { abortSignal?: AbortSignal }) {
    const api = this.api;
    this.onError(null);
    const session = createVoiceSession(options, async (helpers: VoiceSessionHelpers) => {
      let socket: VowelSocket | undefined;
      const avatarDirector: AvatarDirectorClient | undefined = api.avatarDirector?.();
      void avatarDirector?.start().catch(() => undefined);
      const avatar = (action: (director: AvatarDirectorClient) => Promise<void>) => { if (avatarDirector) void action(avatarDirector).catch(() => undefined); };
      const timeline = new VoiceTimelineClient((value) => { if (socket?.readyState === this.runtime.socketOpenState) socket.send(JSON.stringify(value)); });
      type Playback = {
        readonly interactionId: string | undefined;
        readonly responseId: string | undefined;
        readonly speechId: string | undefined;
        readonly turn: string | undefined;
        cancelled: boolean;
        completed: boolean;
        scheduled: boolean;
        started: boolean;
      };
      let playback: Playback | undefined;
      let playbackEnd = 0;
      let lastAudioEnd = 0;
      let receivedAudio = false;
      let playbackGeneration = 0;
      const cancelledResponseIds = new Set<string>();
      const cancelledSpeechIds = new Set<string>();
      const playbackTimers = new Set<ReturnType<typeof setTimeout>>();
      const clearPlaybackTimers = () => { for (const timer of playbackTimers) clearTimeout(timer); playbackTimers.clear(); };
      const playbackState = (state: "started" | "completed" | "interrupted", active = playback) => {
        if (!active?.responseId) return;
        socket?.send(JSON.stringify({ type: "vowel.playback.state", response_id: active.responseId, state }));
      };
      const reportPlaybackStarted = (active: Playback, at = performance.timeOrigin + performance.now()) => {
        if (active.started || active.cancelled || active.completed) return;
        active.started = true;
        playbackState("started", active);
        timeline.event("audio.playback_start", { method: "Web Audio output schedule", threshold: "PCM amplitude >= 128/32768" }, at, true, active.turn);
      };
      const interruptPlayback = (speechStartedAt = performance.timeOrigin + performance.now()) => {
        if (!responseOpen && !player.isPlaying) return;
        const at = performance.timeOrigin + performance.now();
        const active = playback;
        timeline.event("barge_in.speech_start", { frameResolutionMs: Math.max(0, at - speechStartedAt) }, speechStartedAt, true, active?.turn);
        timeline.event("barge_in.detected", {}, at, true, active?.turn);
        if (player.isPlaying) timeline.event("barge_in.audio_stopped", {}, player.stopTime(), true, active?.turn);
        playbackGeneration++;
        clearPlaybackTimers();
        player.interrupt();
        if (active) {
          active.cancelled = true;
          if (active.responseId) cancelledResponseIds.add(active.responseId);
          if (active.speechId) cancelledSpeechIds.add(active.speechId);
          if (active.started && !active.completed) playbackState("interrupted", active);
        }
        socket?.send(JSON.stringify({ type: "response.cancel", response_id: active?.responseId, interaction_id: active?.interactionId ?? timeline.serverId(active?.turn) }));
        avatar((director) => director.interrupt());
        recordTraceEvent("error", "response.cancel");
        responseOpen = false;
      };
      const captureController = new AbortController();
      let capture: MicrophoneCapture | undefined;
      let muted = false;
      const audioActivity = new AudioActivityFilter();
      const clientEndpoint = new ClientEndpoint();
      let clientVad = false;
      let audioTurnOpen = false;
      let heardFirstAudio = false;
      let heardFirstText = false;
      let responseOpen = false;
      let sessionReady = false;
      let toolCatalogRequested = false;
      let observerConnected = false;
      let tornDown = false;
      let failure: Error | undefined;
      let assistantText = "";
      let textChannel: string | undefined;
      const pendingToolBatches = new Map<string, Promise<void>[]>();
      let localSpeechActive = false;
      let lastLocalSpeechAt: number | undefined;
      // assistant-ui notifies voice subscribers on every emitMode call without
      // deduping, so only forward real transitions — per-chunk audio deltas
      // would otherwise rerender the whole overlay on every chunk.
      let emittedMode: "listening" | "speaking" | undefined;
      const emitMode = (mode: "listening" | "speaking"): void => {
        if (emittedMode === mode) return;
        emittedMode = mode;
        helpers.emitMode(mode);
      };
      // 24 kHz context + remainder stitching — same as Vowel Admin.
      const player = this.runtime.createPlayback();

      const inputSender = new VoiceAttachmentSender(this.attachments?.store, wire => {
        if (!socket || socket.readyState !== this.runtime.socketOpenState || !sessionReady) throw new Error("Voice connection closed before the files could be sent.");
        socket.send(wire);
      }, error => {
        this.onError(error.message);
        helpers.setStatus({ type: "ended", reason: "error", error });
        socket?.close();
        teardown();
      });
      let unsubscribeSettings: (() => void) | undefined;
      const teardown = () => {
        if (tornDown) return;
        tornDown = true;
        if (observerConnected) { observerConnected = false; api.sessionObserver?.disconnected(); }
        sessionReady = false;
        captureController.abort();
        inputSender.close();
        playbackGeneration++;
        unsubscribeSettings?.();
        clearPlaybackTimers();
        options.abortSignal?.removeEventListener("abort", abort);
        capture?.close();
        this.runtime.resetMic();
        player.close();
        avatar((director) => director.close());
      };


      const startAudioTurn = () => {
        if (audioTurnOpen) return;
        audioTurnOpen = true;
        beginAudioTraceTurn();
      };

      const emitAssistant = (text: string, isFinal: boolean) => {
        if (!text) return;
        helpers.emitTranscript({ role: "assistant", text, isFinal });
      };

      const capturePromise = this.runtime.startCapture({
        signal: captureController.signal,
        onError: (error) => {
          if (tornDown) return;
          failure = error;
          helpers.setStatus({ type: "ended", reason: "error", error });
          socket?.close();
          teardown();
        },
        onFrame: (frame) => {
          helpers.emitVolume(frame.volume);
          if (socket?.readyState !== this.runtime.socketOpenState || !sessionReady) return;
          if (clientVad) {
            const result = clientEndpoint.frame(muted ? new Int16Array(frame.pcm16.length) : frame.pcm16, muted ? 0 : frame.speechProbability ?? 0);
            if (result.voiced) lastLocalSpeechAt = performance.timeOrigin + performance.now();
            if (result.started) {
              interruptPlayback(performance.timeOrigin + performance.now() - frame.pcm16.length / 16);
              timeline.start();
              inputSender.beginTurn();
              socket.send(JSON.stringify({ type: "vowel.input.speech", active: true }));
              api.sessionObserver?.event({ type: 'vowel.input.speech', active: true });
              timeline.event("user.speech_start", { detector: "Silero v5" }, undefined, true);
            }
            if (result.ended) {
              timeline.event("user.speech_end", { detector: "last Silero speech frame" }, lastLocalSpeechAt, true);
              lastLocalSpeechAt = undefined;
              if (result.frames.length > 0) {
                const pcm = new Int16Array(result.frames.reduce((sum, value) => sum + value.length, 0));
                let offset = 0;
                for (const value of result.frames) { pcm.set(value, offset); offset += value.length; }
                for (let offset = 0; offset < pcm.length; offset += 16_000)
                  inputSender.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm.subarray(offset, offset + 16_000)) });
                timeline.event("vad.speech_end", { detector: "Silero v5", silenceMs: 320, chunked: Boolean(result.limit) }, undefined, true);
                inputSender.send({ type: "input_audio_buffer.commit" });
              }
              inputSender.send({ type: "vowel.input.speech", active: false });
              api.sessionObserver?.event({ type: 'vowel.input.speech', active: false });
              inputSender.send({ type: "vowel.audio.idle" });
            }
            return;
          }
          const voiced = !muted && frame.volume >= SPEECH_VOLUME;
          if (voiced) lastLocalSpeechAt = performance.timeOrigin + performance.now();
          if (voiced && !localSpeechActive) {
            localSpeechActive = true;
            interruptPlayback(performance.timeOrigin + performance.now() - frame.pcm16.length / 16);
            timeline.start();
            inputSender.beginTurn();
            timeline.event("user.speech_start", { detector: "RMS threshold" }, performance.timeOrigin + performance.now(), true);
          }
          const filtered = audioActivity.frame(muted ? new Int16Array(frame.pcm16.length) : frame.pcm16, voiced, performance.now());
          for (const pcm of filtered.frames) inputSender.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm) });
          if (filtered.idle) inputSender.send({ type: "vowel.audio.idle" });
        },
      });

      void capturePromise.then((mic) => {
        capture = mic;
        if (tornDown || helpers.isDisposed()) mic?.close();
        else mic?.setMuted(muted);
      }).catch((error: unknown) => {
        if (tornDown || helpers.isDisposed()) return;
        failure = error instanceof Error ? error : new Error("Microphone setup failed");
        helpers.setStatus({ type: "ended", reason: "error", error: failure });
        socket?.close();
        teardown();
      });
      const abort = () => { socket?.close(1000, "aborted"); teardown(); };
      options.abortSignal?.addEventListener("abort", abort, { once: true });

      let session;
      try {
        session = await api.voiceSession();
      } catch (error) {
        recordTraceEvent("error", "Mint failed", error instanceof Error ? error.message : String(error));
        teardown();
        void capturePromise.then((mic) => mic?.close()).catch(() => undefined);
        throw error;
      }
      if (tornDown || helpers.isDisposed() || options.abortSignal?.aborted) {
        void capturePromise.then((mic) => mic?.close()).catch(() => undefined);
        player.close();
        return { disconnect() {}, mute() {}, unmute() {} };
      }
      bindSession(session.sessionId);

      socket = this.runtime.createSocket(
        `${session.realtimeUrl}?session_id=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.clientSecret)}`,
      );

      const sendTurnConfig = () => {
        if (!socket) return;
        const { initial_actions_prompt = VOICE_TEST_INITIAL_ACTIONS_PROMPT, ...instructions } = { ...VOICE_TEST_INSTRUCTIONS, ...api.sessionInstructions };
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              voice: api.settings?.getSnapshot().voice?.id ?? "",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              turn_detection: clientVad ? null : { type: "server_vad" },
              ...instructions,
              tool_choice: "auto",
            },
          }),
        );
        sessionReady = true;
        if (toolCatalogRequested) return;
        toolCatalogRequested = true;
        observerConnected = true;
        api.sessionObserver?.connected();
        void Promise.all([api.voiceTools(), capturePromise])
          .then(([tools]) => {
            if (socket?.readyState !== this.runtime.socketOpenState) return;
            socket.send(
              JSON.stringify({
                type: "session.update",
                session: { tools, tool_choice: "auto", initial_actions_prompt },
              }),
            );
          })
          .catch((error: unknown) => {
            recordTraceEvent(
              "error",
              "Tool catalog failed",
              error instanceof Error ? error.message : String(error),
            );
          });
      };

      const onOpen = () => {
        if (sessionReady) return;
        helpers.setStatus({ type: "running" });
        timeline.sync();
        sendTurnConfig();
      };

      unsubscribeSettings = api.settings?.subscribe(() => {
        if (socket?.readyState === this.runtime.socketOpenState && sessionReady) {
          socket.send(JSON.stringify({ type: "session.update", session: { voice: api.settings?.getSnapshot().voice?.id ?? "" } }));
        }
      });
      socket.addEventListener("open", onOpen);
      if (socket.readyState === this.runtime.socketOpenState) onOpen();

      socket.addEventListener("message", (event) => {
        if (tornDown || helpers.isDisposed()) return;
        const data = parseVowelJson((event as MessageEvent).data);
        if (!data) return;
        api.sessionObserver?.event(data);
        if (data.type === "session.created") {
          const settings = data["session"];
          clientVad = typeof settings === "object" && settings !== null && "turn_detection" in settings && settings.turn_detection === null;
          clientEndpoint.reset();
          sendTurnConfig();
          if (clientVad) inputSender.send({ type: "vowel.audio.idle" });
        }
        if (data.type === "vowel.worker.status") {
          recordTraceEvent(data["status"] === "failed" ? "error" : "tool", `Worker ${String(data["status"])}: ${String(data["query"])}`, String(data["message"]));
        }
        timeline.receive(data);
        if (applyServerTrace(data)) return;
        if (data.type === "response.function_call_arguments.done") {
          if (typeof data["job_id"] === "string") {
            void executeSocketTool(api, socket, data, this.runtime.socketOpenState, false).catch((error: unknown) => { this.onError(error instanceof Error ? error.message : "Tool execution failed"); });
            return;
          }
          const responseId = String(data["response_id"] ?? "");
          const batch = pendingToolBatches.get(responseId) ?? [];
          batch.push(executeSocketTool(api, socket, data, this.runtime.socketOpenState, false));
          pendingToolBatches.set(responseId, batch);
        }
        if (data.type === "response.done") {
          const response = data["response"];
          const responseId = typeof response === "object" && response !== null && "id" in response ? String(response.id) : "";
          const batch = pendingToolBatches.get(responseId);
          pendingToolBatches.delete(responseId);
          if (batch) void Promise.all(batch).then(() => {
            if (!tornDown && !helpers.isDisposed() && socket?.readyState === this.runtime.socketOpenState)
              socket.send(JSON.stringify({ type: "response.create" }));
          }).catch((error: unknown) => { this.onError(error instanceof Error ? error.message : "Tool execution failed"); });
        }

        const action = vowelTraceAction(data.type, {
          ...(typeof data["name"] === "string" ? { name: data["name"] } : {}),
          error: data["error"],
        });

        switch (data.type) {
          case "conversation.item.input_audio_transcription.completed": {
            const transcript = String(data["transcript"] ?? "").trim();
            helpers.emitTranscript({
              role: "user",
              text: transcript,
              isFinal: true,
            });
            const files = inputSender.transcript(Boolean(transcript));
            if (files.length) { this.attachments?.onTranscript(files); recordTraceEvent("input", "Files attached", files.map(file => file.name).join(", ")); }
            if (transcript) {
              updateTraceTurnInput(transcript);
              timeline.input(transcript);
              avatar((director) => director.userTranscript(transcript));
            }
            break;
          }
          case "response.text.delta":
          case "response.audio_transcript.delta": {
            if (textChannel && textChannel !== data.type) break;
            textChannel = data.type;
            assistantText += String(data["delta"] ?? "");
            emitAssistant(assistantText, false);
            break;
          }
          case "response.text.done": {
            if (typeof data["text"] === "string" && data["text"] && !assistantText) {
              assistantText = String(data["text"]);
            }
            if (playback?.speechId && assistantText) timeline.input(assistantText, playback.turn);
            // response.done owns finalization; ending here creates a second bubble.
            emitAssistant(assistantText, false);
            break;
          }
          case "response.created": {
            const response = data["response"];
            const responseId = typeof response === "object" && response !== null && "id" in response && typeof response.id === "string" ? response.id : undefined;
            const interactionId = typeof data["interaction_id"] === "string" ? data["interaction_id"] : undefined;
            const speechId = typeof data["speech_id"] === "string" ? data["speech_id"] : undefined;
            const turn = interactionId ? timeline.attachServerTurn(interactionId) : timeline.current;
            playback = { interactionId, responseId, speechId, turn, cancelled: false, completed: false, scheduled: false, started: false };
            responseOpen = true;
            receivedAudio = false;
            lastAudioEnd = 0;
            playbackEnd = 0;
            textChannel = undefined;
            heardFirstAudio = false;
            heardFirstText = false;
            assistantText = "";
            break;
          }
          case "response.done": {
            const response = data["response"];
            const responseId = typeof response === "object" && response !== null && "id" in response && typeof response.id === "string" ? response.id : undefined;
            const active = playback;
            // A late completion cannot take ownership of a newer response.
            if (active && responseId && active.responseId && responseId !== active.responseId) break;
            const generation = playbackGeneration, end = playbackEnd;
            if (active?.scheduled) void player.drain().then(() => {
              if (generation !== playbackGeneration || playback !== active || active.cancelled || active.completed) return;
              reportPlaybackStarted(active, end);
              active.completed = true;
              playbackState("completed", active);
              timeline.event("audio.playback_end", {}, end, true, active.turn);
            });
            emitAssistant(assistantText, true);
            avatar((director) => director.assistantTranscript(assistantText));
            emitMode("listening");
            audioTurnOpen = false;
            heardFirstAudio = false;
            heardFirstText = false;
            responseOpen = false;
            assistantText = "";
            break;
          }
          case "input_audio_buffer.speech_started":
            emitMode("listening");
            interruptPlayback();
            break;
          case "input_audio_buffer.speech_stopped":
            if (clientVad) break;
            localSpeechActive = false;
            timeline.event("user.speech_end", { detector: lastLocalSpeechAt === undefined ? "Flux EndOfTurn fallback" : "last local speech frame" }, lastLocalSpeechAt, true);
            lastLocalSpeechAt = undefined;
            break;
          case "response.audio.delta": {
            const responseId = typeof data["response_id"] === "string" ? data["response_id"] : undefined;
            const speechId = typeof data["speech_id"] === "string" ? data["speech_id"] : undefined;
            const active = playback;
            if (!active || active.cancelled || (responseId !== undefined && (cancelledResponseIds.has(responseId) || (active.responseId !== undefined && active.responseId !== responseId))) || (speechId !== undefined && (cancelledSpeechIds.has(speechId) || (active.speechId !== undefined && active.speechId !== speechId)))) break;
            emitMode("speaking");
            try {
              if (!receivedAudio) { receivedAudio = true; timeline.event("audio.first_packet_in", {}, undefined, false, active.turn); }
              const scheduled = player.playBase64(String(data["delta"] ?? ""));
              if (scheduled) {
                if (lastAudioEnd && scheduled.startsAt - lastAudioEnd > .02) timeline.event("audio.underrun", { gapMs: (scheduled.startsAt - lastAudioEnd) * 1000 }, undefined, true, active.turn);
                lastAudioEnd = scheduled.endsAt;
                playbackEnd = player.outputTime(scheduled.endsAt);
                if (!active.scheduled && scheduled.firstAudibleAt !== undefined) {
                  active.scheduled = true;
                  const audibleAt = player.outputTime(scheduled.firstAudibleAt), generation = playbackGeneration;
                  const timer = setTimeout(() => {
                    playbackTimers.delete(timer);
                    if (generation !== playbackGeneration || playback !== active || active.cancelled || active.completed) return;
                    reportPlaybackStarted(active, audibleAt);
                  }, Math.max(0, audibleAt - performance.timeOrigin - performance.now()));
                  playbackTimers.add(timer);
                }
              }
            } catch {
              // Malformed audio chunk — drop it, never crash the session.
            }
            break;
          }
          case "error": {
            const err = data["error"];
            const kind =
              typeof err === "object" && err !== null && "type" in err
                ? String((err as { type?: unknown }).type ?? "")
                : "";
            if (kind === "transcription_error") {
              this.onError(typeof err === "object" && err !== null && "message" in err
                ? String(err.message) : "Speech recognition failed. Please restart the voice conversation.");
              audioTurnOpen = false;
              emitMode("listening");
              break;
            }
            failure = new Error(typeof err === "object" && err !== null && "message" in err ? String(err.message) : "Voice request failed");
            socket.close(1000, "error");
            teardown();
            helpers.setStatus({ type: "ended", reason: "error", error: failure });
            break;
          }
          default:
            break;
        }

        if (!action) return;
        if (action.kind === "event" && action.label === "Response started") responseOpen = true;
        if (action.kind === "begin-audio") {
          startAudioTurn();
          return;
        }
        if (action.kind === "cancel") {
          recordTraceEvent("error", "response.cancel");
          return;
        }
        if (action.kind === "first-audio") {
          if (!heardFirstAudio) {
            heardFirstAudio = true;
            recordTraceEvent("output", "First audio received");
          }
          return;
        }
        if (action.kind === "first-text") {
          if (!heardFirstText) {
            heardFirstText = true;
            recordTraceEvent("output", "First text received");
          }
          return;
        }
        if (action.kind === "event") {
          recordTraceEvent(action.phase, action.label, action.detail);
          if (action.followUp) recordTraceEvent(action.followUp.phase, action.followUp.label);
        }
      });


      socket.addEventListener("close", () => {
        helpers.setStatus(failure ? { type: "ended", reason: "error", error: failure } : { type: "ended", reason: "finished" });
        teardown();
      });

      socket.addEventListener("error", () => {
        failure = new Error("Cannot connect to Vowel. Check that the realtime server is running.");
        helpers.setStatus({ type: "ended", reason: "error", error: failure });
        recordTraceEvent("error", "Vowel socket failed");
        socket?.close();
        teardown();
      });

      const controls: VoiceSessionControls = {
        disconnect: () => { socket?.close(1000, "normal closure"); teardown(); },
        mute: () => {
          muted = true;
          capture?.setMuted(true);
          helpers.emitVolume(0);
        },
        unmute: () => {
          muted = false;
          capture?.setMuted(false);
        },
      };
      return controls;
    });
    // assistant-ui clears thread.voice when a session ends, including failures.
    // Capture the error before that transient runtime state disappears.
    session.onStatusChange((status) => {
      if (status.type === "ended" && status.reason === "error") {
        const message = status.error instanceof Error ? status.error.message : "Voice connection failed. Please try again.";
        this.onError(message);
      }
    });
    return session;
  }
}
