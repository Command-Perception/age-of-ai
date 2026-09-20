import { afterEach, expect, it, vi } from "vitest";
import { createVoiceSettings } from "./voice-settings-store";

afterEach(() => vi.unstubAllGlobals());

it("remembers an unpinned profile's selection without turning it into a profile pin", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const config = { baseURL: "https://example.test", apiKey: "test" };
  const voice = { id: "nari:claire", name: "Claire", detail: "en · american · female" };
  const store = createVoiceSettings(config, { id: "p1", created_at: 0 });
  store.selectVoice(voice);
  expect(store.getSnapshot().voice).toEqual(voice);
  expect(storage.get("vowel.voice:https://example.test:voice:p1")).toBe(JSON.stringify(voice));
  const restored = createVoiceSettings(config, { id: "p1", created_at: 0 });
  expect(restored.getSnapshot().profile.voice).toBeUndefined();
  expect(restored.getSnapshot().voice).toEqual(voice);
});

it("treats a profile-pinned voice as authoritative and read-only", async () => {
  const storage = new Map<string, string>();
  const override = { id: "nari:claire", name: "Claire", detail: "en · american · female" };
  storage.set("vowel.voice:https://example.test:voice:p1", JSON.stringify(override));
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const store = createVoiceSettings(
    { baseURL: "https://example.test", apiKey: "test" },
    { id: "p1", created_at: 0, voice: "fish:pinned" },
  );

  expect(store.getSnapshot()).toMatchObject({
    voice: { id: "fish:pinned", detail: "Pinned by this profile" },
    favorites: [],
  });
  store.selectVoice(override);
  store.toggleFavorite(override);
  expect(store.getSnapshot()).toMatchObject({ voice: { id: "fish:pinned" }, favorites: [] });
  await expect(store.listVoices("", 1)).resolves.toMatchObject({ data: [], hasMore: false });
});
