import { AttachmentPreview } from "./attachment-preview";
import { createAttachmentStore, useMessageAttachments, type AttachmentStore } from "./attachments";
import { createContext, useContext, useEffect, useRef } from "react";
import { MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { cn } from "./lib/utils";
import type { FrozenTurn } from "./vowel-overlay";

const AttachmentsContext = createContext<AttachmentStore>(createAttachmentStore());

const OverlayMessage = () => {
  const store = useContext(AttachmentsContext);
  const messageId = useAuiState(s => s.message.id);
  const nativeAttachments = useAuiState(s => s.message.role === "user" ? s.message.attachments : undefined);
  const voiceAttachments = useMessageAttachments(store, messageId);
  const attachments = nativeAttachments?.length ? nativeAttachments : voiceAttachments;
  const role = useAuiState((s) => s.message.role);
  const isUser = role === "user";

  return (
    <MessagePrimitive.Root
      className={cn(
        "vowel-message max-w-[85%] rounded-[8px] px-3 py-1.5 text-[13px]",
        isUser
          ? "vowel-message--user self-end bg-[var(--subtle)] text-[var(--foreground)]"
          : "vowel-message--assistant self-start text-[var(--foreground)]",
      )}
    >
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map(attachment => <AttachmentPreview key={attachment.id} attachment={attachment} />)}</div>}
      <MessagePrimitive.Parts
        components={{
          Text: ({ text }) => (text.trim() ? <p>{text}</p> : null),
          Reasoning: () => (
            <p className="text-[11px] italic text-[var(--muted-foreground)]">thinking…</p>
          ),
          tools: {
            Fallback: ({ toolName, result, isError }) => (
              <p className="num text-[11px] text-[var(--muted-foreground)]">
                tool: {toolName} ({isError ? "error" : result !== undefined ? "done" : "running"})
              </p>
            ),
          },
        }}
      />
    </MessagePrimitive.Root>
  );
};

/** Post-session transcript: shown when assistant-ui has wiped the ephemeral
 * voice thread and the frozen Effect-atom copy is the last conversation. */
const FrozenMessage = ({ turn }: { readonly turn: FrozenTurn }) => {
  const isUser = turn.role === "user";
  return (
    <div
      className={cn(
        "vowel-message max-w-[85%] rounded-[8px] px-3 py-1.5 text-[13px]",
        isUser
          ? "vowel-message--user self-end bg-[var(--subtle)] text-[var(--foreground)]"
          : "vowel-message--assistant self-start text-[var(--foreground)]",
      )}
    >
      {turn.reasoning && <p className="text-[11px] italic text-[var(--muted-foreground)]">thinking…</p>}
      {turn.text && <p>{turn.text}</p>}
      {turn.tools.map(tool => (
        <p key={tool.name} className="num text-[11px] text-[var(--muted-foreground)]">
          tool: {tool.name} ({tool.done ? "done" : "error"})
        </p>
      ))}
    </div>
  );
};

/** Minimal assistant-ui thread for the voice overlay conversation tab. */
export const VoiceThread = ({ attachments, frozen }: {
  readonly attachments: AttachmentStore;
  readonly frozen: ReadonlyArray<FrozenTurn> | undefined;
}) => {
  const viewport = useRef<HTMLDivElement>(null);
  const runtimeMessages = useAuiState((state) => state.thread.messages);
  const showFrozen = runtimeMessages.length === 0 && frozen !== undefined && frozen.length > 0;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const followLatest = () => { element.scrollTop = element.scrollHeight; };
    followLatest();
    // Opening a previously hidden fold changes its size without changing messages.
    const observer = new ResizeObserver(followLatest);
    observer.observe(element);
    return () => observer.disconnect();
  }, [runtimeMessages, showFrozen]);
  return (
  <AttachmentsContext.Provider value={attachments}>
  <ThreadPrimitive.Root className="flex min-h-0 flex-col">
    <ThreadPrimitive.Viewport ref={viewport} className="voice-thread-viewport min-h-0 flex-1 max-h-[min(20rem,45dvh)] overflow-y-auto px-3 py-2">
      <div className="flex flex-col gap-2">
        {showFrozen && frozen !== undefined && (
          <div className="flex flex-col gap-2">
            {frozen.map(turn => <FrozenMessage key={turn.id} turn={turn} />)}
          </div>
        )}
        <ThreadPrimitive.Messages>{() => <OverlayMessage />}</ThreadPrimitive.Messages>
      </div>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
  </AttachmentsContext.Provider>
);
};
