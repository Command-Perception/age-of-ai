import { VowelOverlay, createVoiceApi } from '@vowel/vowel-popover';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';

export interface VowelConnection {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly profileId: string;
  readonly profileName: string;
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

export const DEFAULT_VOWEL_URL = 'https://vowel.localhost';

export function readVowelConnection(): VowelConnection | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<VowelConnection>;
    if (!value.apiKey || !value.baseURL || !value.profileId) return null;
    return {
      apiKey: value.apiKey,
      baseURL: value.baseURL,
      profileId: value.profileId,
      profileName: value.profileName || 'Default profile',
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

/** Verifies the credentials, selects the server's default profile, and keeps
 * the API key in tab-scoped storage rather than persistent local storage. */
export async function configureVowel(apiKey: string, rawBaseURL: string): Promise<VowelConnection> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('Enter a Vowel API key.');
  const baseURL = normalizeBaseURL(rawBaseURL || DEFAULT_VOWEL_URL);
  const response = await fetch(new URL('/v1/session-profiles', baseURL), {
    credentials: 'include',
    headers: { Authorization: `Bearer ${trimmedKey}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `Vowel rejected the connection (${response.status}).`);
  }
  const body = await response.json() as { readonly data?: ReadonlyArray<VowelProfile> };
  const profiles = Array.isArray(body.data) ? body.data : [];
  const profile = profiles.find((item) => item.is_default === true || item.is_default === 1) ?? profiles[0];
  if (!profile?.id) throw new Error('No Vowel session profile is available for this key.');

  const connection: VowelConnection = {
    apiKey: trimmedKey,
    baseURL,
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

  const api = useMemo(() => connection ? createVoiceApi(
    { apiKey: connection.apiKey, baseURL: connection.baseURL },
    {
      id: connection.profileId,
      name: connection.profileName,
      created_at: 0,
      app_name: 'Age of AI',
    },
    {},
    'age-of-ai',
  ) : null, [connection]);

  if (!connection || !api) return null;
  return <VowelOverlay api={api} open={open} onClose={() => setOpen(false)} />;
}

export function mountVowel(): void {
  const host = document.createElement('div');
  host.id = 'vowel-root';
  document.body.appendChild(host);
  createRoot(host).render(<VowelMount />);
}
