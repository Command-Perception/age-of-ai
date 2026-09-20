import { AttachmentPreview } from "./attachment-preview";
import { ATTACHMENT_ACCEPT, createAttachmentStore, usePendingAttachments, type AttachmentStore } from "./attachments";
import { useOverlayLayout } from "./use-overlay-layout";
import { VoiceSettings } from "./voice-settings";
import { InlineError } from "./components/inline-error";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useLocalRuntime,
  useVoiceControls,
  useVoiceState,
  type ChatModelAdapter,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { BarChart3 as MdOutlineBarChart, MessageCircle as MdOutlineChat, Keyboard as MdOutlineKeyboard } from "lucide-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useAtom } from "@effect/atom-react";
import { LuBrain, LuEar, LuLoaderCircle, LuVolume2 } from "react-icons/lu";
import type { ExportedMessageRepository } from "@assistant-ui/react";
import { Mic as IoMic, XIcon, Settings, GripHorizontal, Grip, Paperclip } from "lucide-react";
import { cn } from "./lib/utils";
import { HumanToolUIs, vowelChatModel } from "./voice-panel";
import { VowelRealtimeAdapter } from "./vowel-adapter";
import { TelemetryDropdown } from "./telemetry-waterfall";
import { VoiceThread } from "./voice-thread";
import {
  useMicLive,
  getMicLive,
  subscribeMicLive,
  WAVEFORM_BAR_COUNT,
} from "./microphone";
import type { VoiceApi } from "./api";
import { HUMAN_VOICE_TOOLS } from "./vowel-trace";

const MemoTelemetryDropdown = memo(TelemetryDropdown);
const micStatusSnapshot = () => (getMicLive().live ? 1 : 0) | (getMicLive().denied ? 2 : 0);

type OverlayPanel = "closed" | "conversation" | "telemetry";

/** Persisted-in-memory turn of the overlay conversation: survives the
 * assistant-ui ephemeral voice-thread wipe once the session disconnects. */
export interface FrozenTurn {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly done: boolean }>;
  readonly reasoning: boolean;
}
const frozenTranscriptAtom = Atom.make<ReadonlyArray<FrozenTurn>>([]);

const OverlayChrome = ({ onClose, connectionError, onError, api, attachments }: {
  readonly attachments: AttachmentStore;
  readonly api: VoiceApi;
  readonly onClose: () => void;
  readonly connectionError: string | null;
  readonly onError: (message: string | null) => void;
}) => {
  const layout = useOverlayLayout();
  const pendingFiles = usePendingAttachments(attachments);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sendingFiles, setSendingFiles] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const queueFiles = (files: ReadonlyArray<File>) => {
    setAttachmentError(null);
    try { attachments.add(files); } catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const aui = useAui();
  const voice = useVoiceControls();
  const voiceState = useVoiceState();
  const micFlags = useSyncExternalStore(subscribeMicLive, micStatusSnapshot, micStatusSnapshot);
  const mic = { live: (micFlags & 1) !== 0, denied: (micFlags & 2) !== 0 };
  const messages = useAuiState((s) => s.thread.messages) ?? [];
  const running = useAuiState((s) => s.thread.isRunning) ?? false;

  // The runtime wipes its ephemeral voice-transcript messages whenever the
  // session disconnects. Keep the last conversation visible after stopping by
  // folding the active thread into the durable base repository, and clear it
  // when the next conversation starts.
  const activeSnapshot = useRef<ExportedMessageRepository | null>(null);
  const prevSessionActive = useRef(false);
  const restoreTimer = useRef<number | null>(null);
  const restoreTick = useRef<(() => void) | null>(null);
  const sessionActive = voiceState?.status.type === "running" || voiceState?.status.type === "starting";

  useEffect(() => {
    if (sessionActive) activeSnapshot.current = aui.thread.export();
  }, [aui, messages, sessionActive]);
  // Effect-atom-backed transcript: while the session is live the latest
  // non-empty thread serialization is frozen so the fold can render it even
  // when assistant-ui wipes its ephemeral voice thread after disconnect.
  const [frozenTurns, setFrozenTurns] = useAtom(frozenTranscriptAtom);
  useEffect(() => {
    if (!sessionActive) return;
    const next = messages.map(message => ({
      id: message.id,
      role: message.role,
      text: message.content
        .map(part => (part.type === "text" ? part.text : ""))
        .join(" ")
        .trim(),
      tools: message.content
        .filter(part => part.type === "tool-call")
        .map(part => ({
          name: part.toolName,
          done: part.result !== undefined || part.isError === true,
        })),
      reasoning: message.content.some(part => part.type === "reasoning"),
    })).filter(turn => turn.text.length > 0 || turn.tools.length > 0);
    if (next.length > 0) setFrozenTurns(next);
  }, [messages, sessionActive, setFrozenTurns]);
  useEffect(() => {
    if (prevSessionActive.current && !sessionActive && activeSnapshot.current !== null) {
      const snapshot = activeSnapshot.current;
      activeSnapshot.current = null;
      // assistant-ui can clear the ephemeral voice transcript on stop, and a
      // later wipe can still follow an already-successful import. Retry the
      // import whenever the thread goes empty, and re-arm after each import so
      // a trailing wipe re-triggers it; the transcript is durable once the
      // thread holds the snapshot for five consecutive checks. The next
      // session start's reset cancels the watch.
      let tries = 0;
      let stable = 0;
      const tick = () => {
        if (tries > 60) return;
        tries++;
        if (aui.thread.export().messages.length === 0) {
          stable = 0;
          try {
            aui.thread.import(snapshot);
          } catch {
            // Import races with an in-flight wipe; the next tick retries.
          }
        } else stable++;
        if (stable < 5) restoreTimer.current = window.setTimeout(tick, 100);
      };
      restoreTimer.current = null;
      restoreTick.current = tick;
    }
    if (prevSessionActive.current && !sessionActive) {
      // Next session start clears the folded view.
    }
    if (sessionActive) {
      // A new conversation starts fresh; cancel any pending stop restore and
      // drop the previous conversation's frozen transcript.
      if (restoreTimer.current !== null) { window.clearTimeout(restoreTimer.current); restoreTimer.current = null; }
      restoreTick.current = null;
      setFrozenTurns([]);
      aui.thread.reset([]);
    }
    prevSessionActive.current = sessionActive;
  }, [aui, sessionActive]);

  const [panel, setPanel] = useState<OverlayPanel>("closed");
  const closePanel = useCallback(() => setPanel("closed"), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const expanded = panel !== "closed" || settingsOpen || composing;
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Reactive read of the settings store so the header mirrors read-only
  // profile resolution done inside the settings view.
  const settings = useSyncExternalStore(
    api.settings?.subscribe ?? (() => () => {}),
    api.settings?.getSnapshot ?? (() => undefined),
  );
  const profileLocked = api.profileLocked === true;

  // Read-only profile display: resolve the key-bound profile at mount so the
  // header shows the real profile, not the placeholder.
  useEffect(() => {
    const store = api.settings;
    if (!store || !profileLocked) return;
    let disposed = false;
    void store.listProfiles().then(({ data }) => {
      if (disposed || data.length === 0) return;
      if (!data.some((item) => item.id === store.getSnapshot().profile.id))
        store.selectProfile(data[0]!);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [profileLocked, api.settings]);

  // The text slot shows the latest Vowel assistant response while one is
  // available; until the first response arrives it names the session profile.
  const statusLabel = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role !== "assistant") continue;
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
    const profile = settings?.profile;
    // Read-only profile display: when the seam is profile-locked the label
    // names the profile the API key is bound to, never a picker value.
    return profile?.name || profile?.id || (profileLocked ? "Key-bound profile" : "No profile selected — open settings");
  }, [messages, settings, profileLocked]);

  // Realtime voice carries both halves of the state: status.type covers
  // starting/running, while mode distinguishes the user's microphone turn
  // (listening) from the assistant's audio playback (speaking). Thinking is a
  // listening turn with the model response stream in flight.
  const voicePhase = voiceState?.status.type === "starting"
    ? "connecting"
    : voiceState?.mode === "speaking"
      ? "speaking"
      : running
        ? "thinking"
        : sessionActive
          ? "listening"
          : "idle";

  useEffect(() => {
    if (!composing) return;
    const id = window.setTimeout(() => {
      composerRef.current?.focus({ preventScroll: true });
    }, 200);
    return () => window.clearTimeout(id);
  }, [composing]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && !pendingFiles.length) || running || sendingFiles) return;
    const reservation = attachments.reserve();
    setSendingFiles(true);
    setAttachmentError(null);
    try {
      const files = await reservation.ready;
      await aui.thread.append({ role: "user", content: [{ type: "text", text: text || "Please review the attached files." }], attachments: [...files] });
      reservation.commit();
      setDraft("");
    } catch (cause) {
      reservation.restore();
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSendingFiles(false); }
  };

  return (
    <div ref={layout.ref} style={layout.style}
      onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDraggingFiles(true); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDraggingFiles(false); } } }}
      onDrop={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); queueFiles(Array.from(event.dataTransfer.files)); } }}
      data-dragging-files={draggingFiles}
      data-panel={panel} data-expanded={expanded ? "true" : "false"} data-resized={layout.resized} aria-label="Vowel conversation" className="vowel-overlay group fixed left-1/2 top-2 z-50 w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 [overflow-anchor:none]">
      <div className="vowel-overlay-surface flex max-h-[calc(100dvh-1rem)] flex-col overflow-x-hidden overflow-y-auto rounded-[12px] bg-[var(--background)] pb-1 pt-1 shadow-overlay">
        <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="Attach files to Vowel" className="hidden" onChange={event => { queueFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {draggingFiles && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90"><span className="rounded-md bg-background px-3 py-2 text-sm font-medium">Drop files for your next message</span></div>}
        <button type="button" aria-label="Move Vowel window" title="Drag to move · Arrow keys to move · Home to reset" {...layout.moveHandle} className="vowel-overlay__drag-handle absolute left-1/2 top-0 flex h-3 w-14 -translate-x-1/2 touch-none items-center justify-center rounded-b-md text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing focus-ring opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <GripHorizontal aria-hidden="true" className="size-4" />
        </button>
        <div
          className="overlay-fold vowel-content-fold min-h-0"
          data-open={panel === "conversation" ? "true" : "false"}
          aria-hidden={panel !== "conversation"}
        >
          <div className="overlay-fold-inner" inert={panel !== "conversation"}>
            <VoiceThread attachments={attachments} frozen={frozenTurns} />
          </div>
        </div>

        <div
          className="overlay-fold vowel-content-fold min-h-0"
          data-open={panel === "telemetry" ? "true" : "false"}
          aria-hidden={panel !== "telemetry"}
        >
          <div className="overlay-fold-inner" inert={panel !== "telemetry"}>
            {panel === "telemetry" && <MemoTelemetryDropdown onClose={closePanel} onCollapseAll={layout.releaseHeight} />}
          </div>
        </div>

        {pendingFiles.length > 0 && <div aria-label="Files queued for your next message" className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-1 pt-2">
          {pendingFiles.map(file => <AttachmentPreview key={file.id} pending={file} attachment={file.attachment} onRemove={() => attachments.remove(file.id)} />)}
        </div>}
        {(attachmentError || pendingFiles.some(file => file.error)) && <p role="alert" className="px-4 py-1 text-xs text-destructive">{attachmentError ?? pendingFiles.find(file => file.error)?.error}</p>}
        <div className="flex shrink-0 items-center gap-3 px-3 py-2">
          <button
            type="button"
            aria-label={sessionActive ? "Stop voice conversation" : "Start voice conversation"}
            aria-pressed={sessionActive}
            onClick={() => {
              try {
                if (sessionActive) voice.disconnect();
                else { onError(null); voice.connect(); }
              } catch (error) {
                onError(error instanceof Error ? error.message : String(error));
              }
            }}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--foreground)] transition-standard focus-ring",
              "hover:bg-[var(--subtle)]",
              sessionActive ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-transparent",
              mic.live && "mic-glow",
            )}
          >
            {voicePhase === "connecting" ? (
              <LuLoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />
            ) : voicePhase === "speaking" ? (
              <LuVolume2 aria-hidden="true" className="h-5 w-5" />
            ) : voicePhase === "listening" ? (
              <LuEar aria-hidden="true" className="h-5 w-5" />
            ) : voicePhase === "thinking" ? (
              <LuBrain aria-hidden="true" className="h-5 w-5" />
            ) : (
              <IoMic aria-hidden="true" className={cn("h-5 w-5", mic.live && "animate-pulse")} />
            )}
          </button>

          {sessionActive && mic.live && <LiveMicLevelMeter />}

          <span
            aria-label={
              voicePhase === "connecting"
                ? "Voice connecting"
                : voicePhase === "thinking"
                  ? "Assistant thinking"
                  : voicePhase === "speaking"
                    ? "Assistant speaking"
                    : undefined
            }
            aria-live="polite"
            className="flex shrink-0 items-center text-muted-foreground"
          >
            {voicePhase === "connecting" ? (
              <LuLoaderCircle aria-hidden="true" size={18} className="animate-spin" />
            ) : voicePhase === "speaking" ? (
              <LuVolume2 aria-hidden="true" size={18} />
            ) : voicePhase === "thinking" ? (
              <LuBrain aria-hidden="true" size={18} />
            ) : null}
          </span>

          <p role="status" className="min-w-0 flex-1 truncate text-[13px] text-[var(--foreground)]" title={statusLabel}>{statusLabel}</p>

          <div className={cn(
            "vowel-overlay__right-actions flex shrink-0 items-center gap-3 transition-opacity",
            expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}>
          <button type="button" aria-label="Conversation settings" aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
            className={cn("flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-standard hover:bg-[var(--subtle)] hover:text-[var(--foreground)] focus-ring", settingsOpen && "bg-[var(--subtle)] text-foreground")}>
            <Settings aria-hidden="true" className="size-5" />
          </button>
          {([
            { id: "conversation", label: "chat history", Icon: MdOutlineChat },
            { id: "telemetry", label: "telemetry", Icon: MdOutlineBarChart },
          ] as const).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={`${panel === id ? "Hide" : "Show"} ${label}`}
              title={`${panel === id ? "Hide" : "Show"} ${label}`}
              aria-pressed={panel === id}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-[6px] transition-standard focus-ring",
                panel === id
                  ? "bg-[var(--subtle)] text-[var(--foreground)]"
                  : "text-muted-foreground hover:bg-[var(--subtle)] hover:text-[var(--foreground)]",
              )}
              onClick={() => setPanel(current => current === id ? "closed" : id)}
            >
              <Icon aria-hidden="true" className="size-5" />
            </button>
          ))}
          <button type="button" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--subtle)] hover:text-[var(--foreground)] focus-ring">
            <Paperclip aria-hidden="true" className="size-5" />
          </button>
          <button
            type="button"
            aria-label="Type a message"
            title="Type a message"
            aria-expanded={composing}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-standard hover:bg-[var(--subtle)] hover:text-[var(--foreground)] focus-ring",
              composing && "bg-[var(--subtle)] text-[var(--foreground)]",
            )}
            onClick={() => setComposing((current) => !current)}
          >
            <MdOutlineKeyboard aria-hidden="true" className="h-5 w-5" />
          </button>
          <button type="button" aria-label="Hide Vowel" className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--subtle)] hover:text-[var(--foreground)] focus-ring" onClick={onClose}><XIcon className="size-4" /></button>
          </div>
        </div>

        {settingsOpen && api.settings && <VoiceSettings store={api.settings} profileLocked={api.profileLocked === true} onProfileChange={() => { voice.disconnect(); onError(null); }} />}

        {connectionError && <ConnectionErrorBanner message={connectionError} />}
        <div
          className="overlay-fold"
          data-open={composing ? "true" : "false"}
          aria-hidden={!composing}
        >
          <div className="overlay-fold-inner" inert={!composing}>
            <div className="flex items-end gap-2 border-t border-[var(--subtle)] px-3 py-2">
              <textarea
                ref={composerRef}
                aria-label="Message to Vowel"
                rows={2}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="Type to the operator…"
                className="w-full resize-none rounded-[6px] bg-transparent px-2 py-1.5 text-[13px] text-[var(--foreground)] shadow-border-input outline-none placeholder:text-muted-foreground focus-ring"
              />
              <button
                type="button"
                className="shrink-0 rounded-[6px] bg-[var(--foreground)] px-3 py-1.5 text-xs font-medium text-[var(--background)] transition-standard hover:opacity-85 focus-ring"
                disabled={running || sendingFiles || (!draft.trim() && pendingFiles.length === 0)}
                onClick={() => void send()}
              >
                {sendingFiles ? "Preparing…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {expanded && <button type="button" aria-label="Resize Vowel window" title="Drag to resize · Arrow keys to resize · Home to reset" {...layout.resizeHandle} className="vowel-overlay__resize-handle absolute bottom-0 right-0 flex size-4 touch-none items-center justify-center rounded-br-[12px] text-muted-foreground hover:text-foreground cursor-nwse-resize focus-ring opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Grip aria-hidden="true" className="size-3" />
      </button>}
    </div>
  );
};

const ConnectionErrorBanner = ({ message }: { readonly message: string }) => {
  const full = `${message} You can retry the mic or type a message.`;
  return <InlineError className="mx-3 mb-2" message={full} />;
};

const LiveMicLevelMeter = () => {
  const mic = useMicLive();
  return <MicLevelMeter live={mic.live} frequency={mic.frequency} />;
};

const MicLevelMeter = ({ live, frequency }: { live: boolean; frequency: Uint8Array }) => (
  <span aria-hidden="true" className={cn("mic-wave", !live && "opacity-30")}>
    {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => (
      <span
        key={index}
        className="mic-wave-bar"
        style={{ transform: `scaleY(${live ? Math.max(0.28, (frequency[index] ?? 0) / 255) : 0.22})` }}
      />
    ))}
  </span>
);

export const VowelOverlay = ({ api, open, onClose }: { readonly api: VoiceApi; readonly open: boolean; readonly onClose: () => void }) => {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const attachments = useMemo(() => createAttachmentStore(), []);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const adapter = useMemo(() => new VowelRealtimeAdapter(api, setConnectionError, undefined, {
    store: attachments,
    onTranscript: files => {
      const message = runtimeRef.current?.thread.getState().messages.findLast(message => message.role === "user");
      if (message) attachments.associate(message.id, files);
    },
  }), [api, attachments]);
  const model = useMemo(() => vowelChatModel(api), [api]);
  const runtime = useLocalRuntime(model satisfies ChatModelAdapter, {
    adapters: { voice: adapter },
    unstable_humanToolNames: [...HUMAN_VOICE_TOOLS],
  });

  useEffect(() => {
    runtimeRef.current = runtime;
    return runtime.thread.subscribe(() => attachments.retainMessages(new Set(runtime.thread.getState().messages.map(message => message.id))));
  }, [runtime, attachments]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <HumanToolUIs api={api} />
      <div hidden={!open}><OverlayChrome attachments={attachments} api={api} onClose={onClose} connectionError={connectionError} onError={setConnectionError} /></div>
    </AssistantRuntimeProvider>
  );
};
