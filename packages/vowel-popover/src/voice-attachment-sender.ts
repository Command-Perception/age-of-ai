import type { CompleteAttachment } from "@assistant-ui/react";
import { attachmentInput, type AttachmentReservation, type AttachmentStore } from "./attachments";

interface VoiceFileBatch {
  files: ReadonlyArray<CompleteAttachment>;
  reservation?: AttachmentReservation;
}

/** Preserve wire order while a locally prepared file is still being read. */
export class VoiceAttachmentSender {
  private readonly batches: VoiceFileBatch[] = [];
  private readonly queue: Array<() => void | Promise<void>> = [];
  private waiting = false;
  private closed = false;
  constructor(
    private readonly store: AttachmentStore | undefined,
    private readonly sendWire: (wire: string) => void,
    private readonly onError: (error: Error) => void,
  ) {}
  beginTurn(): void {
    const reservation = this.store?.getSnapshot().length ? this.store.reserve() : undefined;
    const batch: VoiceFileBatch = { files: [], ...(reservation ? { reservation } : {}) };
    this.batches.push(batch);
    if (reservation) this.enqueue(async () => {
      batch.files = await reservation.ready;
      if (!this.closed && batch.files.length) this.sendWire(JSON.stringify({ type: "vowel.input.attachments", attachments: batch.files.map(attachmentInput) }));
    });
  }
  send(event: unknown): void { this.enqueue(() => { this.sendWire(JSON.stringify(event)); }); }
  transcript(nonempty: boolean): ReadonlyArray<CompleteAttachment> {
    const batch = this.batches.shift();
    if (!batch) return [];
    if (nonempty) batch.reservation?.commit();
    else batch.reservation?.restore();
    return nonempty ? batch.files : [];
  }
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    for (const batch of this.batches.splice(0)) batch.reservation?.restore();
  }
  private fail(cause: unknown): void {
    if (this.closed) return;
    this.close();
    this.onError(cause instanceof Error ? cause : new Error(String(cause)));
  }
  private enqueue(action: () => void | Promise<void>): void {
    if (this.closed) return;
    if (this.queue.length >= 3000) { this.fail(new Error("File preparation took too long. Please retry your voice message.")); return; }
    this.queue.push(action);
    this.drain();
  }
  private drain(): void {
    if (this.waiting || this.closed) return;
    while (this.queue.length) {
      const action = this.queue.shift();
      try {
        const result = action?.();
        if (result) {
          this.waiting = true;
          void result.then(() => { this.waiting = false; this.drain(); }, cause => this.fail(cause));
          return;
        }
      } catch (cause) { this.fail(cause); return; }
    }
  }
}
