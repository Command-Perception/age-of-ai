import { VowelOverlay, createVoiceApi, type VoiceApi } from '@vowel/vowel-popover';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';

export interface VowelConnection {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly kind: 'client' | 'server';
  readonly profileId: string;
  readonly profileName: string;
  readonly pendingSession?: VowelClientSession;
}

interface VowelClientSession {
  readonly sessionId: string;
  readonly clientSecret: string;
  readonly expiresAt: number;
  readonly profile?: {
    readonly id: string;
    readonly name: string;
  };
}

interface VowelProfile {
  readonly id: string;
  readonly name?: string | null;
  readonly is_default?: number | boolean;
  readonly created_at?: number;
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
      ? { profile: { id: body.profile.id, name: body.profile.name } }
      : {}),
  };
}

function realtimeURL(baseURL: string): string {
  const url = new URL('/v1/realtime', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function createClientVoiceApi(connection: VowelConnection): VoiceApi {
  let pendingSession = connection.pendingSession;
  const profile = {
    id: connection.profileId,
    name: connection.profileName,
    created_at: 0,
  };
  const settingsSnapshot = { profile, voice: null, provider: 'auto', favorites: [] };
  const profileSettings: NonNullable<VoiceApi['settings']> = {
    getSnapshot: () => settingsSnapshot,
    subscribe: () => () => undefined,
    selectProfile: () => undefined,
    selectVoice: () => undefined,
    toggleFavorite: () => undefined,
    previewVoice: async () => { throw new Error('Voice preview is managed by the bound Vowel profile.'); },
    listProfiles: async () => ({ data: [profile] }),
    listVoices: async () => ({ data: [], hasMore: false, provider: 'auto' }),
  };
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
    if (!connection || connection.kind !== 'client' || connection.profileId !== 'key-bound') return;
    let cancelled = false;
    void mintClientSession(connection.apiKey, connection.baseURL).then((pendingSession) => {
      if (cancelled || !pendingSession.profile) return;
      const resolved: VowelConnection = {
        ...connection,
        profileId: pendingSession.profile.id,
        profileName: pendingSession.profile.name,
        pendingSession,
      };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
      window.dispatchEvent(new CustomEvent(CONNECTION_EVENT));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [connection]);

  const api = useMemo(() => {
    if (!connection) return null;
    if (connection.kind === 'client') return createClientVoiceApi(connection);
    return createVoiceApi(
      { apiKey: connection.apiKey, baseURL: connection.baseURL },
      {
        id: connection.profileId,
        name: connection.profileName,
        created_at: 0,
        app_name: 'Age of AI',
      },
      {},
      'age-of-ai',
    );
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
