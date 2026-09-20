import { getClientId } from '../identity';

export const announcementCategories = {
  buildingComplete: ['Game Progress', 'Building complete'],
  researchComplete: ['Game Progress', 'Research complete'],
  ageAvailable: ['Game Progress', 'Age upgrade available'],
  idleVillagers: ['Economy', 'Idle villagers'],
  population: ['Economy', 'Population warnings'],
  resourceShortage: ['Economy', 'Resource shortage'],
  resourceSurplus: ['Economy', 'Resource surplus / spending suggestions'],
  enemySpotted: ['Military', 'Enemy spotted'],
  underAttack: ['Military', 'Under attack'],
  militaryIdle: ['Military', 'Military units idle'],
  strategicOpportunities: ['Advisor', 'Strategic opportunities'],
  economyAdvice: ['Advisor', 'Economy optimization suggestions'],
  productionAdvice: ['Advisor', 'Production suggestions'],
} as const;
export type AnnouncementCategory = keyof typeof announcementCategories;
export type Frequency = 'low' | 'normal' | 'high';
export interface CategoryPreference { enabled: boolean; threshold?: number; remainingSlotsThreshold?: number; frequency?: Frequency }
export type AnnouncementPreferences = Record<AnnouncementCategory, CategoryPreference> & {
  mute: { mutedUntil: number | null; untilUnmuted: boolean; urgentOverrideEnabled: boolean };
};
export interface ActiveAnnouncementCondition {
  id: string; category: AnnouncementCategory; label: string; detail?: string; activeSince: number; enabled: boolean;
}
export interface AnnouncementPreferencePersistence { load(): unknown; save(value: AnnouncementPreferences): void }
export interface AnnouncementPreferenceStore {
  get(): AnnouncementPreferences;
  update(category: AnnouncementCategory, patch: Partial<CategoryPreference>): AnnouncementPreferences;
  mute(until: number | 'forever' | null, urgentOverride?: boolean): AnnouncementPreferences;
  reset(): AnnouncementPreferences;
  subscribe(listener: () => void): () => void;
  readonly error: string | null;
}
const defaults = (): AnnouncementPreferences => ({
  buildingComplete: { enabled: true }, researchComplete: { enabled: true }, ageAvailable: { enabled: true },
  idleVillagers: { enabled: true, threshold: 2 }, population: { enabled: true, remainingSlotsThreshold: 2 },
  resourceShortage: { enabled: true }, resourceSurplus: { enabled: false }, enemySpotted: { enabled: true },
  underAttack: { enabled: true }, militaryIdle: { enabled: true },
  strategicOpportunities: { enabled: true, frequency: 'low' }, economyAdvice: { enabled: false, frequency: 'low' },
  productionAdvice: { enabled: false, frequency: 'low' },
  mute: { mutedUntil: null, untilUnmuted: false, urgentOverrideEnabled: true },
});
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(category: AnnouncementCategory, patch: unknown): Partial<CategoryPreference> {
  if (!record(patch)) throw new Error('A preference update must be an object.');
  const next: Partial<CategoryPreference> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'enabled' && typeof value === 'boolean') next.enabled = value;
    else if ((key === 'threshold' && category === 'idleVillagers') || (key === 'remainingSlotsThreshold' && category === 'population')) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) throw new Error('Threshold must be a whole number from 1 to 100.');
      next[key] = value;
    } else if (key === 'frequency' && ['strategicOpportunities', 'economyAdvice', 'productionAdvice'].includes(category) && (value === 'low' || value === 'normal' || value === 'high')) next.frequency = value;
    else throw new Error(`Invalid ${category} preference: ${key}`);
  }
  return next;
}
export function createAnnouncementPreferenceStore(persistence: AnnouncementPreferencePersistence): AnnouncementPreferenceStore {
  let value = defaults();
  let failure: string | null = null;
  const listeners = new Set<() => void>();
  try {
    const raw = persistence.load();
    if (record(raw)) {
      for (const key of Object.keys(announcementCategories) as AnnouncementCategory[]) {
        if (raw[key] !== undefined) value[key] = { ...value[key], ...validate(key, raw[key]) };
      }
      if (record(raw.mute)) {
        const m = raw.mute;
        if (typeof m.urgentOverrideEnabled === 'boolean') value.mute.urgentOverrideEnabled = m.urgentOverrideEnabled;
        if (typeof m.untilUnmuted === 'boolean') value.mute.untilUnmuted = m.untilUnmuted;
        if (typeof m.mutedUntil === 'number' && Number.isFinite(m.mutedUntil)) value.mute.mutedUntil = m.mutedUntil;
      }
    }
  } catch { value = defaults(); failure = 'Announcements settings could not be loaded. Safe defaults are active for this session.'; }
  const snapshot = () => structuredClone(value);
  const commit = () => {
    try { persistence.save(value); failure = null; }
    catch { failure = 'Announcements settings could not be saved. Changes apply only to this session.'; }
    for (const listener of listeners) listener();
    return snapshot();
  };
  return {
    get: snapshot, get error() { return failure; },
    update(category, patch) {
      if (!Object.hasOwn(announcementCategories, category)) throw new Error('Unknown announcement category.');
      value = { ...value, [category]: { ...value[category], ...validate(category, patch) } };
      return commit();
    },
    mute(until, urgentOverride) {
      if (until !== null && until !== 'forever' && (!Number.isFinite(until) || until < Date.now())) throw new Error('Mute expiration must be in the future.');
      value = { ...value, mute: { mutedUntil: typeof until === 'number' ? until : null, untilUnmuted: until === 'forever', urgentOverrideEnabled: urgentOverride ?? value.mute.urgentOverrideEnabled } };
      return commit();
    },
    reset() { value = defaults(); return commit(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
const storageKey = `ageofai:announcements:v1:${getClientId()}`;
export const announcementPreferences = createAnnouncementPreferenceStore({
  load: () => { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : null; },
  save: value => localStorage.setItem(storageKey, JSON.stringify(value)),
});
let conditions: ActiveAnnouncementCondition[] = [];
const conditionListeners = new Set<() => void>();
export const activeAnnouncements = {
  get: () => conditions.map(c => ({ ...c, enabled: announcementPreferences.get()[c.category].enabled })),
  set(value: ActiveAnnouncementCondition[]) { conditions = value; for (const listener of conditionListeners) listener(); },
  subscribe(listener: () => void) { conditionListeners.add(listener); return () => { conditionListeners.delete(listener); }; },
};
export function announcementAllowed(category: AnnouncementCategory, urgent = false): boolean {
  const prefs = announcementPreferences.get();
  return prefs[category].enabled && (!(prefs.mute.untilUnmuted || (prefs.mute.mutedUntil ?? 0) > Date.now()) || (urgent && prefs.mute.urgentOverrideEnabled));
}
