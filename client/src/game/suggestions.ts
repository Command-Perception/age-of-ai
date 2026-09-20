import { getClientId } from '../identity';

export type SuggestionBias = 'resources' | 'military' | 'technology' | 'balanced' | 'none';
export interface SuggestionPreferences { enabled: boolean; bias: SuggestionBias }

const BIASES: readonly SuggestionBias[] = ['resources', 'military', 'technology', 'balanced', 'none'];
const defaults = (): SuggestionPreferences => ({ enabled: false, bias: 'balanced' });
const storageKey = `ageofai:suggestions:v1:${getClientId()}`;
let value = defaults();
let failure: string | null = null;
const listeners = new Set<() => void>();

try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<SuggestionPreferences>;
    value = {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      bias: BIASES.includes(parsed.bias as SuggestionBias) ? parsed.bias as SuggestionBias : 'balanced',
    };
  }
} catch {
  failure = 'Suggestion settings could not be loaded. Suggestions are off for this session.';
}

const snapshot = (): SuggestionPreferences => ({ ...value });
const commit = () => {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); failure = null; }
  catch { failure = 'Suggestion settings could not be saved. Changes apply only to this session.'; }
  for (const listener of listeners) listener();
  return snapshot();
};

export const suggestionPreferences = {
  get: snapshot,
  update(patch: Partial<SuggestionPreferences>): SuggestionPreferences {
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean.');
    if (patch.bias !== undefined && !BIASES.includes(patch.bias)) throw new Error('Unknown suggestion bias.');
    value = { ...value, ...patch };
    return commit();
  },
  reset(): SuggestionPreferences { value = defaults(); return commit(); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  get error() { return failure; },
};

export const suggestionBiases = BIASES;
