import { api, apiStream, type Config, type RecordItem } from "./host/control-plane";

export type VoiceOption = { readonly id: string; readonly name: string; readonly detail: string };
export type VoiceCatalog = { readonly data: VoiceOption[]; readonly hasMore: boolean; readonly provider: string };

/** Favorites are bucketed per TTS provider so Fish voices never mix with Nari or Aura-2. */
const providerFromVoiceId = (id: string) =>
  id.startsWith("fish:") ? "Fish Audio"
  : id.startsWith("nari:") ? "Nari"
  : id.startsWith("deepgram:") ? "Deepgram"
  : id.startsWith("aura:") ? "Cloudflare Aura-2"
  : "";

const providerFromProfile = (profile: RecordItem) => {
  const raw = profile.tts_provider ?? "auto";
  return raw === "fish-audio" ? "Fish Audio"
    : raw === "nari" ? "Nari"
    : raw === "deepgram" ? "Deepgram"
    : raw === "cloudflare" ? "Cloudflare Aura-2"
    : "auto";
};

/** Resolves the favorites bucket: the catalog provider when known, otherwise the voice's own prefix. */
const favoritesBucket = (provider: string, voice?: VoiceOption) =>
  provider !== "auto" ? provider : (voice !== undefined ? providerFromVoiceId(voice.id) : "") || "auto";

export const createVoiceSettings = (config: Config, initialProfile: RecordItem) => {
  const favoritesKey = (provider: string) => `vowel.voice:${config.baseURL}:favorites:${provider}`;
  /** Buckets an "auto" profile unions across, so saved favorites never read as lost. */
  const KNOWN_PROVIDERS: ReadonlyArray<string> = ["auto", "Fish Audio", "Nari", "Deepgram", "Cloudflare Aura-2", "Groq Orpheus"];
  const profileVoice = (profile: RecordItem): VoiceOption | null =>
    typeof profile.voice === "string" && profile.voice.length > 0
      ? { id: profile.voice, name: profile.voice, detail: "Pinned by this profile" }
      : null;
  const readFavorites = (provider: string): VoiceOption[] => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(favoritesKey(provider)) ?? "null");
      if (Array.isArray(stored)) return stored.filter((item): item is VoiceOption => item !== null && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.detail === "string");
      if (provider !== "auto") {
        // One-time migration from the pre-provider buckets (favorites used to be a single shared list).
        const legacy: unknown = JSON.parse(localStorage.getItem(`vowel.voice:${config.baseURL}:favorites`) ?? "null");
        if (Array.isArray(legacy)) {
          const migrated = legacy
            .filter((item): item is VoiceOption => item !== null && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.detail === "string")
            .filter((item) => providerFromVoiceId(item.id) === provider);
          if (migrated.length > 0) writeFavorites(provider, migrated);
        }
      }
      // An "auto" profile cannot know which bucket holds its favorites until the
      // catalog resolves, so surface every bucket instead of showing them lost.
      if (provider === "auto") {
        const merged: VoiceOption[] = [];
        const seen = new Set<string>();
        for (const bucket of KNOWN_PROVIDERS) {
          const bucketItems: unknown = JSON.parse(localStorage.getItem(favoritesKey(bucket)) ?? "null");
          if (!Array.isArray(bucketItems)) continue;
          for (const item of bucketItems) {
            if (item === null || typeof item !== "object" || typeof (item as VoiceOption).id !== "string" || seen.has((item as VoiceOption).id)) continue;
            const option = item as VoiceOption;
            if (typeof option.name !== "string" || typeof option.detail !== "string") continue;
            seen.add(option.id);
            merged.push(option);
          }
        }
        if (merged.length > 0) return merged;
      }
    } catch { /* Storage may be disabled. */ }
    return [];
  };
  const writeFavorites = (provider: string, favorites: ReadonlyArray<VoiceOption>) => {
    try { localStorage.setItem(favoritesKey(provider), JSON.stringify(favorites)); } catch { /* Keep working when storage is disabled. */ }
  };
  const voicePreferenceKey = (profileId: string) => `vowel.voice:${config.baseURL}:voice:${profileId}`;
  const resolvedVoice = (profile: RecordItem): VoiceOption | null => {
    const pinned = profileVoice(profile);
    if (pinned !== null) return pinned;
    try {
      const raw = localStorage.getItem(voicePreferenceKey(profile.id));
      if (!raw) return null;
      const stored: unknown = JSON.parse(raw);
      return stored !== null && typeof stored === "object" && typeof (stored as VoiceOption).id === "string" && typeof (stored as VoiceOption).name === "string" && typeof (stored as VoiceOption).detail === "string"
        ? stored as VoiceOption
        : null;
    } catch { return null; }
  };
  let state = {
    profile: initialProfile,
    voice: resolvedVoice(initialProfile),
    provider: providerFromProfile(initialProfile),
    favorites: profileVoice(initialProfile) === null ? readFavorites(providerFromProfile(initialProfile)) : [],
  };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    selectProfile: (profile: RecordItem) => {
      let provider = providerFromProfile(profile);
      const voice = resolvedVoice(profile);
      state = { profile, voice, provider, favorites: profileVoice(profile) === null ? readFavorites(provider) : [] };
      notify();
    },
    selectVoice: (voice: VoiceOption | null) => {
      if (profileVoice(state.profile) !== null) return;
      state = { ...state, voice };
      // An "auto" profile resolves its provider through the catalog; adopt the
      // selected voice's provider so subsequent favorites land in that bucket.
      if (state.provider === "auto" && voice !== null) {
        const provider = providerFromVoiceId(voice.id);
        if (provider) state = { ...state, provider, favorites: readFavorites(provider) };
      }
      notify();
      try {
        if (voice === null) localStorage.removeItem(voicePreferenceKey(state.profile.id));
        else localStorage.setItem(voicePreferenceKey(state.profile.id), JSON.stringify(voice));
      } catch { /* Keep the current-session choice when storage is disabled. */ }
    },
    toggleFavorite: (voice: VoiceOption) => {
      if (profileVoice(state.profile) !== null) return;
      const provider = favoritesBucket(state.provider, voice);
      const favorites = readFavorites(provider);
      const next = favorites.some((item) => item.id === voice.id)
        ? favorites.filter((item) => item.id !== voice.id)
        : [...favorites, voice];
      state = { ...state, provider, favorites: next };
      writeFavorites(provider, next);
      notify();
    },
    previewVoice: (signal: AbortSignal) => apiStream(config, "/v1/voices/preview", {
      method: "POST", signal, body: JSON.stringify({ profile_id: state.profile.id, voice: state.voice?.id ?? "" }),
    }),
    listProfiles: () => api<{ data: RecordItem[] }>(config, "/v1/session-profiles"),
    listVoices: (query: string, page = 1, signal?: AbortSignal) => profileVoice(state.profile) !== null
      ? Promise.resolve({ data: [], hasMore: false, provider: state.provider })
      : api<VoiceCatalog>(config,
        `/v1/voices?${new URLSearchParams({ profile_id: state.profile.id, q: query, page: String(page) })}`,
        signal ? { signal } : {},
      ).then((result) => {
      // Adopt the catalog's provider when it refines the profile-level guess.
      if (result.provider && result.provider !== state.provider) {
        state = { ...state, provider: result.provider, favorites: readFavorites(result.provider) };
        notify();
      }
      return result;
      }),
  };
};
export type VoiceSettingsStore = ReturnType<typeof createVoiceSettings>;
