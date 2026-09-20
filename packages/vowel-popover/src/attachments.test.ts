import { describe, expect, it, vi } from "vitest";
import { attachmentInput, createAttachmentStore, prepareAttachment } from "./attachments";
import { VoiceAttachmentSender } from "./voice-attachment-sender";
import type { CompleteAttachment } from "@assistant-ui/react";

const prepared = (file: File, id: string): CompleteAttachment => ({ id, name: file.name, file, type: "document", contentType: "text/plain", status: { type: "complete" }, content: [{ type: "text", text: "approval code: orchid-29" }] });

describe("Vowel queued files", () => {
  it("reads file content, reserves it exactly once, and preserves later drops for the next message", async () => {
    const store = createAttachmentStore();
    store.add([new File(["approval code: orchid-29"], "notes.txt", { type: "text/plain" })]);
    const first = store.reserve();
    store.add([new File(["next message"], "next.txt", { type: "text/plain" })]);
    const files = await first.ready;
    expect(attachmentInput(files[0]!)).toMatchObject({ name: "notes.txt", content: [{ type: "text", text: "approval code: orchid-29" }] });
    first.commit();
    expect(store.getSnapshot().map(file => file.file.name)).toEqual(["next.txt"]);
    const second = store.reserve();
    expect((await second.ready).map(file => file.name)).toEqual(["next.txt"]);
    second.commit();
  });
  it("restores failed sends and does not resurrect a file removed during preparation", async () => {
    let resolve: (value: CompleteAttachment) => void = () => {};
    const store = createAttachmentStore((file, id) => new Promise(done => { resolve = () => done(prepared(file, id)); }));
    const file = new File(["x"], "notes.txt");
    store.add([file]);
    const id = store.getSnapshot()[0]!.id;
    store.remove(id);
    resolve(prepared(file, id));
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([]);
    const retryStore = createAttachmentStore(async (f, i) => prepared(f, i));
    retryStore.add([file]);
    const claim = retryStore.reserve();
    await claim.ready; claim.restore(); claim.restore();
    expect(retryStore.getSnapshot()).toHaveLength(1);
  });
  it("rejects binary and oversized text instead of silently omitting file contents", async () => {
    await expect(prepareAttachment(new File([new Uint8Array([0, 1, 2])], "binary"), "a")).rejects.toThrow("binary");
    await expect(prepareAttachment(new File(["x".repeat(100001)], "large.txt"), "b")).rejects.toThrow("too much text");
    await expect(prepareAttachment(new File(["abc"], "book.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "c")).rejects.toThrow("image, PDF");
  });
  it("sends prepared files before queued voice audio and associates them only with that transcript", async () => {
    let finish: () => void = () => {};
    const store = createAttachmentStore((file, id) => new Promise(done => { finish = () => done(prepared(file, id)); }));
    store.add([new File(["x"], "voice.txt")]);
    const wire: Array<{ type: string }> = [];
    const errors = vi.fn();
    const sender = new VoiceAttachmentSender(store, value => wire.push(JSON.parse(value)), errors);
    sender.beginTurn();
    sender.send({ type: "input_audio_buffer.append", audio: "AAAA" });
    sender.send({ type: "input_audio_buffer.commit" });
    expect(wire).toEqual([]);
    finish();
    await vi.waitFor(() => expect(wire).toHaveLength(3));
    expect(wire.map(event => event.type)).toEqual(["vowel.input.attachments", "input_audio_buffer.append", "input_audio_buffer.commit"]);
    expect(sender.transcript(true).map(file => file.name)).toEqual(["voice.txt"]);
    sender.beginTurn();
    expect(sender.transcript(true)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    sender.close();
  });
  it("restores untransmitted files when a voice connection closes during preparation", async () => {
    let finish: () => void = () => {};
    const store = createAttachmentStore((file, id) => new Promise(done => { finish = () => done(prepared(file, id)); }));
    store.add([new File(["x"], "retry.txt")]);
    const wire = vi.fn();
    const sender = new VoiceAttachmentSender(store, wire, vi.fn());
    sender.beginTurn(); sender.send({ type: "input_audio_buffer.commit" }); sender.close(); finish();
    await vi.waitFor(() => expect(store.getSnapshot()[0]?.status).toBe("ready"));
    expect(wire).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
  });
});
