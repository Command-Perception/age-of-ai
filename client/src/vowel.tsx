import { VowelOverlay, createVoiceApi, type VoiceApi } from '@vowel/vowel-popover';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { withGameVoice } from './game/vowel-game-api';

export interface VowelConnection {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly kind: 'client' | 'server';
  readonly profileId: string;
  readonly profileName: string;
  readonly profileVoice: string | null;
  readonly profileTtsProvider: string;
  readonly profileMetadataVersion: 0 | 1 | 2;
  readonly pendingSession?: VowelClientSession;
}

interface VowelClientSession {
  readonly sessionId: string;
  readonly clientSecret: string;
  readonly expiresAt: number;
  readonly profile?: {
    readonly id: string;
    readonly name: string;
    readonly voice: string | null;
    readonly ttsProvider: string;
  };
}

interface VowelProfile {
  readonly id: string;
  readonly name?: string | null;
  readonly is_default?: number | boolean;
  readonly created_at?: number;
  readonly voice?: string | null;
  readonly tts_provider?: string;
}

interface VowelVoiceOption {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

const STORAGE_KEY = 'ageofai:vowel-connection';
const CONNECTION_EVENT = 'ageofai:vowel-connection-change';
const OPEN_EVENT = 'ageofai:vowel-open';
const SCREEN_EVENT = 'ageofai:vowel-screen-change';

let screenActive = false;

export function setVowelScreenActive(active: boolean): void {
  screenActive = active;
  window.dispatchEvent(new CustomEvent(SCREEN_EVENT, { detail: active }));
}

export const DEFAULT_VOWEL_URL = 'https://vowel.localhost';

export class VowelNetworkError extends Error {
  constructor(readonly baseURL: string, options?: ErrorOptions) {
    super(`Could not reach Vowel at ${baseURL}.`, options);
    this.name = 'VowelNetworkError';
  }
}

function readErrorMessage(raw: string): string {
  const fallback = raw.trim();
  if (!fallback) return '';
  try {
    const body = JSON.parse(fallback) as {
      readonly message?: unknown;
      readonly error?: unknown;
    };
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error === 'object' && 'message' in body.error) {
      const message = (body.error as { readonly message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Non-JSON responses are still useful as-is.
  }
  return fallback;
}

export function readVowelConnection(): VowelConnection | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<VowelConnection>;
    if (!value.apiKey || !value.baseURL || !value.profileId) return null;
    return {
      apiKey: value.apiKey,
      baseURL: value.baseURL,
      kind: value.kind === 'client' || value.apiKey.startsWith('vc_') ? 'client' : 'server',
      profileId: value.profileId,
      profileName: value.profileName || 'Default profile',
      profileVoice: typeof value.profileVoice === 'string' ? value.profileVoice : null,
      profileTtsProvider: value.profileTtsProvider || 'auto',
      profileMetadataVersion: value.profileMetadataVersion === 2 ? 2 : value.profileMetadataVersion === 1 ? 1 : 0,
      ...(value.pendingSession ? { pendingSession: value.pendingSession } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeBaseURL(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Vowel URL must use http or https.');
  }
  return url.toString().replace(/\/$/, '');
}

async function fetchVowel(baseURL: string, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(new URL(input, baseURL), init);
  } catch (cause) {
    throw new VowelNetworkError(baseURL, { cause });
  }
}

async function mintClientSession(apiKey: string, baseURL: string): Promise<VowelClientSession> {
  const sessionId = crypto.randomUUID();
  const response = await fetchVowel(baseURL, '/v1/realtime/client_secrets', {
    body: JSON.stringify({ session_id: sessionId }),
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const detail = readErrorMessage(await response.text());
    throw new Error(detail || `Vowel rejected the connection (${response.status}).`);
  }
  const body = await response.json() as {
    readonly client_secret?: unknown;
    readonly expires_at?: unknown;
    readonly profile?: {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly voice?: unknown;
      readonly tts_provider?: unknown;
    };
  };
  if (typeof body.client_secret !== 'string') {
    throw new Error('Vowel did not return a voice-session credential.');
  }
  return {
    sessionId,
    clientSecret: body.client_secret,
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at : Date.now() + 5 * 60_000,
    ...(body.profile && typeof body.profile.id === 'string' && typeof body.profile.name === 'string'
      ? {
          profile: {
            id: body.profile.id,
            name: body.profile.name,
            voice: typeof body.profile.voice === 'string' ? body.profile.voice : null,
            ttsProvider: typeof body.profile.tts_provider === 'string' ? body.profile.tts_provider : 'auto',
          },
        }
      : {}),
  };
}

function realtimeURL(baseURL: string): string {
  const url = new URL('/v1/realtime', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

const VOICE_PROVIDERS = ['auto', 'Fish Audio', 'Nari', 'Deepgram', 'Cloudflare Aura-2', 'Groq Orpheus'] as const;

function providerFromVoice(id: string): string {
  return id.startsWith('fish:') ? 'Fish Audio'
    : id.startsWith('nari:') ? 'Nari'
    : id.startsWith('deepgram:') ? 'Deepgram'
    : id.startsWith('aura:') ? 'Cloudflare Aura-2'
    : id.startsWith('groq:') ? 'Groq Orpheus'
    : 'auto';
}

function voicePreferenceKey(connection: VowelConnection): string {
  return `vowel.voice:${connection.baseURL}:voice:${connection.profileId}`;
}

function selectedVoice(connection: VowelConnection): VowelVoiceOption | null {
  if (connection.profileVoice) {
    return { id: connection.profileVoice, name: connection.profileVoice, detail: 'Pinned by this profile' };
  }
  try {
    const raw = window.localStorage.getItem(voicePreferenceKey(connection));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<VowelVoiceOption>;
    return typeof stored.id === 'string' && typeof stored.name === 'string' && typeof stored.detail === 'string'
      ? { id: stored.id, name: stored.name, detail: stored.detail }
      : null;
  } catch {
    return null;
  }
}

function favoritesKey(connection: VowelConnection, provider: string): string {
  return `vowel.voice:${connection.baseURL}:favorites:${provider}`;
}

function readFavorites(connection: VowelConnection, provider: string): VowelVoiceOption[] {
  const providers = provider === 'auto' ? VOICE_PROVIDERS : [provider];
  const favorites: VowelVoiceOption[] = [];
  const seen = new Set<string>();
  try {
    for (const bucket of providers) {
      const stored: unknown = JSON.parse(window.localStorage.getItem(favoritesKey(connection, bucket)) ?? '[]');
      if (!Array.isArray(stored)) continue;
      for (const item of stored) {
        if (item === null || typeof item !== 'object') continue;
        const voice = item as Partial<VowelVoiceOption>;
        if (typeof voice.id !== 'string' || typeof voice.name !== 'string' || typeof voice.detail !== 'string' || seen.has(voice.id)) continue;
        seen.add(voice.id);
        favorites.push({ id: voice.id, name: voice.name, detail: voice.detail });
      }
    }
  } catch {
    // Browser storage is optional.
  }
  return favorites;
}

function createClientVoiceSettings(connection: VowelConnection): NonNullable<VoiceApi['settings']> {
  const profile = {
    id: connection.profileId,
    name: connection.profileName,
    created_at: 0,
    tts_provider: connection.profileTtsProvider,
    ...(connection.profileVoice ? { voice: connection.profileVoice } : {}),
  };
  let snapshot = {
    profile,
    voice: selectedVoice(connection),
    provider: connection.profileTtsProvider,
    favorites: connection.profileVoice ? [] : readFavorites(connection, connection.profileTtsProvider),
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    selectProfile: () => undefined,
    selectVoice: (voice) => {
      if (connection.profileVoice) return;
      snapshot = { ...snapshot, voice };
      try {
        if (voice) window.localStorage.setItem(voicePreferenceKey(connection), JSON.stringify(voice));
        else window.localStorage.removeItem(voicePreferenceKey(connection));
      } catch {
        // Keep the current-session choice when storage is disabled.
      }
      notify();
    },
    toggleFavorite: (voice) => {
      if (connection.profileVoice) return;
      const provider = snapshot.provider === 'auto' ? providerFromVoice(voice.id) : snapshot.provider;
      const favorites = readFavorites(connection, provider);
      const next = favorites.some((item) => item.id === voice.id)
        ? favorites.filter((item) => item.id !== voice.id)
        : [...favorites, voice];
      snapshot = {
        ...snapshot,
        provider,
        favorites: next,
      };
      try {
        window.localStorage.setItem(favoritesKey(connection, provider), JSON.stringify(next));
      } catch {
        // Keep the current-session favorites when storage is disabled.
      }
      notify();
    },
    previewVoice: async (signal) => {
      if (!snapshot.voice) throw new Error('Select a voice to preview.');
      const response = await fetchVowel(connection.baseURL, '/v1/voices/preview', {
        body: JSON.stringify({ profile_id: connection.profileId, voice: snapshot.voice.id }),
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal,
      });
      if (!response.ok) {
        const detail = readErrorMessage(await response.text());
        throw new Error(detail || `Vowel could not preview this voice (${response.status}).`);
      }
      if (!response.body) throw new Error('Vowel returned no preview audio.');
      return response.body;
    },
    listProfiles: async () => ({ data: [profile] }),
    listVoices: async (query, page = 1, signal) => {
      if (connection.profileVoice) {
        const pinned = selectedVoice(connection);
        return {
          data: pinned ? [pinned] : [],
          hasMore: false,
          provider: snapshot.provider,
        };
      }
      const search = new URLSearchParams({
        profile_id: connection.profileId,
        q: query,
        page: String(page),
      });
      const response = await fetchVowel(connection.baseURL, `/v1/voices?${search}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${connection.apiKey}` },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        const detail = readErrorMessage(await response.text());
        throw new Error(detail || `Vowel could not load voices (${response.status}).`);
      }
      const body = await response.json() as {
        readonly data?: VowelVoiceOption[];
        readonly hasMore?: boolean;
        readonly provider?: string;
      };
      const result = {
        data: Array.isArray(body.data) ? body.data : [],
        hasMore: body.hasMore === true,
        provider: typeof body.provider === 'string' ? body.provider : snapshot.provider,
      };
      if (result.provider !== snapshot.provider) {
        snapshot = { ...snapshot, provider: result.provider, favorites: readFavorites(connection, result.provider) };
        notify();
      }
      return result;
    },
  };
}

function createClientVoiceApi(connection: VowelConnection): VoiceApi {
  let pendingSession = connection.pendingSession;
  const profileSettings = createClientVoiceSettings(connection);
  return {
    profileLocked: true,
    settings: profileSettings,
    voiceAvailability: async () => ({ available: true }),
    voiceSession: async () => {
      let session = pendingSession;
      pendingSession = undefined;
      if (!session || session.expiresAt <= Date.now() + 5_000) {
        session = await mintClientSession(connection.apiKey, connection.baseURL);
      } else {
        const stored = readVowelConnection();
        if (stored?.apiKey === connection.apiKey) {
          window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, pendingSession: undefined }));
        }
      }
      return { ...session, realtimeUrl: realtimeURL(connection.baseURL) };
    },
    voiceTools: async () => [],
    executeVoiceTool: async (name) => ({
      ok: false,
      operation: name,
      error: { recoverable: true, code: 'ToolUnavailable', message: 'This app does not expose voice tools.' },
    }),
  };
}

/** Verifies the credentials, selects the server's default profile, and keeps
 * the API key in tab-scoped storage rather than persistent local storage. */
export async function configureVowel(apiKey: string, rawBaseURL: string): Promise<VowelConnection> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('Enter a Vowel API key.');
  const baseURL = normalizeBaseURL(rawBaseURL || DEFAULT_VOWEL_URL);
  if (trimmedKey.startsWith('vc_')) {
    const pendingSession = await mintClientSession(trimmedKey, baseURL);
    if (!pendingSession.profile) {
      throw new Error('Vowel did not return the profile assigned to this client key. Update Vowel and try again.');
    }
    const connection: VowelConnection = {
      apiKey: trimmedKey,
      baseURL,
      kind: 'client',
      profileId: pendingSession.profile.id,
      profileName: pendingSession.profile.name,
      profileVoice: pendingSession.profile.voice,
      profileTtsProvider: pendingSession.profile.ttsProvider,
      profileMetadataVersion: 2,
      pendingSession,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
    window.dispatchEvent(new CustomEvent(CONNECTION_EVENT));
    return connection;
  }

  const response = await fetchVowel(baseURL, '/v1/session-profiles', {
    credentials: 'include',
    headers: { Authorization: `Bearer ${trimmedKey}` },
  });
  if (!response.ok) {
    const detail = readErrorMessage(await response.text());
    throw new Error(detail || `Vowel rejected the connection (${response.status}).`);
  }
  const body = await response.json() as { readonly data?: ReadonlyArray<VowelProfile> };
  const profiles = Array.isArray(body.data) ? body.data : [];
  const profile = profiles.find((item) => item.is_default === true || item.is_default === 1) ?? profiles[0];
  if (!profile?.id) throw new Error('No Vowel session profile is available for this key.');

  const connection: VowelConnection = {
    apiKey: trimmedKey,
    baseURL,
    kind: 'server',
    profileId: profile.id,
    profileName: profile.name || 'Default profile',
    profileVoice: typeof profile.voice === 'string' ? profile.voice : null,
    profileTtsProvider: profile.tts_provider || 'auto',
    profileMetadataVersion: 2,
  };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  window.dispatchEvent(new CustomEvent(CONNECTION_EVENT));
  return connection;
}

export function clearVowelConnection(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(CONNECTION_EVENT));
}

export function showVowel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function subscribeVowelConnection(listener: () => void): () => void {
  window.addEventListener(CONNECTION_EVENT, listener);
  return () => window.removeEventListener(CONNECTION_EVENT, listener);
}

function VowelMount() {
  const [connection, setConnection] = useState<VowelConnection | null>(() => readVowelConnection());
  const [open, setOpen] = useState(() => connection !== null);
  const [activeScreen, setActiveScreen] = useState(() => screenActive);
  const clientProfileRefreshStarted = useRef(false);

  useEffect(() => {
    const onConnection = () => {
      const next = readVowelConnection();
      setConnection(next);
      setOpen(next !== null);
    };
    const onOpen = () => {
      if (readVowelConnection()) setOpen(true);
    };
    window.addEventListener(CONNECTION_EVENT, onConnection);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(CONNECTION_EVENT, onConnection);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    const onScreen = (event: Event) => setActiveScreen((event as CustomEvent<boolean>).detail);
    window.addEventListener(SCREEN_EVENT, onScreen);
    return () => window.removeEventListener(SCREEN_EVENT, onScreen);
  }, []);

  useEffect(() => {
    if (!connection || connection.kind !== 'client') return;
    if (clientProfileRefreshStarted.current) return;
    clientProfileRefreshStarted.current = true;
    let cancelled = false;
    void mintClientSession(connection.apiKey, connection.baseURL).then((pendingSession) => {
      if (cancelled || !pendingSession.profile) return;
      const resolved: VowelConnection = {
        ...connection,
        profileId: pendingSession.profile.id,
        profileName: pendingSession.profile.name,
        profileVoice: pendingSession.profile.voice,
        profileTtsProvider: pendingSession.profile.ttsProvider,
        profileMetadataVersion: 2,
        pendingSession,
      };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
      window.dispatchEvent(new CustomEvent(CONNECTION_EVENT));
    }).catch(() => {
      // Allow a later connection event to retry if the one-time refresh failed.
      clientProfileRefreshStarted.current = false;
    });
    return () => { cancelled = true; };
  }, [connection]);

  const api = useMemo(() => {
    if (!connection) return null;
    if (connection.kind === 'client') return withGameVoice(createClientVoiceApi(connection), connection);
    return withGameVoice(createVoiceApi(
      { apiKey: connection.apiKey, baseURL: connection.baseURL },
      {
        id: connection.profileId,
        name: connection.profileName,
        created_at: 0,
        app_name: 'Age of AI',
      },
      {},
      'age-of-ai',
    ), connection);
  }, [connection]);

  if (!connection || !api || !activeScreen) return null;
  return (
    <RadixTooltip.Provider delayDuration={0}>
      <VowelOverlay api={api} open={open} onClose={() => setOpen(false)} />
    </RadixTooltip.Provider>
  );
}

export function mountVowel(): void {
  const host = document.createElement('div');
  host.id = 'vowel-root';
  document.body.appendChild(host);
  createRoot(host).render(<VowelMount />);

  let observedHud: Element | null = null;
  const resizeObserver = new ResizeObserver(() => syncHostChrome());
  const syncHostChrome = () => {
    const hud = document.querySelector('.hud-top');
    if (hud !== observedHud) {
      resizeObserver.disconnect();
      observedHud = hud;
      if (hud) resizeObserver.observe(hud);
    }
    const hudVisible = hud instanceof HTMLElement && hud.offsetParent !== null;
    const top = hudVisible ? Math.ceil(hud.getBoundingClientRect().bottom + 8) : 8;
    host.style.setProperty('--vowel-overlay-top', `${top}px`);
    for (const button of host.querySelectorAll<HTMLButtonElement>('button[aria-label]')) {
      if (!button.title) button.title = button.getAttribute('aria-label') ?? '';
    }
  };
  const observer = new MutationObserver(syncHostChrome);
  observer.observe(document.body, { childList: true, subtree: true });
  syncHostChrome();
}
