import { BUILDING_DEFS, GARRISON_CAP, NODE_DEFS, TECH_DEFS, TRAIN_QUEUE_MAX, UNIT_DEFS, isNavalUnit, type BuildingSnap, type BuildingType, type GameCommand, type ResourceType, type UnitSnap, type UnitType } from '@age/shared';
import type { GameState } from '../state';
import { gameAffordances, gameVoiceContext, visibleBuildings, type GameInteraction, type Point } from './voice-context';
import { choice, ClarificationNeeded, confidenceThreshold, required, type Decide, type DecisionQuestion, type GameTrace } from './voice-decision';

export interface GameConversationContext {
  lastCommand?: GameCommand; lastUnitIds: number[]; lastBuildingId?: number; lastLocation?: Point;
  pendingClarification?: { utterance: string; question: string; at: number };
}
export interface PlannedOrder { command: GameCommand; summary: string }
const labels = (values: string[]) => Object.fromEntries(values.map(value => [value, value.replaceAll('_', ' ')]));
const references = { selected: 'Currently selected own units', idle: 'Idle own units', previous: 'Units referred to by the last successful command', automatic: 'No worker was specified; automatically choose an available idle worker', all: 'All own units of the requested type', explicit: 'One explicitly named unit ID' };
const locations = { pointer: 'Here/there at the current unobstructed pointer tile', previous: 'Last successfully referenced location', town_center: 'Near own town center', berries: 'Near a visible berry bush', woodline: 'Near a visible tree', selected_object: 'At/near the selected object', explicit: 'Exact numeric map coordinates stated by the player' };
const explicitEnum = <T extends string>(utterance: string, values: readonly T[]): T | undefined =>
  values.find(value => new RegExp(`\\b${value.replaceAll('_', '[ _-]+')}\\b`, 'i').test(utterance));
const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const spokenNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : numberWords[value.toLowerCase()];
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : undefined;
};
const workerOrdinal = (utterance: string): number | undefined => {
  const match = utterance.match(/\b(?:worker|villager|builder)\s+(?:number\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d{1,2})\b/i);
  return spokenNumber(match?.[1]);
};
const explicitTrainIntent = (utterance: string): boolean =>
  /\b(?:create|make|produce|train|queue)\b[^.!?;]{0,80}\b(?:villagers?|workers?|swordsmen|archers?|knights?|fishing\s+boats?|war\s+galleys|transports?)\b/i.test(utterance);
const explicitMultiAction = (utterance: string): boolean =>
  /(?:,|;|\b(?:and\s+then|then|and)\b)\s*(?:assign|send|put|move|build|construct|create|make|produce|train|queue|research|attack|repair|stop|garrison|unload|buy|sell|cancel|delete)\b/i.test(utterance);
const explicitTrainUnit = (utterance: string): UnitType | undefined => {
  if (/\b(?:villagers?|workers?)\b/i.test(utterance)) return 'villager';
  if (/\bswordsmen\b|\bswordsman\b/i.test(utterance)) return 'swordsman';
  if (/\barchers?\b/i.test(utterance)) return 'archer';
  if (/\bknights?\b/i.test(utterance)) return 'knight';
  if (/\bfishing\s+boats?\b/i.test(utterance)) return 'fishing_boat';
  if (/\bwar\s+galleys\b|\bwar\s+galley\b/i.test(utterance)) return 'war_galley';
  if (/\btransports?\b/i.test(utterance)) return 'transport';
  return undefined;
};
const explicitTrainQuantity = (utterance: string): number | undefined => {
  const words = Object.keys(numberWords).join('|');
  const match = utterance.match(new RegExp(`\\b(?:create|make|produce|train|queue)\\s+(?:another\\s+)?(?:the\\s+)?(${words}|\\d{1,2})\\b`, 'i'));
  if (match) return spokenNumber(match[1]);
  return /\b(?:an?|one|another)\s+(?:more\s+)?(?:villager|worker|swordsman|archer|knight|fishing\s+boat|war\s+galley|transport)\b/i.test(utterance) ? 1 : undefined;
};
const explicitGatherResource = (utterance: string): ResourceType | undefined => {
  if (/\b(?:wood|trees?|woodline)\b/i.test(utterance)) return 'wood';
  if (/\bgold\b/i.test(utterance)) return 'gold';
  if (/\bstone\b/i.test(utterance)) return 'stone';
  if (/\b(?:food|berries|berry|sheep|farm|fish)\b/i.test(utterance)) return 'food';
  return undefined;
};
const explicitGatherTarget = (utterance: string): string | undefined => {
  if (/\b(?:berries|berry)\b/i.test(utterance)) return 'berries';
  if (/\bsheep\b/i.test(utterance)) return 'sheep';
  if (/\bfarm\b/i.test(utterance)) return 'farm';
  if (/\bfish\b/i.test(utterance)) return 'fish';
  if (/\bselected\s+(?:resource|tree|mine|bush|farm|fish)\b/i.test(utterance)) return 'selected';
  if (/\b(?:this|that)\s+(?:resource|tree|mine|bush|farm|fish)\b|\bhere\b/i.test(utterance)) return 'pointer';
  if (/\b(?:same|previous)\s+(?:resource|source|one)\b/i.test(utterance)) return 'previous';
  return explicitGatherResource(utterance) ? 'nearest' : undefined;
};
const explicitGatherIntent = (utterance: string): boolean =>
  explicitGatherResource(utterance) !== undefined && (
    /\b(?:assign|send|put|gather|collect)\b/i.test(utterance) ||
    /\b(?:an?|one)\s+idle\s+(?:villager|worker|builder)\b/i.test(utterance) ||
    workerOrdinal(utterance) !== undefined
  );
const explicitLocation = (utterance: string): keyof typeof locations | undefined => {
  if (/\btown[ _-]?cent(?:er|re)\b/i.test(utterance)) return 'town_center';
  if (/\b(?:wood[ _-]?line|trees?)\b/i.test(utterance)) return 'woodline';
  if (/\b(?:berries|berry(?:\s+bush(?:es)?)?)\b/i.test(utterance)) return 'berries';
  if (/\bselected\s+(?:object|building|unit)\b/i.test(utterance)) return 'selected_object';
  if (/\b(?:here|there)\b/i.test(utterance)) return 'pointer';
  if (/(?:at|tile|coordinates?|x\s*[:=]?)\s*\(?\s*\d+(?:\.\d+)?\s*[, /]\s*(?:y\s*[:=]?\s*)?\d+(?:\.\d+)?/i.test(utterance)) return 'explicit';
  return undefined;
};

export class GamePlanner {
  readonly conversation: GameConversationContext = { lastUnitIds: [] };
  constructor(private state: GameState, private interaction: () => GameInteraction, private decide: () => Decide | undefined, private trace: GameTrace) {}

  context() { return { game: gameVoiceContext(this.state, this.interaction()), conversation: this.conversation }; }
  assertPlayable() {
    const phase = gameVoiceContext(this.state, this.interaction()).phase;
    if (phase !== 'playing') throw new Error(`Game commands are unavailable while ${phase}.`);
  }
  private async ask(utterance: string, questions: Record<string, DecisionQuestion>, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Voice command cancelled.');
    const decide = this.decide();
    if (!decide) throw new Error('Vowel is disconnected. No game command was sent.');
    const referenceState = () => JSON.stringify({ selection: [...this.state.selection].sort((a, b) => a - b), pointer: this.interaction().pointer });
    const before = referenceState();
    const result = await decide(utterance, this.context(), questions, signal);
    if (signal.aborted) throw new Error('Voice command cancelled.');
    if (before !== referenceState()) throw new ClarificationNeeded('Your selection or map pointer changed while I interpreted that. Please repeat the order with the intended selection and location.');
    return result;
  }
  private ownedUnits() { return [...this.state.units.values()].filter(u => u.owner === this.state.you); }
  private ownBuildings() { return [...this.state.buildings.values()].filter(b => b.owner === this.state.you); }
  private chooseUnits(reference: string, kind: string, quantity: string, utterance: string, reserved: Set<number>): number[] {
    let units = this.ownedUnits();
    if (kind !== 'any') units = units.filter(u => kind === 'military' ? !['villager', 'fishing_boat', 'transport'].includes(u.type) : u.type === kind);
    if (reference === 'selected') units = units.filter(u => this.state.selection.has(u.id));
    else if (reference === 'idle' || reference === 'automatic') units = units.filter(u => u.state === 'idle' && !reserved.has(u.id));
    else if (reference === 'previous') units = units.filter(u => this.conversation.lastUnitIds.includes(u.id));
    else if (reference === 'explicit') {
      const ordinal = workerOrdinal(utterance);
      if (ordinal !== undefined && kind === 'villager') {
        units.sort((a, b) => a.id - b.id);
        units = units[ordinal - 1] ? [units[ordinal - 1]!] : [];
      } else units = units.filter(u => new RegExp(`(?:#|\\bid\\s*)${u.id}\\b`, 'i').test(utterance));
      if (units.length !== 1) throw new ClarificationNeeded('Which unit ID should I use?');
    } else if (reference !== 'all') throw new ClarificationNeeded('Which units should receive that order?');
    const count = quantity === 'all' ? units.length : Number(quantity);
    if (!count || !Number.isInteger(count) || count > units.length) throw new ClarificationNeeded(`I found ${units.length} eligible units. Which units should I use?`);
    // Stable selection nearest the target origin instead of depending on map iteration order.
    const origin = this.interaction().pointer ?? this.interaction().camera;
    units.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y) || a.id - b.id);
    return units.slice(0, count).map(u => u.id);
  }
  private position(reference: string, utterance: string): Point {
    const state = this.state;
    let position: Point | undefined;
    if (reference === 'pointer') position = this.interaction().pointer;
    else if (reference === 'previous') position = this.conversation.lastLocation;
    else if (reference === 'town_center') {
      const homes = this.ownBuildings().filter(b => b.type === 'town_center');
      const home = homes.find(b => state.selection.has(b.id)) ?? (homes.length === 1 ? homes[0] : undefined);
      if (home) position = { x: home.tileX + BUILDING_DEFS.town_center.size / 2, y: home.tileY + BUILDING_DEFS.town_center.size / 2 };
    } else if (reference === 'selected_object') {
      if (state.selection.size !== 1) throw new ClarificationNeeded('Select one object to use as the location.');
      const id = [...state.selection][0]; const entity = state.units.get(id) ?? state.buildings.get(id) ?? state.nodes.get(id) ?? state.sheep.get(id);
      if (entity) position = 'x' in entity ? { x: entity.x, y: entity.y } : { x: entity.tileX, y: entity.tileY };
    } else if (reference === 'berries' || reference === 'woodline') {
      const origin = this.interaction().pointer ?? this.interaction().camera;
      const nodes = [...state.nodes.values()].filter(n => state.nodeVisible(n) && n.amount > 0 && n.type === (reference === 'berries' ? 'berry_bush' : 'tree'));
      nodes.sort((a, b) => Math.hypot(a.tileX - origin.x, a.tileY - origin.y) - Math.hypot(b.tileX - origin.x, b.tileY - origin.y));
      if (nodes[0]) position = { x: nodes[0].tileX, y: nodes[0].tileY };
    } else if (reference === 'explicit') {
      const match = utterance.match(/(?:at|tile|coordinates?|x\s*[:=]?)\s*\(?\s*(\d+(?:\.\d+)?)\s*[, /]\s*(?:y\s*[:=]?\s*)?(\d+(?:\.\d+)?)/i);
      if (match) position = { x: Number(match[1]), y: Number(match[2]) };
    }
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || position.x < 0 || position.y < 0 || position.x >= state.map.size || position.y >= state.map.size) throw new ClarificationNeeded('Where should that happen? Point at a map tile, select one object, or give map coordinates.');
    return { ...position };
  }
  private placement(type: BuildingType, reference: string, utterance: string): Point {
    const origin = this.position(reference, utterance);
    const size = BUILDING_DEFS[type].size;
    const exact = reference === 'pointer' || reference === 'explicit';
    const x = Math.floor(origin.x - (exact ? 0 : size / 2)); const y = Math.floor(origin.y - (exact ? 0 : size / 2));
    const candidates: Point[] = [];
    const radius = exact ? 0 : 9;
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      if (this.state.canPlace(type, x + dx, y + dy)) candidates.push({ x: x + dx, y: y + dy });
    }
    candidates.sort((a, b) => Math.hypot(a.x + size / 2 - origin.x, a.y + size / 2 - origin.y) - Math.hypot(b.x + size / 2 - origin.x, b.y + size / 2 - origin.y) || a.x - b.x || a.y - b.y);
    if (!candidates[0]) throw new ClarificationNeeded(`There is no legal ${type.replaceAll('_', ' ')} placement ${exact ? 'on that tile' : 'near that location'}. Choose another location.`);
    return candidates[0];
  }
  private available(id: string) {
    const affordance = gameAffordances(this.state).find(a => a.id === id);
    if (!affordance?.enabled) throw new Error(affordance?.reasonUnavailable ?? 'That action is unavailable.');
  }
  private producer(type: UnitType): BuildingSnap {
    const buildings = this.ownBuildings().filter(b => b.progress >= 1 && BUILDING_DEFS[b.type].trains.includes(type) && b.queue.length < TRAIN_QUEUE_MAX);
    buildings.sort((a, b) => Number(this.state.selection.has(b.id)) - Number(this.state.selection.has(a.id)) || a.queue.length - b.queue.length || a.id - b.id);
    if (!buildings[0]) throw new Error(`No available building can train ${type}.`);
    return buildings[0];
  }
  async plan(utterance: string, signal: AbortSignal, reserved = new Set<number>(), nested = false): Promise<PlannedOrder[]> {
    this.assertPlayable();
    const classification = await this.ask(utterance, { family: choice('Classify the requested game action. Conversation, questions and advice must be none, not actions.', {
      gather: 'Assign resource gathering', build: 'Construct a building', move: 'Move units or set a rally point', train: 'Train units', research: 'Research technology or advance age', combat: 'Attack, repair, stop, garrison or unload', economy: 'Buy/sell at the market, cancel production or explicitly delete own objects', multi_action: 'Two or more distinct orders', none: 'Question, discussion, advice or no order',
    }) }, signal);
    const family = explicitMultiAction(utterance)
      ? 'multi_action'
      : explicitTrainIntent(utterance)
        ? 'train'
        : explicitGatherIntent(utterance)
          ? 'gather'
          : required(classification, 'family', 'What game action would you like me to take?');
    if (family === 'none') throw new ClarificationNeeded('That sounds like a question or discussion. I can query the game without changing it.');
    if (family === 'multi_action') {
      if (nested) throw new ClarificationNeeded('Please give those orders one at a time.');
      const clauses = utterance.split(/\s*(?:;|,\s*(?=[a-z])|\band then\b|\bthen\b|\band\b)\s*/i).filter(Boolean);
      if (clauses.length < 2 || clauses.length > 5) throw new ClarificationNeeded('Please split that into up to five explicit orders.');
      const plan: PlannedOrder[] = [];
      for (const clause of clauses) {
        const orders = await this.plan(clause, signal, reserved, true);
        for (const order of orders) if ('unitIds' in order.command) for (const id of order.command.unitIds) reserved.add(id);
        plan.push(...orders);
      }
      return plan;
    }
    const unitQuestions = (worker = false): Record<string, DecisionQuestion> => ({
      units: choice('Which own units does the player refer to? For a gather or build order with no worker reference, choose automatic. Never steal busy workers implicitly.', references),
      quantity: choice('How many units? Select all only when all or an entire selected/previous group is intended. For a delegated builder with no count use 1.', { ...labels(Array.from({ length: 20 }, (_, i) => String(i + 1))), all: 'The whole referenced group' }),
      unitType: choice('What type of units? Use any only for a referenced selected/previous group, not an unspecified army.', worker ? { villager: 'Land worker, villager, builder', fishing_boat: 'Fishing boat' } : { ...labels(Object.keys(UNIT_DEFS)), military: 'Military units, army (not economic units or transports)', any: 'Any type in the explicitly referenced group' }),
    });
    let questions: Record<string, DecisionQuestion>;
    if (family === 'gather') questions = { ...unitQuestions(true), resource: choice('Which resource should be gathered?', labels(['food', 'wood', 'gold', 'stone'])), target: choice('What resource source is intended?', { nearest: 'No specific object named: choose nearest eligible known source', selected: 'Currently selected resource object', pointer: 'Resource object under pointer', previous: 'Same target as the previous gather order', ...labels(['berries', 'sheep', 'farm', 'fish']) }) };
    else if (family === 'build') questions = { ...unitQuestions(true), building: choice('Which building? Resolve another one from the last successful build if available.', labels(Object.keys(BUILDING_DEFS))), location: choice('Where should it be constructed? Do not invent a placement for an unspecified location.', locations) };
    else if (family === 'move') questions = { ...unitQuestions(), operation: choice('Move units or set a building rally point?', { move: 'Move referenced units', rally: 'Set rally point of selected own production building' }), location: choice('Where should units go?', locations) };
    else if (family === 'train') questions = { unit: choice('Which unit should be trained? Resolve another one from the last successful training order if available.', labels(Object.keys(UNIT_DEFS))), quantity: choice('How many units to train? Default to one when singular or another one.', labels(Array.from({ length: 20 }, (_, i) => String(i + 1)))) };
    else if (family === 'research') questions = { action: choice('Which research or age advancement?', { advanceAge: 'Advance to next age', ...Object.fromEntries(TECH_DEFS.map(t => [t.id, `${t.id}: ${t.name}`])) }) };
    else if (family === 'combat') questions = { ...unitQuestions(), action: choice('Which tactical order?', labels(['attack', 'repair', 'stop', 'garrison', 'unload'])), target: choice('Which target?', { selected: 'The currently selected target object', pointer: 'Object under current map pointer', previous: 'Target from last successful command', nearest_enemy: 'Player explicitly requests nearest visible enemy', town_center: 'Own town center' }) };
    else questions = { action: choice('Which economic order?', labels(['buy', 'sell', 'cancelTrain', 'delete'])), resource: choice('Which market resource? Choose unknown for a non-market order.', labels(['food', 'wood', 'stone'])), quantity: choice('Number of market lots (100 resources each), default one.', labels(Array.from({ length: 10 }, (_, i) => String(i + 1)))) };
    const answers = await this.ask(utterance, questions, signal);
    const get = (name: string, question: string) => required(answers, name, question);
    const resolved = (name: string) => {
      const answer = answers[name];
      return answer && answer.choice !== 'unknown' && answer.confidence >= confidenceThreshold ? answer.choice : undefined;
    };
    const group = (worker = false, defaultIdleWorker = false) => {
      let reference = resolved('units');
      const singleIdleWorker = /\b(?:an?|one)\s+idle\s+(?:villager|worker|builder)\b/i.test(utterance);
      const ordinal = workerOrdinal(utterance);
      // “An idle worker” identifies a category, not one specific villager.
      // Choose from the idle pool deterministically; multi-action planning
      // reserves the first choice so the next clause receives another worker.
      if (singleIdleWorker) reference = 'idle';
      else if (ordinal !== undefined) reference = 'explicit';
      // A bare labor order such as “build a house” or “gather wood” delegates
      // worker selection to the game. Explicit/deictic references still need a
      // confident model answer so “those villagers” cannot silently mean others.
      const explicitReference = /\b(?:selected|these|those|them|previous|same|all|idle|villagers?|workers?|builders?|fishing\s+boats?|boats?|id\s*#?\d+)\b|#\d+/i.test(utterance);
      if (!reference && defaultIdleWorker && !explicitReference) reference = 'automatic';
      if (!reference) reference = get('units', 'Which units should I use?');
      let type = resolved('unitType');
      if (singleIdleWorker || ordinal !== undefined) type = 'villager';
      if (!type && reference === 'automatic') type = 'villager';
      if (!type) type = worker ? get('unitType', 'Villagers or fishing boats?') : get('unitType', 'Which type of units?');
      let quantity = resolved('quantity');
      if (reference === 'all') quantity = 'all';
      else if (singleIdleWorker || reference === 'explicit' && ordinal !== undefined) quantity = '1';
      else if (reference === 'idle' && !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+(?:idle\s+)?(?:villagers?|workers?|builders?)\b/i.test(utterance)) {
        quantity = /\bidle\s+(?:villagers|workers|builders)\b/i.test(utterance) ? 'all' : '1';
      }
      if (!quantity && reference === 'automatic') quantity = '1';
      if (!quantity) quantity = get('quantity', 'How many units should I use?');
      return this.chooseUnits(reference, type, quantity, utterance, reserved);
    };
    const result = (command: GameCommand, summary: string): PlannedOrder[] => [{ command, summary }];
    if (family === 'train') {
      const unit = explicitTrainUnit(utterance) ?? get('unit', 'What unit should I train?') as UnitType;
      const count = explicitTrainQuantity(utterance) ?? Number(get('quantity', 'How many units should I train?'));
      this.available(`train:${unit}`); const producer = this.producer(unit);
      if (producer.queue.length + count > TRAIN_QUEUE_MAX) throw new Error('That quantity exceeds the available production queue.');
      return Array.from({ length: count }, () => ({ command: { kind: 'train' as const, buildingId: producer.id, unit }, summary: `Queued one ${unit} at ${producer.type} #${producer.id}` }));
    }
    if (family === 'research') {
      const action = get('action', 'Which technology or age would you like to research?');
      this.available(action === 'advanceAge' ? action : `research:${action}`);
      if (action === 'advanceAge') return result({ kind: 'advanceAge' }, 'Started advancement to the next age');
      const tech = TECH_DEFS.find(t => t.id === action)!;
      const building = this.ownBuildings().find(b => b.type === tech.building && b.progress >= 1 && !b.research)!;
      return result({ kind: 'research', buildingId: building.id, techId: action }, `Started research: ${action}`);
    }
    if (family === 'economy') {
      const action = get('action', 'Buy, sell, cancel training, or delete selected objects?');
      if (action === 'buy' || action === 'sell') {
        const resource = get('resource', 'Which resource?') as 'food' | 'wood' | 'stone';
        this.available(`${action}:${resource}`);
        return Array.from({ length: Number(get('quantity', 'How many lots of 100?')) }, () => ({ command: { kind: 'trade' as const, action, resource }, summary: `${action === 'buy' ? 'Bought' : 'Sold'} 100 ${resource}` }));
      }
      if (action === 'cancelTrain') {
        const selected = this.ownBuildings().filter(b => this.state.selection.has(b.id) && b.queue.length);
        const previous = this.conversation.lastCommand;
        const building = selected.length === 1 ? selected[0] : previous?.kind === 'train' ? this.state.buildings.get(previous.buildingId) : undefined;
        if (!building?.queue.length) throw new ClarificationNeeded('Select a building with a training queue to cancel.');
        return result({ kind: 'cancelTrain', buildingId: building.id, index: building.queue.length - 1 }, 'Cancelled the last queued unit');
      }
      const ids = [...this.state.selection].filter(id => this.state.units.get(id)?.owner === this.state.you || this.state.buildings.get(id)?.owner === this.state.you);
      if (!ids.length) throw new ClarificationNeeded('Select the owned units or buildings to delete first.');
      if (!/\b(?:delete|destroy|demolish|remove)\b/i.test(utterance)) throw new ClarificationNeeded('Deleting is irreversible. Please explicitly ask to delete the selected objects.');
      return result({ kind: 'delete', ids }, `Deleted ${ids.length} selected objects`);
    }
    if (family === 'move' && get('operation', 'Move units or set a rally point?') === 'rally') {
      const buildings = this.ownBuildings().filter(b => this.state.selection.has(b.id) && BUILDING_DEFS[b.type].trains.length);
      if (buildings.length !== 1) throw new ClarificationNeeded('Select one production building to set its rally point.');
      const point = this.position(get('location', 'Where should the rally point go?'), utterance);
      return result({ kind: 'setRally', buildingId: buildings[0].id, ...point }, 'Set the rally point');
    }
    const action = family === 'combat' ? get('action', 'What tactical order?') : family;
    if (action === 'unload') {
      const selected = [...this.state.selection].filter(id => (this.state.buildings.get(id)?.owner === this.state.you && (this.state.buildings.get(id)?.garrison ?? 0) > 0) || (this.state.units.get(id)?.owner === this.state.you && this.state.units.get(id)?.type === 'transport' && (this.state.units.get(id)?.garrison ?? 0) > 0));
      if (selected.length !== 1) throw new ClarificationNeeded('Select one occupied building or transport to unload.');
      return result({ kind: 'unload', buildingId: selected[0] }, 'Unloaded the selected garrison');
    }
    const workerOrder = family === 'gather' || family === 'build';
    const unitIds = group(workerOrder, workerOrder);
    if (action === 'stop') return result({ kind: 'stop', unitIds }, `Stopped ${unitIds.length} units`);
    if (family === 'build') {
      if (unitIds.some(id => this.state.units.get(id)?.type !== 'villager')) throw new Error('Only villagers can build.');
      // Exact game building names are deterministic facts; do not ask the
      // player to repeat “house”, “barracks”, or “town center” because a model
      // returned unknown for text the planner can resolve safely itself.
      const building = explicitEnum(utterance, Object.keys(BUILDING_DEFS) as BuildingType[]) ?? get('building', 'Which building should I construct?') as BuildingType;
      const location = explicitLocation(utterance) ?? get('location', 'Where should I place it?');
      this.available(`build:${building}`); const point = this.placement(building, location, utterance);
      return result({ kind: 'build', unitIds, building, tileX: point.x, tileY: point.y }, `Placed ${building} at ${point.x}, ${point.y}`);
    }
    if (family === 'move') {
      const point = this.position(get('location', 'Where should I move them?'), utterance);
      return result({ kind: 'move', unitIds, ...point }, `Ordered ${unitIds.length} units to move to ${Math.floor(point.x)}, ${Math.floor(point.y)}`);
    }
    if (family === 'gather') {
      const resource = explicitGatherResource(utterance) ?? get('resource', 'Which resource should they gather?') as ResourceType;
      const target = explicitGatherTarget(utterance) ?? get('target', 'Which resource source should they use?');
      const workers = unitIds.map(id => this.state.units.get(id)!);
      const boats = workers.every(u => u.type === 'fishing_boat');
      if (!boats && workers.some(u => u.type === 'fishing_boat')) throw new ClarificationNeeded('Please order villagers and fishing boats separately.');
      const sources: Array<{ id: number; type: string; x: number; y: number }> = [...this.state.nodes.values()].filter(n => this.state.nodeVisible(n) && n.amount > 0 && NODE_DEFS[n.type].resource === resource && (n.type === 'fish') === boats).map(n => ({ id: n.id, type: n.type, x: n.tileX, y: n.tileY }));
      if (resource === 'food' && !boats) {
        sources.push(...this.ownBuildings().filter(b => b.type === 'farm' && b.progress >= 1 && (b.foodLeft ?? 0) > 0).map(b => ({ id: b.id, type: 'farm', x: b.tileX, y: b.tileY })));
        sources.push(...[...this.state.sheep.values()].filter(s => this.state.sheepVisible(s) && (s.owner === this.state.you || s.owner === -1) && s.food > 0).map(s => ({ id: s.id, type: 'sheep', x: s.x, y: s.y })));
      }
      const pointer = this.interaction().pointer;
      const previous = this.conversation.lastCommand;
      const filtered = sources.filter(s => target === 'nearest' || target === 'selected' && this.state.selection.has(s.id) || target === 'pointer' && pointer && Math.hypot(pointer.x - s.x, pointer.y - s.y) <= 2 || target === 'previous' && previous?.kind === 'gather' && previous.targetId === s.id || s.type === ({ berries: 'berry_bush' } as Record<string, string>)[target] || s.type === target);
      const origin = { x: workers.reduce((n, u) => n + u.x, 0) / workers.length, y: workers.reduce((n, u) => n + u.y, 0) / workers.length };
      filtered.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y) || a.id - b.id);
      if (!filtered.length) throw new ClarificationNeeded(`No eligible known ${resource} source matches that request.`);
      if ((target === 'selected' || target === 'pointer') && filtered.length > 1) throw new ClarificationNeeded('More than one source matches. Select a single resource object.');
      return result({ kind: 'gather', unitIds, targetId: filtered[0].id }, `Assigned ${unitIds.length} gatherers to ${resource}`);
    }
    const reference = get('target', 'Which target should they use?');
    const pointer = this.interaction().pointer;
    const entities: Array<UnitSnap | BuildingSnap> = [...this.state.units.values()].filter(u => this.state.unitVisible(u)).concat([]);
    entities.push(...visibleBuildings(this.state));
    const previous = this.conversation.lastCommand;
    const center = (e: UnitSnap | BuildingSnap): Point => 'x' in e ? e : { x: e.tileX + BUILDING_DEFS[e.type].size / 2, y: e.tileY + BUILDING_DEFS[e.type].size / 2 };
    let candidates = entities.filter(e => action === 'attack' ? !this.state.alliedOwners.has(e.owner) : e.owner === this.state.you);
    if (action === 'repair') candidates = candidates.filter(e => 'progress' in e && e.progress >= 1 && e.hp < BUILDING_DEFS[e.type].hp);
    if (action === 'garrison') candidates = candidates.filter(e => 'progress' in e ? e.progress >= 1 && !!GARRISON_CAP[e.type] && (e.garrison ?? 0) < GARRISON_CAP[e.type]! : e.type === 'transport');
    candidates = candidates.filter(e => reference === 'selected' ? this.state.selection.has(e.id) : reference === 'pointer' ? pointer && Math.hypot(center(e).x - pointer.x, center(e).y - pointer.y) < 2 : reference === 'previous' ? previous && 'targetId' in previous && previous.targetId === e.id : reference === 'town_center' ? e.type === 'town_center' : reference === 'nearest_enemy' && action === 'attack');
    if (reference === 'nearest_enemy') { const origin = this.state.units.get(unitIds[0])!; candidates.sort((a, b) => Math.hypot(center(a).x - origin.x, center(a).y - origin.y) - Math.hypot(center(b).x - origin.x, center(b).y - origin.y)); candidates = candidates.slice(0, 1); }
    if (candidates.length !== 1) throw new ClarificationNeeded('Select or point to one valid target for that order.');
    if (action === 'repair' && unitIds.some(id => this.state.units.get(id)?.type !== 'villager')) throw new Error('Only villagers can repair buildings.');
    if (action === 'garrison' && unitIds.some(id => isNavalUnit(this.state.units.get(id)!.type))) throw new Error('Ships cannot enter a garrison.');
    return result({ kind: action as 'attack' | 'repair' | 'garrison', unitIds, targetId: candidates[0].id }, `Issued ${action} for ${unitIds.length} units`);
  }

  remember(command: GameCommand) {
    this.conversation.lastCommand = command;
    this.conversation.pendingClarification = undefined;
    if ('unitIds' in command) this.conversation.lastUnitIds = [...command.unitIds];
    if ('buildingId' in command) this.conversation.lastBuildingId = command.buildingId;
    if ('x' in command) this.conversation.lastLocation = { x: command.x, y: command.y };
    if (command.kind === 'build') this.conversation.lastLocation = { x: command.tileX, y: command.tileY };
    this.trace('tool', 'game.command.executed', { kind: command.kind });
  }
}
