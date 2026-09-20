import { AGE_COSTS, BUILDING_DEFS, MAX_AGE, POP_CAP_MAX, TECH_DEFS, TRAIN_QUEUE_MAX, UNIT_AGE_REQ, UNIT_DEFS, buildingsToAdvance, countsForAgeUp, tradeBuyCost, TRADE_LOT, type BuildingType, type Resources, type UnitType } from '@age/shared';
import type { GameState } from '../state';

export interface Point { x: number; y: number }
export interface GameAffordance {
  id: string; label: string; category: string; enabled: boolean; cost?: Partial<Resources>; reasonUnavailable?: string;
}
export interface GameInteraction { pointer?: Point; camera: Point; paused: boolean; ended: boolean; connected: boolean }
export const affordable = (resources: Resources | undefined, cost: Partial<Resources>) => !!resources && Object.entries(cost).every(([r, n]) => resources[r as keyof Resources] >= n);

export function gameAffordances(state: GameState): GameAffordance[] {
  const player = state.me();
  if (!player || player.defeated) return [];
  const buildings = [...state.buildings.values()].filter(b => b.owner === state.you);
  const complete = buildings.filter(b => b.progress >= 1);
  const has = (type: BuildingType) => complete.some(b => b.type === type);
  const canPay = (cost: Partial<Resources>) => affordable(player.resources, cost);
  const result: GameAffordance[] = [];
  const add = (id: string, label: string, category: string, cost: Partial<Resources>, reason?: string) => result.push({ id, label, category, cost, enabled: !reason, ...(reason ? { reasonUnavailable: reason } : {}) });
  for (const [type, def] of Object.entries(BUILDING_DEFS) as [BuildingType, typeof BUILDING_DEFS[BuildingType]][]) {
    const reason = player.age < def.ageReq ? `Requires age ${def.ageReq}` : def.requires && !has(def.requires) ? `Requires a completed ${def.requires}` : ![...state.units.values()].some(u => u.owner === state.you && u.type === 'villager') ? 'No builders' : type === 'house' && buildings.reduce((n, b) => n + BUILDING_DEFS[b.type].popProvided, 0) >= POP_CAP_MAX ? 'Population housing limit reached' : !canPay(def.cost) ? 'Insufficient resources' : undefined;
    add(`build:${type}`, `Build ${type}`, 'build', def.cost, reason);
  }
  for (const [type, def] of Object.entries(UNIT_DEFS) as [UnitType, typeof UNIT_DEFS[UnitType]][]) {
    const producers = complete.filter(b => BUILDING_DEFS[b.type].trains.includes(type));
    add(`train:${type}`, `Train ${type}`, 'train', def.cost, player.age < UNIT_AGE_REQ[type] ? `Requires age ${UNIT_AGE_REQ[type]}` : !producers.length ? 'No completed production building' : producers.every(b => b.queue.length >= TRAIN_QUEUE_MAX) ? 'Production queues are full' : !canPay(def.cost) ? 'Insufficient resources' : undefined);
  }
  for (const tech of TECH_DEFS) {
    add(`research:${tech.id}`, `${tech.id} (${tech.name})`, 'research', tech.cost, player.techs?.includes(tech.id) ? 'Already researched' : player.age < tech.ageReq ? `Requires age ${tech.ageReq}` : tech.prereq && !player.techs?.includes(tech.prereq) ? `Requires ${tech.prereq}` : !has(tech.building) ? `Requires ${tech.building}` : complete.filter(b => b.type === tech.building).every(b => b.research) ? 'Building is researching' : !canPay(tech.cost) ? 'Insufficient resources' : undefined);
  }
  const ageCost = AGE_COSTS[player.age + 1] ?? {};
  const ageBuildings = new Set(complete.filter(b => countsForAgeUp(b.type, player.age)).map(b => b.type));
  add('advanceAge', `Advance to age ${player.age + 1}`, 'research', ageCost, player.age >= MAX_AGE ? 'Already in the final age' : player.ageProgress !== undefined ? 'Age research already underway' : !has('town_center') ? 'Requires town center' : ageBuildings.size < buildingsToAdvance(player.age) ? `Requires ${buildingsToAdvance(player.age)} distinct current-age building types (${ageBuildings.size} ready)` : !canPay(ageCost) ? 'Insufficient resources' : undefined);
  for (const resource of ['food', 'wood', 'stone'] as const) {
    add(`buy:${resource}`, `Buy ${TRADE_LOT} ${resource}`, 'economy', { gold: tradeBuyCost(state.marketPrices[resource]) }, !has('market') ? 'Requires completed market' : !canPay({ gold: tradeBuyCost(state.marketPrices[resource]) }) ? 'Insufficient gold' : undefined);
    add(`sell:${resource}`, `Sell ${TRADE_LOT} ${resource}`, 'economy', { [resource]: TRADE_LOT }, !has('market') ? 'Requires completed market' : !canPay({ [resource]: TRADE_LOT }) ? 'Insufficient resources' : undefined);
  }
  return result;
}

export function visibleBuildings(state: GameState) {
  return [...state.buildings.values()].filter(b => state.alliedOwners.has(b.owner) || state.fog.isVisible(Math.floor(b.tileX + BUILDING_DEFS[b.type].size / 2), Math.floor(b.tileY + BUILDING_DEFS[b.type].size / 2)));
}

/** Never forwards other players' resource/technology snapshots or remembered enemy HP. */
export function gameVoiceContext(state: GameState, interaction: GameInteraction) {
  const player = state.me();
  const ownUnits = [...state.units.values()].filter(u => u.owner === state.you);
  const ownBuildings = [...state.buildings.values()].filter(b => b.owner === state.you);
  const home = ownBuildings.find(b => b.type === 'town_center');
  const origin = interaction.pointer ?? (home ? { x: home.tileX, y: home.tileY } : interaction.camera);
  const nodes = [...state.nodes.values()].filter(n => state.nodeVisible(n)).sort((a, b) => Math.hypot(a.tileX - origin.x, a.tileY - origin.y) - Math.hypot(b.tileX - origin.x, b.tileY - origin.y));
  const nearby = ['tree', 'berry_bush', 'gold_mine', 'stone_mine', 'fish'].flatMap(type => nodes.filter(n => n.type === type).slice(0, 3));
  return {
    tick: state.tick, playerId: state.you,
    phase: interaction.ended ? 'ended' : interaction.paused ? 'paused' : !interaction.connected ? 'disconnected' : !state.hasSnapshot ? 'loading' : player?.defeated ? 'defeated' : !player ? 'spectating' : 'playing',
    player: player ? { age: player.age, ageProgress: player.ageProgress, resources: player.resources, population: { current: player.pop, capacity: player.popCap }, techs: player.techs ?? [] } : null,
    selection: [...state.selection].filter(id => ownUnits.some(u => u.id === id) || visibleBuildings(state).some(b => b.id === id) || [...state.units.values()].some(u => u.id === id && state.unitVisible(u))),
    pointer: interaction.pointer, camera: interaction.camera,
    units: ownUnits.map(u => ({ id: u.id, type: u.type, state: u.state, x: Math.round(u.x), y: Math.round(u.y), targetId: u.targetId })),
    buildings: ownBuildings.map(b => ({ id: b.id, type: b.type, x: b.tileX, y: b.tileY, progress: b.progress, queue: b.queue, research: b.research })),
    idleVillagerIds: ownUnits.filter(u => u.type === 'villager' && u.state === 'idle').map(u => u.id),
    visibleEnemies: [...state.units.values()].filter(u => !state.alliedOwners.has(u.owner) && state.unitVisible(u)).map(u => ({ id: u.id, type: u.type, x: Math.round(u.x), y: Math.round(u.y) })).slice(0, 20),
    nearbyResources: nearby.map(n => ({ id: n.id, type: n.type, x: n.tileX, y: n.tileY, amount: n.amount })),
    availableActions: gameAffordances(state),
  };
}
