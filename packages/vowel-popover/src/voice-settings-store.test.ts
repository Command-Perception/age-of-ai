import { afterEach, expect, it, vi } from "vitest";
import { createVoiceSettings } from "./voice-settings-store";

afterEach(() => vi.unstubAllGlobals());
it("uses a profile's pinned voice and keeps favorites per TTS provider", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const config = { baseURL: "https://example.test", apiKey: "test" };
  const first = { id: "first", created_at: 0, tts_provider: "fish-audio", voice: "fish:pinned" };
  const nariProfile = { id: "nari-profile", created_at: 0, tts_provider: "nari" };
  const voice = { id: "fish:voice", name: "Voice", detail: "en" };
  const nariVoice = { id: "nari:claire", name: "Claire", detail: "en · american · female" };
  const store = createVoiceSettings(config, first);
  store.selectVoice(voice);
  store.toggleFavorite(voice);
  store.selectProfile(nariProfile);
  // Nari favorites are a separate bucket — the Fish favorite does not leak.
  expect(store.getSnapshot()).toMatchObject({ voice: null, favorites: [] });
  store.selectVoice(nariVoice);
  store.toggleFavorite(nariVoice);
  expect(store.getSnapshot().favorites).toEqual([nariVoice]);
  store.selectProfile(first);
  // The browser override (latest selection) wins over the profile's pinned voice.
  expect(store.getSnapshot()).toMatchObject({ voice: { id: "fish:voice" }, favorites: [voice] });
  const restored = createVoiceSettings(config, first);
  expect(restored.getSnapshot()).toMatchObject({ voice: { id: "fish:voice" }, favorites: [voice] });
  restored.toggleFavorite(voice);
  expect(createVoiceSettings(config, first).getSnapshot().favorites).toEqual([]);
  // Both buckets remain independently persisted.
  expect(JSON.parse(storage.get("vowel.voice:https://example.test:favorites:Fish Audio") ?? "[]")).toEqual([]);
  expect(JSON.parse(storage.get("vowel.voice:https://example.test:favorites:Nari") ?? "[]")).toEqual([nariVoice]);
});

it("surfaces favorites saved under a provider bucket when the profile resolves auto first", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const config = { baseURL: "https://example.test", apiKey: "test" };
  const nariVoice = { id: "nari:claire", name: "Claire", detail: "en · american · female" };
  storage.set("vowel.voice:https://example.test:favorites:Nari", JSON.stringify([nariVoice]));
  // An auto profile opens with no bucket adopted — favorites must still be visible.
  const store = createVoiceSettings(config, { id: "auto-profile", created_at: 0 });
  expect(store.getSnapshot().provider).toBe("auto");
  expect(store.getSnapshot().favorites).toEqual([nariVoice]);
  // Toggle removes, toggles again re-adds, and the union keeps serving it for auto.
  store.toggleFavorite(nariVoice);
  expect(store.getSnapshot().favorites).toEqual([]);
  store.toggleFavorite(nariVoice);
  expect(store.getSnapshot().favorites).toEqual([nariVoice]);
  expect(createVoiceSettings(config, { id: "auto-profile", created_at: 0 }).getSnapshot().favorites).toEqual([nariVoice]);
});
