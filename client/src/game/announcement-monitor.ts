import { BUILDING_DEFS, NODE_DEFS, TECH_DEFS, TRAIN_QUEUE_MAX, UNIT_DEFS, type BuildingSnap, type ResourceType, type UnitType } from '@age/shared';
import type { GameState } from '../state';
import { activeAnnouncements, announcementAllowed, announcementPreferences, type ActiveAnnouncementCondition, type AnnouncementCategory } from './announcements';
import { gameAffordances, gameVoiceContext, type GameInteraction } from './voice-context';
import { choice, type Decide, type GameTrace } from './voice-decision';
import { suggestionPreferences, type SuggestionBias } from './suggestions';

export type SemanticGameEvent = {
  id: string; type: 'building.completed' | 'research.completed' | 'economy.idle_villagers' | 'population.changed' | 'age.available' | 'resources.changed' | 'enemy.spotted' | 'combat.under_attack' | 'military.idle' | 'strategy.review';
  category: AnnouncementCategory; at: number; tick: number; entityIds: number[]; label: string;
};
export type SuppressionReason = 'disabled' | 'muted' | 'cooldown' | 'duplicate' | 'expired' | 'condition_cleared' | 'low_relevance' | 'superseded' | 'conversation_busy' | 'coordinator_silent';
export interface GameAnnouncement {
  id: string; category: AnnouncementCategory; priority: 'low' | 'normal' | 'high' | 'urgent';
  createdAt: number; expiresAt: number; dedupeKey: string; conditionId?: string;
  factualSummary: string; conversationalHint?: string; source: 'deterministic' | 'decision_model' | 'background_llm';
  proposedCommand?: string;
  requiresRevalidation: boolean; event: SemanticGameEvent;
}
const cooldowns: Partial<Record<AnnouncementCategory, number>> = { idleVillagers: 15000, population: 20000, resourceShortage: 30000, resourceSurplus: 45000, enemySpotted: 15000, underAttack: 10000, militaryIdle: 30000, strategicOpportunities: 45000, economyAdvice: 45000, productionAdvice: 45000, strategySuggestion: 75000 };
const advisory = new Set<AnnouncementCategory>(['resourceSurplus', 'strategicOpportunities', 'economyAdvice', 'productionAdvice', 'strategySuggestion']);
const strategyAdvisory = new Set<AnnouncementCategory>(['strategicOpportunities', 'economyAdvice', 'productionAdvice', 'strategySuggestion']);
const priorityOf = (category: AnnouncementCategory): GameAnnouncement['priority'] => category === 'underAttack' ? 'urgent' : ['population', 'ageAvailable', 'enemySpotted'].includes(category) ? 'high' : advisory.has(category) ? 'low' : 'normal';
const rank = { urgent: 4, high: 3, normal: 2, low: 1 };

/** Semantic transitions are independent of rendering and voice connectivity. The
 * long-lived Vowel agent consumes this bounded source through its tool channel. */
export class AnnouncementMonitor {
  private previousBuildings = new Map<number, BuildingSnap>();
  private previousHp = new Map<number, number>();
  private previousTechs = new Set<string>();
  private knownEnemies = new Set<number>();
  private initialized = false;
  private lastAttackAt = 0;
  private lastEnemyAt = 0;
  private seenEnemyIds: number[] = [];
  private active = new Map<string, ActiveAnnouncementCondition>();
  private latched = new Set<string>();
  private queue: GameAnnouncement[] = [];
  private reported = new Map<string, GameAnnouncement>();
  private delivered = new Map<string, number>();
  private delivering = new Map<string, GameAnnouncement>();
  private analysisStates = new Map<string, string>();
  private lastCategory = new Map<AnnouncementCategory, number>();
  private history: Array<{ category: AnnouncementCategory; summary: string; at: number }> = [];
  private listeners = new Set<(event: SemanticGameEvent) => void>();
  private wake: (() => void) | undefined;
  private closed = false;
  private busy = false;
  private connected = false;
  private lastActiveSignature = '';
  private offPreferences: () => void;
  private offSuggestions: () => void;
  private lastScan = 0;
  private lastReview = 0;
  private idleMilitarySince = 0;
  private shortage: { label: string; until: number } | undefined;
  private allowed = new Map<AnnouncementCategory, boolean>();
  constructor(private state: GameState, private interaction: () => GameInteraction, private decide: () => Decide | undefined, private trace: GameTrace, private onSuggestion?: (suggestion: { id: string; command: string; expiresAt: number }) => void) {
    this.offPreferences = announcementPreferences.subscribe(() => { this.scan(true); this.prune(); this.wake?.(); });
    this.offSuggestions = suggestionPreferences.subscribe(() => { this.latched.delete('strategy-suggestion'); this.scan(true); this.prune(); this.wake?.(); });
  }
  subscribe(listener: (event: SemanticGameEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setVoiceState(connected: boolean, busy: boolean) {
    if (connected === this.connected && busy === this.busy) return;
    const justConnected = connected && !this.connected;
    this.connected = connected; this.busy = busy;
    if (!connected) { this.queue = []; this.reported.clear(); this.delivering.clear(); this.analysisStates.clear(); }
    if (justConnected) { this.latched.clear(); this.scan(true); }
    this.wake?.();
  }
  resourceBlocked(label: string) { this.shortage = { label, until: Date.now() + 15000 }; this.scan(true); }
  private suppress(candidate: GameAnnouncement, reason: SuppressionReason) { this.trace('tool', 'game.notification.suppressed', { id: candidate.id, category: candidate.category, suppressed_reason: reason }); }
  private emit(category: AnnouncementCategory, type: SemanticGameEvent['type'], label: string, ids: number[], conditionId?: string, key?: string, proposedCommand?: string) {
    const now = Date.now();
    const event: SemanticGameEvent = { id: crypto.randomUUID(), category, type, at: now, tick: this.state.tick, entityIds: ids, label };
    for (const listener of this.listeners) listener(event);
    const priority = priorityOf(category);
    const candidate: GameAnnouncement = { id: event.id, category, priority, createdAt: now, expiresAt: now + (priority === 'urgent' ? 6000 : advisory.has(category) ? 20000 : conditionId ? 15000 : 60000), dedupeKey: key ?? conditionId ?? event.id, conditionId, factualSummary: label, source: 'deterministic', requiresRevalidation: !!conditionId, event, ...(proposedCommand ? { proposedCommand } : {}) };
    this.trace('tool', 'game.notification.candidate', { id: candidate.id, category, priority, source: candidate.source, entityIds: ids.slice(0, 8) });
    if (!this.connected) return;
    const reason = this.reason(candidate);
    if (reason) { this.suppress(candidate, reason); return; }
    const previous = this.queue.findIndex(c => c.dedupeKey === candidate.dedupeKey);
    if (previous >= 0) { this.suppress(this.queue[previous], 'superseded'); this.queue.splice(previous, 1); }
    this.queue.push(candidate);
    this.queue.sort((a, b) => rank[b.priority] - rank[a.priority] || a.createdAt - b.createdAt);
    if (this.queue.length > 16) this.suppress(this.queue.pop()!, 'superseded');
    this.wake?.();
  }
  private condition(id: string, category: AnnouncementCategory, label: string, truth: boolean, reset: boolean, type: SemanticGameEvent['type'], ids: number[] = [], detail?: string) {
    const old = this.active.get(id);
    if (truth) {
      this.active.set(id, { id, category, label, detail, activeSince: old?.activeSince ?? Date.now(), enabled: announcementPreferences.get()[category].enabled });
      const proposedCommand = category === 'strategySuggestion' ? detail : undefined;
      if (!this.latched.has(id)) { this.latched.add(id); this.emit(category, type, label, ids, id, undefined, proposedCommand); }
      else if (old && old.label !== label && (this.queue.some(c => c.conditionId === id) || [...this.reported.values()].some(c => c.conditionId === id))) {
        for (const [key, candidate] of this.reported) if (candidate.conditionId === id) { this.suppress(candidate, 'superseded'); this.reported.delete(key); this.analysisStates.delete(key); }
        this.emit(category, type, label, ids, id, undefined, proposedCommand);
      }
    } else this.active.delete(id);
    if (reset) { this.latched.delete(id); this.delivered.delete(id); }
  }
  private strategyProposal(): { label: string; command: string; ids: number[]; area: Exclude<SuggestionBias, 'balanced' | 'none'>; score: number } | undefined {
    const preferences = suggestionPreferences.get();
    if (!preferences.enabled) return undefined;
    const player = this.state.me();
    if (!player?.resources) return undefined;
    const resources = player.resources;
    const units = [...this.state.units.values()].filter(unit => unit.owner === this.state.you);
    const buildings = [...this.state.buildings.values()].filter(building => building.owner === this.state.you);
    const affordances = gameAffordances(this.state);
    const enabled = (id: string) => affordances.some(action => action.id === id && action.enabled);
    const queuedPopulation = buildings.flatMap(building => building.queue).reduce((sum, item) => sum + UNIT_DEFS[item.unit].pop, 0);
    const placementAvailable = (type: keyof typeof BUILDING_DEFS, origin: { x: number; y: number }) => {
      const size = BUILDING_DEFS[type].size;
      const baseX = Math.floor(origin.x - size / 2); const baseY = Math.floor(origin.y - size / 2);
      for (let dx = -9; dx <= 9; dx++) for (let dy = -9; dy <= 9; dy++) if (this.state.canPlace(type, baseX + dx, baseY + dy)) return true;
      return false;
    };
    const candidates: Array<{ label: string; command: string; ids: number[]; area: 'resources' | 'military' | 'technology'; score: number }> = [];
    const trainingCount = (type: UnitType, wanted: number): { count: number; producerId?: number } => {
      const producers = buildings.filter(building => building.progress >= 1 && BUILDING_DEFS[building.type].trains.includes(type) && building.queue.length < TRAIN_QUEUE_MAX);
      producers.sort((a, b) => a.queue.length - b.queue.length || a.id - b.id);
      const producer = producers[0];
      if (!producer || !enabled(`train:${type}`)) return { count: 0 };
      let count = Math.min(wanted, TRAIN_QUEUE_MAX - producer.queue.length, Math.floor((player.popCap - player.pop - queuedPopulation) / UNIT_DEFS[type].pop));
      for (const [resource, amount] of Object.entries(UNIT_DEFS[type].cost)) count = Math.min(count, Math.floor((resources[resource as ResourceType] ?? 0) / amount));
      return { count: Math.max(0, count), producerId: producer.id };
    };

    const villagers = units.filter(unit => unit.type === 'villager');
    const villagerTraining = trainingCount('villager', 5);
    if (villagerTraining.count > 0 && villagers.length < Math.max(12, player.age * 10)) {
      const count = villagerTraining.count;
      candidates.push({
        area: 'resources', score: 68 + Math.max(0, 12 - villagers.length) * 2,
        label: `Want me to train ${count} more villager${count === 1 ? '' : 's'}?`,
        command: `Train ${count} villagers.`, ids: villagerTraining.producerId ? [villagerTraining.producerId] : [],
      });
    }

    const interaction = this.interaction();
    const onScreenResources = new Set(interaction.onScreenResourceIds);
    const origin = interaction.selectedTile ?? interaction.pointer ?? interaction.camera;
    const visibleGold = [...this.state.nodes.values()].filter(node => node.type === 'gold_mine' && node.amount > 0 && onScreenResources.has(node.id));
    visibleGold.sort((a, b) => Math.hypot(a.tileX - origin.x, a.tileY - origin.y) - Math.hypot(b.tileX - origin.x, b.tileY - origin.y) || a.id - b.id);
    const goldWithoutCamp = visibleGold[0] && !buildings.some(building => building.type === 'mining_camp' && Math.hypot(building.tileX - visibleGold[0].tileX, building.tileY - visibleGold[0].tileY) <= 9) && placementAvailable('mining_camp', { x: visibleGold[0].tileX, y: visibleGold[0].tileY }) ? visibleGold[0] : undefined;
    if (goldWithoutCamp && enabled('build:mining_camp') && villagers.some(unit => unit.state === 'idle')) {
      candidates.push({ area: 'resources', score: (resources.gold < 250 ? 88 : 64), label: 'Want me to build a mining camp beside the visible gold?', command: 'Build a mining camp next to the visible gold.', ids: [goldWithoutCamp.id] });
    }
    const visibleTrees = [...this.state.nodes.values()].filter(node => node.type === 'tree' && node.amount > 0 && onScreenResources.has(node.id));
    visibleTrees.sort((a, b) => Math.hypot(a.tileX - origin.x, a.tileY - origin.y) - Math.hypot(b.tileX - origin.x, b.tileY - origin.y) || a.id - b.id);
    const treeWithoutCamp = visibleTrees[0] && !buildings.some(building => building.type === 'lumber_camp' && Math.hypot(building.tileX - visibleTrees[0].tileX, building.tileY - visibleTrees[0].tileY) <= 9) && placementAvailable('lumber_camp', { x: visibleTrees[0].tileX, y: visibleTrees[0].tileY }) ? visibleTrees[0] : undefined;
    if (treeWithoutCamp && enabled('build:lumber_camp') && villagers.some(unit => unit.state === 'idle') && resources.wood < 250) {
      candidates.push({ area: 'resources', score: 76, label: 'Want me to build a lumber camp beside the visible woodline?', command: 'Build a lumber camp next to the visible woodline.', ids: [treeWithoutCamp.id] });
    }

    const militaryUnits = units.filter(unit => !['villager', 'fishing_boat', 'transport'].includes(unit.type));
    for (const type of ['knight', 'archer', 'swordsman'] as UnitType[]) {
      const training = trainingCount(type, 3);
      if (training.count <= 0) continue;
      candidates.push({
        area: 'military', score: 62 + Math.max(0, player.age * 3 - militaryUnits.length) * 3,
        label: `Want me to train ${training.count} ${type.replaceAll('_', ' ')}${training.count === 1 ? '' : 's'}?`,
        command: `Train ${training.count} ${type.replaceAll('_', ' ')}${training.count === 1 ? '' : 's'}.`, ids: training.producerId ? [training.producerId] : [],
      });
      break;
    }
    const visibleBuildings = new Set(interaction.onScreenBuildingIds);
    const visibleTownCenter = buildings.find(building => building.type === 'town_center' && visibleBuildings.has(building.id));
    if (!buildings.some(building => building.type === 'barracks') && visibleTownCenter && placementAvailable('barracks', { x: visibleTownCenter.tileX + BUILDING_DEFS.town_center.size / 2, y: visibleTownCenter.tileY + BUILDING_DEFS.town_center.size / 2 }) && enabled('build:barracks') && villagers.some(unit => unit.state === 'idle')) {
      candidates.push({ area: 'military', score: 72, label: 'Want me to build a barracks near the visible town center?', command: 'Build a barracks near the visible town center.', ids: [] });
    }

    const advance = affordances.find(action => action.id === 'advanceAge' && action.enabled);
    if (advance) candidates.push({ area: 'technology', score: 92, label: `Want me to advance to Age ${player.age + 1}?`, command: 'Advance to the next age.', ids: [] });
    const research = affordances.find(action => action.category === 'research' && action.id.startsWith('research:') && action.enabled);
    if (research) {
      const techId = research.id.slice('research:'.length);
      const tech = TECH_DEFS.find(item => item.id === techId);
      candidates.push({ area: 'technology', score: 66, label: `Want me to research ${tech?.name ?? techId.replaceAll('_', ' ')}?`, command: `Research ${techId}.`, ids: [] });
    }

    const eligible = preferences.bias === 'resources' || preferences.bias === 'military' || preferences.bias === 'technology'
      ? candidates.filter(candidate => candidate.area === preferences.bias)
      : candidates;
    if (preferences.bias === 'balanced') {
      for (const candidate of eligible) {
        if (candidate.area === 'resources' && villagers.length < 12) candidate.score += 12;
        if (candidate.area === 'military' && militaryUnits.length < Math.max(2, player.age * 2)) candidate.score += 12;
        if (candidate.area === 'technology' && advance) candidate.score += 12;
      }
    }
    eligible.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
    return eligible[0];
  }
  scan(force = false) {
    if (this.closed || !this.state.hasSnapshot) return;
    const now = Date.now();
    if (!force && now - this.lastScan < 200) return;
    this.lastScan = now;
    const player = this.state.me();
    if (!player || player.defeated || this.interaction().ended) { this.active.clear(); this.publishActive(); this.prune(); return; }
    const prefs = announcementPreferences.get();
    // Re-arm suppressed conditions when a toggle or timed mute permits them
    // again, without repeating an episode already delivered to the player.
    for (const c of this.active.values()) {
      const allowed = announcementAllowed(c.category, priorityOf(c.category) === 'urgent');
      if (allowed && this.allowed.get(c.category) === false && !this.delivered.has(c.id)) this.latched.delete(c.id);
      this.allowed.set(c.category, allowed);
    }
    const units = [...this.state.units.values()].filter(u => u.owner === this.state.you);
    const buildings = [...this.state.buildings.values()].filter(b => b.owner === this.state.you);
    if (this.initialized) {
      for (const b of buildings) {
        const before = this.previousBuildings.get(b.id);
        if (before && before.progress < 1 && b.progress >= 1) this.emit('buildingComplete', 'building.completed', `${b.type.replaceAll('_', ' ')} #${b.id} is complete.`, [b.id], undefined, `building:${b.id}`);
      }
      for (const id of player.techs ?? []) if (!this.previousTechs.has(id)) this.emit('researchComplete', 'research.completed', `Research completed: ${id.replaceAll('_', ' ')}.`, [], undefined, `research:${id}`);
      for (const e of [...units, ...buildings]) if (e.hp < (this.previousHp.get(e.id) ?? e.hp)) this.lastAttackAt = now;
    }
    this.previousBuildings = new Map(buildings.map(b => [b.id, b]));
    this.previousHp = new Map([...units, ...buildings].map(e => [e.id, e.hp]));
    this.previousTechs = new Set(player.techs ?? []);
    const idle = units.filter(u => u.type === 'villager' && u.state === 'idle');
    this.condition('idle-villagers', 'idleVillagers', `${idle.length} idle villagers`, idle.length >= (prefs.idleVillagers.threshold ?? 2), idle.length === 0, 'economy.idle_villagers', idle.map(u => u.id));
    const remaining = player.popCap - player.pop;
    this.condition('population', 'population', `Population ${player.pop} / ${player.popCap}; ${remaining} slots remaining`, remaining <= (prefs.population.remainingSlotsThreshold ?? 2), remaining > (prefs.population.remainingSlotsThreshold ?? 2) + 2, 'population.changed');
    const advance = gameAffordances(this.state).find(a => a.id === 'advanceAge');
    this.condition('age-available', 'ageAvailable', `Age ${player.age + 1} is available`, !!advance?.enabled, !advance?.enabled, 'age.available');
    const underAttack = this.lastAttackAt > 0 && now - this.lastAttackAt < 5000;
    this.condition('under-attack', 'underAttack', 'Your units or buildings are taking damage', underAttack, !underAttack, 'combat.under_attack');
    const enemies = [...this.state.units.values()].filter(u => !this.state.alliedOwners.has(u.owner) && this.state.unitVisible(u));
    const newlyVisible = enemies.filter(u => !this.knownEnemies.has(u.id));
    if (newlyVisible.length) { this.lastEnemyAt = now; this.seenEnemyIds = newlyVisible.map(u => u.id); }
    this.knownEnemies = new Set(enemies.map(u => u.id));
    const approaching = this.seenEnemyIds.filter(id => this.knownEnemies.has(id));
    this.condition('enemy-spotted', 'enemySpotted', `${approaching.length} enemy units spotted`, approaching.length > 0 && now - this.lastEnemyAt < 12000, approaching.length === 0 || now - this.lastEnemyAt >= 12000, 'enemy.spotted', approaching);
    const military = units.filter(u => !['villager', 'fishing_boat', 'transport'].includes(u.type) && u.state === 'idle');
    if (military.length < 2) this.idleMilitarySince = 0;
    else if (!this.idleMilitarySince) this.idleMilitarySince = now;
    this.condition('military-idle', 'militaryIdle', `${military.length} military units are idle`, military.length >= 2 && now - this.idleMilitarySince >= 10000, military.length === 0, 'military.idle', military.map(u => u.id));
    const shortages = (['food', 'wood', 'gold', 'stone'] as ResourceType[]).filter(r => (player.resources?.[r] ?? 0) < 30);
    const shortageActive = this.shortage && this.shortage.until > now;
    this.condition('resource-shortage', 'resourceShortage', shortageActive ? this.shortage!.label : `Low resources: ${shortages.join(', ')}`, !!shortageActive || shortages.length > 0, !shortageActive && shortages.length === 0, 'resources.changed');
    const surplus = (['food', 'wood', 'gold', 'stone'] as ResourceType[]).filter(r => (player.resources?.[r] ?? 0) >= 1000);
    this.condition('resource-surplus', 'resourceSurplus', `High stockpile: ${surplus.join(', ')}`, surplus.length > 0, surplus.length === 0, 'resources.changed');
    const idleProduction = buildings.filter(b => b.progress >= 1 && BUILDING_DEFS[b.type].trains.length && !b.queue.length);
    const readyUnits = gameAffordances(this.state).filter(a => a.category === 'train' && a.enabled);
    this.condition('production-advice', 'productionAdvice', `${idleProduction.length} production buildings have empty queues`, idleProduction.length > 0 && readyUnits.length > 0, idleProduction.length === 0 || readyUnits.length === 0, 'strategy.review', idleProduction.map(b => b.id));
    const gatherers = units.filter(u => u.type === 'villager' && u.targetId !== undefined && ['gathering', 'movingToGather', 'returning'].includes(u.state));
    const counts: Partial<Record<ResourceType, number>> = {};
    for (const u of gatherers) { const node = this.state.nodes.get(u.targetId!); const resource = node ? NODE_DEFS[node.type].resource : u.carryType; if (resource) counts[resource] = (counts[resource] ?? 0) + 1; }
    const imbalance = Object.entries(counts).find(([resource, count]) => count >= 4 && count / Math.max(1, gatherers.length) >= 0.75 && (player.resources?.[resource as ResourceType] ?? 0) >= 500);
    this.condition('economy-advice', 'economyAdvice', imbalance ? `Most gatherers are on ${imbalance[0]} with a growing stockpile` : 'Economy balance', !!imbalance, !imbalance, 'strategy.review');
    const strategic = !advance?.enabled && remaining > 2 && (surplus.length > 0 || idleProduction.length > 1);
    this.condition('strategic-opportunity', 'strategicOpportunities', 'A spending or production opportunity may be available', strategic, !strategic, 'strategy.review');
    const suggestion = this.strategyProposal();
    this.condition('strategy-suggestion', 'strategySuggestion', suggestion?.label ?? '', !!suggestion, !suggestion, 'strategy.review', suggestion?.ids, suggestion?.command);
    // Persistent advisory conditions may be reconsidered at the player's chosen
    // frequency; state warnings retain hysteresis until the condition clears.
    if (this.initialized && now - this.lastReview >= 15000) {
      this.lastReview = now;
      for (const c of this.active.values()) if (advisory.has(c.category)) this.emit(c.category, 'strategy.review', c.label, [], c.id, undefined, c.category === 'strategySuggestion' ? c.detail : undefined);
    }
    this.initialized = true;
    this.publishActive(); this.prune();
  }
  private publishActive() {
    const values = [...this.active.values()]; const signature = JSON.stringify(values);
    if (signature !== this.lastActiveSignature) { this.lastActiveSignature = signature; activeAnnouncements.set(values); }
  }
  private reason(candidate: GameAnnouncement): SuppressionReason | undefined {
    const prefs = announcementPreferences.get();
    if (strategyAdvisory.has(candidate.category) && !suggestionPreferences.get().enabled) return 'disabled';
    if (!prefs[candidate.category].enabled) return 'disabled';
    if (!announcementAllowed(candidate.category, candidate.priority === 'urgent')) return 'muted';
    if (candidate.expiresAt <= Date.now()) return 'expired';
    if (this.interaction().ended || this.state.me()?.defeated || candidate.conditionId && !this.active.has(candidate.conditionId)) return 'condition_cleared';
    if (this.delivered.has(candidate.dedupeKey) && !advisory.has(candidate.category)) return 'duplicate';
    const frequency = prefs[candidate.category].frequency;
    const cooldown = (cooldowns[candidate.category] ?? 0) * (frequency === 'high' ? 0.5 : frequency === 'low' ? 2 : 1);
    if (Date.now() - (this.lastCategory.get(candidate.category) ?? 0) < cooldown) return 'cooldown';
    return undefined;
  }
  private prune() {
    this.queue = this.queue.filter(c => { const reason = this.reason(c); if (reason) this.suppress(c, reason); return !reason; });
    for (const [id, candidate] of this.reported) {
      const reason = this.reason(candidate);
      if (reason) { this.suppress(candidate, reason === 'expired' ? 'coordinator_silent' : reason); this.reported.delete(id); }
      if (!this.reported.has(id)) this.analysisStates.delete(id);
    }
    // Dedupe a state only while its episode is active. Completion keys are kept
    // bounded separately and never re-emitted by the semantic transition source.
    for (const [key, at] of this.delivered) if ((!this.active.has(key) && Date.now() - at > 60000) || this.delivered.size > 256) this.delivered.delete(key);
  }
  async next(signal: AbortSignal): Promise<unknown> {
    this.scan(true); this.prune();
    if (this.closed || signal.aborted) return { closed: false };
    if (!this.queue.length || this.busy || !this.connected || this.interaction().paused) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); if (this.wake === finish) this.wake = undefined; resolve(); };
        const timer = window.setTimeout(finish, 15000);
        this.wake?.(); this.wake = finish;
        signal.addEventListener('abort', finish, { once: true });
      });
    }
    this.scan(true); this.prune();
    if (this.closed || signal.aborted || !this.connected || this.interaction().paused) return { closed: false };
    const candidate = this.queue[0];
    if (!candidate) return { closed: false };
    if (this.busy) { this.suppress(candidate, 'conversation_busy'); return { closed: false }; }
    this.queue.shift();
    if (advisory.has(candidate.category) || candidate.category === 'resourceShortage' || candidate.category === 'militaryIdle') {
      const decide = this.decide();
      if (!decide) { this.suppress(candidate, 'low_relevance'); return { closed: false }; }
      try {
        const answer = await decide('Evaluate this possible game announcement without executing any game action.', { candidate, game: gameVoiceContext(this.state, this.interaction()), preferences: announcementPreferences.get(), suggestionPreferences: suggestionPreferences.get(), recentAnnouncements: this.history.slice(-8), conversationBusy: this.busy }, {
          relevance: choice('Is this current, useful, actionable and not repetitive enough to report? For a strategy suggestion, it must be legal, fit the selected bias, and remain an optional question. Quiet is the default.', { announce: 'Useful and timely; report this candidate', silent: 'Low relevance, repetitive or not actionable; stay silent' }),
        }, signal);
        if (answer.relevance?.choice !== 'announce' || answer.relevance.confidence < 0.7) { this.suppress(candidate, 'low_relevance'); return { closed: false }; }
        candidate.source = 'decision_model';
      } catch { this.suppress(candidate, 'low_relevance'); return { closed: false }; }
    }
    const reason = this.reason(candidate); if (reason) { this.suppress(candidate, reason); return { closed: false }; }
    this.reported.set(candidate.id, candidate);
    if (advisory.has(candidate.category)) this.analysisStates.set(candidate.id, this.analysisState());
    while (this.reported.size > 32) { const id = this.reported.keys().next().value!; this.reported.delete(id); this.analysisStates.delete(id); }
    return { candidate, needsAnalysis: advisory.has(candidate.category), context: gameVoiceContext(this.state, this.interaction()), preferences: announcementPreferences.get(), suggestionPreferences: suggestionPreferences.get(), recentAnnouncements: this.history.slice(-8), conversationBusy: this.busy };
  }
  validate(value: unknown, analysis: unknown, phase: unknown): unknown {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return { valid: false };
    this.scan(true);
    const candidate = phase === 'delivered' ? this.delivering.get(value.id) : this.reported.get(value.id);
    if (!candidate || this.closed || !this.connected || this.interaction().paused) return { valid: false };
    if (phase === 'delivered') {
      this.delivered.set(candidate.dedupeKey, Date.now()); this.lastCategory.set(candidate.category, Date.now());
      this.history.push({ category: candidate.category, summary: candidate.factualSummary, at: Date.now() }); this.history = this.history.slice(-32);
      this.reported.delete(candidate.id); this.delivering.delete(candidate.id);
      this.trace('output', 'game.notification.delivered', { id: candidate.id, category: candidate.category, delivered: true, latency_ms: Date.now() - candidate.createdAt });
      return { valid: true };
    }
    const reason = this.reason(candidate);
    if (reason) { this.suppress(candidate, reason); this.reported.delete(candidate.id); return { valid: false, reason }; }
    if (advisory.has(candidate.category) && this.analysisStates.get(candidate.id) !== this.analysisState()) { this.suppress(candidate, 'superseded'); this.reported.delete(candidate.id); this.analysisStates.delete(candidate.id); return { valid: false, reason: 'superseded' }; }
    if (phase === 'report' && advisory.has(candidate.category)) {
      if (typeof analysis !== 'string' || !analysis.trim() || analysis.length > 2000 || analysis.trim() === 'SILENT') return { valid: false };
      candidate.conversationalHint = analysis.trim(); candidate.source = 'background_llm';
    }
    // Numeric state must still match the fact that was offered, not merely stay
    // above threshold. A changed fact is superseded instead of read out stale.
    if (candidate.conditionId && this.active.get(candidate.conditionId)?.label !== candidate.factualSummary) {
      this.suppress(candidate, 'superseded'); this.reported.delete(candidate.id); return { valid: false, reason: 'superseded' };
    }
    this.trace('tool', 'game.notification.revalidated', { id: candidate.id, category: candidate.category, phase, revalidated: true });
    if (phase === 'delivery') { this.delivering.set(candidate.id, candidate); while (this.delivering.size > 16) this.delivering.delete(this.delivering.keys().next().value!); }
    if (phase === 'delivery' && candidate.proposedCommand) this.onSuggestion?.({ id: candidate.id, command: candidate.proposedCommand, expiresAt: Date.now() + 60_000 });
    return { valid: true, candidate };
  }
  private analysisState(): string {
    const player = this.state.me();
    return JSON.stringify({ age: player?.age, ageProgress: player?.ageProgress !== undefined, pop: player?.pop, cap: player?.popCap, techs: player?.techs, resources: Object.entries(player?.resources ?? {}).map(([r, n]) => [r, Math.floor(n / 50)]), affordable: gameAffordances(this.state).filter(a => a.enabled).map(a => a.id), assignments: [...this.state.units.values()].filter(u => u.owner === this.state.you).map(u => [u.id, u.targetId, u.state === 'idle']), queues: [...this.state.buildings.values()].filter(b => b.owner === this.state.you).map(b => [b.id, b.queue.length, b.research?.id]) });
  }
  dispose() { this.closed = true; this.offPreferences(); this.offSuggestions(); this.wake?.(); this.queue = []; this.reported.clear(); this.listeners.clear(); activeAnnouncements.set([]); }
}
