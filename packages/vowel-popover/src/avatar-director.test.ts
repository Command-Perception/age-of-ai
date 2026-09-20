import { describe, expect, it, vi } from "vitest";
import { createAvatarDirectorClient } from "./avatar-director";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Avatar Director client", () => {
  it("uses one Director session and emits transcript, semantic beat, interruption, and close events", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "director-1", eventsUrl: "/v1/avatar/sessions/director-1/events" }, 201))
      .mockResolvedValue(response({}));
    const client = createAvatarDirectorClient({ baseURL: "https://avtrs.test/console", fetch: fetcher });
    await client.start();
    await client.userTranscript("Hello there");
    await client.assistantTranscript("Hi, how can I help?");
    await client.interrupt();
    await client.close();
    const requests = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }));
    expect(requests).toEqual([
      { url: "https://avtrs.test/v1/avatar/sessions", body: undefined },
      { url: "https://avtrs.test/v1/avatar/sessions/director-1/events", body: { _tag: "TranscriptFinal", text: "Hello there" } },
      expect.objectContaining({ url: "https://avtrs.test/v1/avatar/sessions/director-1/events", body: expect.objectContaining({ _tag: "SemanticBeatReady", beat: expect.objectContaining({ text: "Hi, how can I help?" }) }) }),
      { url: "https://avtrs.test/v1/avatar/sessions/director-1/events", body: expect.objectContaining({ _tag: "UserInterrupted" }) },
      { url: "https://avtrs.test/v1/avatar/sessions/director-1/events", body: { _tag: "SessionClosed" } },
    ]);
  });
});
