import { afterEach, expect, it, vi } from "vitest";
import { createVoiceSettings } from "./voice-settings-store";

afterEach(() => vi.unstubAllGlobals());

it("keeps the browser-pinned default voice across refresh, overriding an older profile pin", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const config = { baseURL: "https://example.test", apiKey: "test" };
  const voice = { id: "nari:claire", name: "Claire", detail: "en · american · female" };
  const store = createVoiceSettings(config, { id: "p1", created_at: 0, voice: "claire" });
  store.selectVoice(voice);
  // The full option is persisted, so the refreshed page shows the same name.
  expect(storage.get("vowel.voice:https://example.test:voice:p1")).toBe(JSON.stringify(voice));
  const restored = createVoiceSettings(config, { id: "p1", created_at: 0, voice: "claire" });
  expect(restored.getSnapshot().voice).toMatchObject({ id: "nari:claire", name: "Claire" });
  // Choosing "provider default" clears the override and falls back to the profile pin.
  restored.selectVoice(null);
  expect(restored.getSnapshot().voice).toBe(null);
  expect(storage.get("vowel.voice:https://example.test:voice:p1")).toBe("");
  expect(createVoiceSettings(config, { id: "p1", created_at: 0, voice: "claire" }).getSnapshot().voice)
    .toMatchObject({ detail: "Pinned by this profile" });
  expect(createVoiceSettings(config, { id: "p1", created_at: 0 }).getSnapshot().voice).toBe(null);
});
