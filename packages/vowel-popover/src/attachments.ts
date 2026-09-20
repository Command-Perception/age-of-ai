import type { CompleteAttachment } from "@assistant-ui/react";
import { useSyncExternalStore } from "react";
import { attachmentBatchError, MAX_INPUT_ATTACHMENTS, MAX_ATTACHMENT_TEXT, type InputAttachment } from "./wire/protocol/attachments";
import { prepareImage } from "./attachment-images";

export const ATTACHMENT_ACCEPT = "image/*,application/pdf,text/*,.md,.txt,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.log,.sh,.toml,.ini";
export interface PendingFile {
  readonly id: string;
  readonly file: File;
  readonly status: "preparing" | "ready" | "error";
  readonly attachment?: CompleteAttachment;
  readonly error?: string;
}

export const attachmentInput = (attachment: CompleteAttachment): InputAttachment => ({
  id: attachment.id,
  name: attachment.name,
  media_type: attachment.contentType ?? "text/plain",
  content: attachment.content.flatMap((part): Array<InputAttachment["content"][number]> => part.type === "text" ? [{ type: "text", text: part.text }] : part.type === "image" ? [{ type: "image", data_url: part.image }] : []),
});

export const prepareAttachment = async (file: File, id: string): Promise<CompleteAttachment> => {
  if (file.size > 10 * 1024 * 1024) throw new Error("Files must be ten MB or smaller.");
  if (file.name.length > 200) throw new Error("Please shorten this file's name to two hundred characters or fewer.");
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
  let content: InputAttachment["content"];
  if (mediaType.startsWith("image/")) content = [{ type: "image", data_url: await prepareImage(file) }];
  else if (mediaType === "application/pdf") content = await (await import("./attachment-pdf")).preparePdf(file);
  else {
    const textType = mediaType.startsWith("text/") || /^application\/(?:[a-z0-9.+-]*\+)?(?:json|javascript|xml|yaml|toml|sql)$/.test(mediaType) || /\.(?:md|txt|csv|tsv|jsonl?|ya?ml|xml|html?|css|[cm]?[jt]sx?|py|sql|log|sh|toml|ini)$/i.test(file.name) || !file.type;
    if (!textType) throw new Error("Use an image, PDF, or text/code file.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (text.includes("\0")) throw new Error("This file is binary. Use an image, PDF, or text/code file.");
    if (text.length > MAX_ATTACHMENT_TEXT) throw new Error("This file contains too much text. Attach a smaller excerpt.");
    content = [{ type: "text", text: text || "[Empty file]" }];
  }
  return {
    id, name: file.name, file, contentType: mediaType,
    type: mediaType.startsWith("image/") ? "image" : "document",
    status: { type: "complete" },
    content: content.map(part => part.type === "text" ? part : { type: "image", image: part.data_url, filename: file.name }),
  };
};

const emptyAttachments: ReadonlyArray<CompleteAttachment> = [];

export interface AttachmentReservation {
  readonly ready: Promise<ReadonlyArray<CompleteAttachment>>;
  readonly commit: () => void;
  readonly restore: () => void;
}

/** Owned by one popup. Files are prepared locally; only a send reserves them. */
export const createAttachmentStore = (prepare = prepareAttachment) => {
  let pending: ReadonlyArray<PendingFile> = [];
  const entries = new Map<string, PendingFile>();
  const preparations = new Map<string, Promise<CompleteAttachment | Error>>();
  const reserved = new Set<string>();
  const listeners = new Set<() => void>();
  const messageFiles = new Map<string, ReadonlyArray<CompleteAttachment>>();
  const notify = () => { for (const listener of listeners) listener(); };
  const store = {
    forMessage: (id: string): ReadonlyArray<CompleteAttachment> => messageFiles.get(id) ?? emptyAttachments,
    associate: (id: string, files: ReadonlyArray<CompleteAttachment>) => { messageFiles.set(id, files); notify(); },
    retainMessages: (ids: ReadonlySet<string>) => {
      let changed = false;
      for (const id of messageFiles.keys()) if (!ids.has(id)) { messageFiles.delete(id); changed = true; }
      if (changed) notify();
    },
    getSnapshot: () => pending,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add: (files: ReadonlyArray<File>): void => {
      if (pending.length + reserved.size + files.length > MAX_INPUT_ATTACHMENTS) throw new Error(`Attach at most ${MAX_INPUT_ATTACHMENTS} files per message.`);
      for (const file of files) {
        const id = crypto.randomUUID();
        const entry: PendingFile = { id, file, status: "preparing" };
        entries.set(id, entry);
        pending = [...pending, entry];
        const preparation = prepare(file, id).then(attachment => {
          const next: PendingFile = { id, file, status: "ready", attachment };
          if (entries.has(id)) { entries.set(id, next); pending = pending.map(value => value.id === id ? next : value); notify(); }
          return attachment;
        }).catch((cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const next: PendingFile = { id, file, status: "error", error: error.message };
          if (entries.has(id)) { entries.set(id, next); pending = pending.map(value => value.id === id ? next : value); notify(); }
          return error;
        });
        preparations.set(id, preparation);
      }
      notify();
    },
    remove: (id: string) => {
      if (reserved.has(id)) return;
      pending = pending.filter(entry => entry.id !== id);
      entries.delete(id); preparations.delete(id); notify();
    },
    reserve: (): AttachmentReservation => {
      const captured = pending;
      pending = [];
      for (const entry of captured) reserved.add(entry.id);
      let finished = false;
      const release = () => { for (const entry of captured) { reserved.delete(entry.id); entries.delete(entry.id); preparations.delete(entry.id); } };
      const ready = Promise.all(captured.map(entry => preparations.get(entry.id))).then(results => {
        const values: CompleteAttachment[] = [];
        for (const result of results) {
          if (result instanceof Error) throw result;
          if (result) values.push(result);
        }
        const error = attachmentBatchError(values.map(attachmentInput));
        if (error) throw new Error(error);
        return values;
      });
      notify();
      return {
        ready,
        commit: () => { if (finished) return; finished = true; release(); },
        restore: () => {
          if (finished) return; finished = true;
          pending = [...captured.map(entry => entries.get(entry.id) ?? entry), ...pending];
          for (const entry of captured) reserved.delete(entry.id);
          notify();
        },
      };
    },
  };
  return store;
};
export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
export const usePendingAttachments = (store: AttachmentStore) => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

export const useMessageAttachments = (store: AttachmentStore, id: string) => useSyncExternalStore(store.subscribe, () => store.forMessage(id), () => store.forMessage(id));
