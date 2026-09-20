import { AGE_COSTS, BUILDING_DEFS, TECH_DEFS, UNIT_DEFS, TRAIN_QUEUE_MAX, tradeBuyCost, type GameCommand, type Resources, type ServerMessage } from '@age/shared';
import type { GameState } from '../state';
import { AnnouncementMonitor } from './announcement-monitor';
import { gameVoiceContext, gameAffordances, visibleBuildings, type GameInteraction } from './voice-context';
import { GamePlanner, type PlannedOrder } from './voice-planner';
import { ClarificationNeeded, type Decide, type GameTrace } from './voice-decision';

type CommandResult = Extract<ServerMessage, { type: 'commandResult' }>;
interface VoiceSession { id: string; decide: Decide; trace: GameTrace; controller: AbortController; busy: boolean }
let voice: VoiceSession | undefined;
let current: GameVoiceBridge | undefined;
const trace: GameTrace = (phase, label, attributes) => voice?.trace(phase, label, attributes);
export function currentGameVoice() { return current; }
export function activateGameVoice(decide: Decide, telemetry: GameTrace) {
  voice?.controller.abort();
  const session: VoiceSession = { id: crypto.randomUUID(), decide, trace: telemetry, controller: new AbortController(), busy: false };
  voice = session; current?.monitor.setVoiceState(true, false);
  return {
    busy(value: boolean) { if (voice === session) { session.busy = value; current?.monitor.setVoiceState(true, value); } },
    close() { session.controller.abort(); if (voice === session) { voice = undefined; current?.monitor.setVoiceState(false, false); } },
    signal: session.controller.signal,
  };
}
export function attachGameVoice(state: GameState, interaction: () => GameInteraction, send: (command: GameCommand, signal: AbortSignal) => Promise<CommandResult>) {
  current?.dispose();
  current = new GameVoiceBridge(state, interaction, send);
  current.monitor.setVoiceState(!!voice, voice?.busy ?? false);
  return current;
}
export function detachGameVoice() { current?.dispose(); current = undefined; }

export class GameVoiceBridge {
  readonly planner: GamePlanner;
  readonly monitor: AnnouncementMonitor;
  private controller = new AbortController();
  private running = false;
  private commandController: AbortController | undefined;
  constructor(private state: GameState, private interaction: () => GameInteraction, private send: (command: GameCommand, signal: AbortSignal) => Promise<CommandResult>) {
    this.planner = new GamePlanner(state, interaction, () => voice?.decide, trace);
    this.monitor = new AnnouncementMonitor(state, interaction, () => voice?.decide, trace, suggestion => { this.planner.conversation.pendingSuggestion = suggestion; });
  }
  resetConversation() {
    const memory = this.planner.conversation;
    memory.lastUnitIds = []; delete memory.lastCommand; delete memory.lastLocation; delete memory.lastBuildingId; delete memory.pendingClarification; delete memory.pendingSuggestion;
  }
  snapshot() { this.monitor.scan(); }
  interrupt() {
    if (this.commandController && !this.commandController.signal.aborted) {
      this.commandController.abort(); trace('tool', 'game.command.interrupted', { reason: 'New player speech; unissued orders cancelled' });
    }
  }
  query(topic: string) {
    const game = gameVoiceContext(this.state, this.interaction());
    trace('tool', 'game.query', { topic, tick: this.state.tick });
    switch (topic) {
      case 'resources': return { resources: game.player?.resources, population: game.player?.population, market: this.state.marketPrices };
      case 'selection': return { selection: game.selection, units: game.units.filter(u => game.selection.includes(u.id)), buildings: game.buildings.filter(b => game.selection.includes(b.id)), pointer: game.pointer };
      case 'idle': return { villagers: game.units.filter(u => u.type === 'villager' && u.state === 'idle'), military: game.units.filter(u => !['villager', 'fishing_boat', 'transport'].includes(u.type) && u.state === 'idle') };
      case 'army': return { units: game.units.filter(u => !['villager', 'fishing_boat'].includes(u.type)), visibleEnemies: game.visibleEnemies };
      case 'buildings': return { buildings: game.buildings };
      case 'age': return { age: game.player?.age, progress: game.player?.ageProgress, advance: game.availableActions.find(a => a.id === 'advanceAge') };
      case 'research': return { completed: game.player?.techs, available: game.availableActions.filter(a => a.category === 'research'), inProgress: game.buildings.filter(b => b.research) };
      case 'availableActions': return { actions: game.availableActions };
      case 'overview': return game;
      default: throw new Error('Unknown game query topic.');
    }
  }
  /** Strict client preflight does not replace server validation. It prevents
   * stale references and rejects a whole plan before starting known failures. */
  private validate(orders: PlannedOrder[]): string[] {
    this.planner.assertPlayable();
    const resources = { ...this.state.me()!.resources! };
    const queues = new Map([...this.state.buildings.values()].map(b => [b.id, b.queue.length]));
    const queuedPopulation = [...this.state.buildings.values()]
      .filter(building => building.owner === this.state.you)
      .flatMap(building => building.queue)
      .reduce((total, item) => total + UNIT_DEFS[item.unit].pop, 0);
    let plannedPopulation = 0;
    const placements: Array<{ x: number; y: number; size: number }> = [];
    const pay = (cost: Partial<Resources>) => {
      for (const [key, amount] of Object.entries(cost)) {
        const r = key as keyof Resources;
        if (resources[r] < amount) throw new Error(`Insufficient ${r} for the complete plan.`);
        resources[r] -= amount;
      }
    };
    for (const { command: cmd } of orders) {
      const ids = 'unitIds' in cmd ? cmd.unitIds : cmd.kind === 'delete' ? cmd.ids : [];
      for (const id of ids) {
        const entity = this.state.units.get(id) ?? (cmd.kind === 'delete' ? this.state.buildings.get(id) : undefined);
        if (!entity || entity.owner !== this.state.you) throw new Error(`Object #${id} is gone or is not owned by you.`);
      }
      if ('buildingId' in cmd) {
        const entity = this.state.buildings.get(cmd.buildingId) ?? (cmd.kind === 'unload' ? this.state.units.get(cmd.buildingId) : undefined);
        if (!entity || entity.owner !== this.state.you) throw new Error('The referenced building or transport is unavailable.');
      }
      if ('targetId' in cmd) {
        const unit = this.state.units.get(cmd.targetId); const building = this.state.buildings.get(cmd.targetId);
        const node = this.state.nodes.get(cmd.targetId); const sheep = this.state.sheep.get(cmd.targetId);
        if (cmd.kind === 'attack') {
          const enemy = unit && this.state.unitVisible(unit) ? unit : building && visibleBuildings(this.state).some(b => b.id === building.id) ? building : undefined;
          if (!enemy || this.state.alliedOwners.has(enemy.owner)) throw new Error('Attack target is no longer a visible enemy.');
        } else if (cmd.kind === 'gather') {
          if (!(node && this.state.nodeVisible(node) && node.amount > 0 || building && building.owner === this.state.you && building.type === 'farm' && building.progress >= 1 && (building.foodLeft ?? 0) > 0 || sheep && this.state.sheepVisible(sheep) && (sheep.owner === this.state.you || sheep.owner === -1) && sheep.food > 0)) throw new Error('Resource target is no longer available.');
        } else if ((unit ?? building)?.owner !== this.state.you) throw new Error('The target is no longer owned by you.');
      }
      if (cmd.kind === 'build') {
        const affordance = gameAffordances(this.state).find(a => a.id === `build:${cmd.building}`);
        if (!affordance?.enabled || !this.state.canPlace(cmd.building, cmd.tileX, cmd.tileY)) throw new Error(affordance?.reasonUnavailable ?? 'Building placement is no longer legal.');
        const size = BUILDING_DEFS[cmd.building].size;
        if (placements.some(p => cmd.tileX < p.x + p.size && cmd.tileX + size > p.x && cmd.tileY < p.y + p.size && cmd.tileY + size > p.y)) throw new ClarificationNeeded('Two planned buildings overlap. Give them separate locations.');
        placements.push({ x: cmd.tileX, y: cmd.tileY, size }); pay(BUILDING_DEFS[cmd.building].cost);
      } else if (cmd.kind === 'train') {
        const count = (queues.get(cmd.buildingId) ?? 0) + 1;
        if (count > TRAIN_QUEUE_MAX) throw new Error('The complete order exceeds the production queue capacity.');
        queues.set(cmd.buildingId, count); plannedPopulation += UNIT_DEFS[cmd.unit].pop; pay(UNIT_DEFS[cmd.unit].cost);
      } else if (cmd.kind === 'research') pay(TECH_DEFS.find(t => t.id === cmd.techId)!.cost);
      else if (cmd.kind === 'advanceAge') pay(AGE_COSTS[this.state.me()!.age + 1] ?? {});
      else if (cmd.kind === 'trade') pay(cmd.action === 'buy' ? { gold: tradeBuyCost(this.state.marketPrices[cmd.resource]) } : { [cmd.resource]: 100 });
    }
    trace('tool', 'game.command.validation', { valid: true, count: orders.length, tick: this.state.tick });
    const player = this.state.me()!;
    return player.pop + queuedPopulation + plannedPopulation > player.popCap
      ? ['Population capacity will hold some queued units until more housing is completed.']
      : [];
  }
  async command(raw: string): Promise<unknown> {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4000) throw new Error('Give a nonempty command of at most 4000 characters.');
    if (this.running) throw new Error('Another voice order is still in progress. Please wait for its result.');
    const session = voice;
    if (!session) throw new Error('Vowel is not connected.');
    const suggestion = this.planner.conversation.pendingSuggestion;
    const affirmative = /^(?:yes|yeah|yep|sure|ok(?:ay)?|please|do it|go ahead|sim|s[ií])[.!]?$/i.test(raw.trim());
    const negative = /^(?:no|nope|don'?t|cancel(?: that)?|never ?mind|n[aã]o)[.!]?$/i.test(raw.trim());
    if (suggestion && suggestion.expiresAt > Date.now() && negative) {
      delete this.planner.conversation.pendingSuggestion;
      return { status: 'cancelled', message: 'Suggestion declined. No game action was taken.' };
    }
    const confirmedSuggestion = suggestion && suggestion.expiresAt > Date.now() && affirmative ? suggestion : undefined;
    if (suggestion && (suggestion.expiresAt <= Date.now() || confirmedSuggestion)) delete this.planner.conversation.pendingSuggestion;
    const pending = this.planner.conversation.pendingClarification;
    if (pending && /^(?:cancel(?: that)?|never mind|nevermind|forget it)[.!]?$/i.test(raw.trim())) {
      delete this.planner.conversation.pendingClarification; return { status: 'cancelled', message: 'Cancelled the unresolved request. No game action was taken.' };
    }
    const utterance = confirmedSuggestion?.command ?? (pending && Date.now() - pending.at < 60000 ? `Clarification continuation for one combined request. Original order: ${pending.utterance}\nClarification asked: ${pending.question}\nPlayer clarification: ${raw}` : raw);
    if (confirmedSuggestion) trace('input', 'game.suggestion.confirmed', { id: confirmedSuggestion.id, command: confirmedSuggestion.command });
    this.commandController = new AbortController();
    const signal = AbortSignal.any([session.controller.signal, this.controller.signal, this.commandController.signal, AbortSignal.timeout(90000)]);
    this.running = true;
    const started = performance.now();
    const results: Array<{ summary: string; result: CommandResult }> = [];
    try {
      const orders = await this.planner.plan(utterance, signal);
      if (orders.length > 24) throw new Error('Use at most 24 primitive orders in one request.');
      const warnings = this.validate(orders);
      for (const order of orders) {
        if (signal.aborted) throw new Error('Command execution was cancelled.');
        this.planner.assertPlayable();
        // The authoritative server checks the actual resources, phase and targets
        // again for each order. Do not retry unknown outcomes or claim atomicity.
        const result = await this.send(order.command, signal);
        results.push({ summary: result.ok ? order.summary : result.reason ?? 'Rejected', result });
        if (!result.ok) break;
        this.planner.remember(order.command);
      }
      const completed = results.filter(r => r.result.ok).length;
      trace('tool', 'game.command.result', { count: orders.length, completed, duration_ms: Math.round(performance.now() - started) });
      return { status: completed === orders.length ? 'executed' : completed ? 'partial' : 'rejected', completed, planned: orders.length, results, warnings, note: 'Acknowledged orders are started or queued, not necessarily completed in the simulation.' };
    } catch (error) {
      if (error instanceof ClarificationNeeded) {
        this.planner.conversation.pendingClarification = { utterance: pending?.utterance ?? raw, question: error.message, at: Date.now() };
        trace('tool', 'game.command.clarification', { reason: error.message });
        return { status: 'clarification_required', question: error.message, choices: error.choices, results };
      }
      const message = error instanceof Error ? error.message : 'Game command failed.';
      if (/insufficient|resources/i.test(message)) this.monitor.resourceBlocked(message);
      trace('error', 'game.command.failed', { reason: message, completed: results.filter(r => r.result.ok).length });
      return { status: results.length ? 'partial' : 'failed', message, results };
    } finally { this.running = false; this.commandController = undefined; }
  }
  dispose() { this.controller.abort(); this.monitor.dispose(); this.resetConversation(); }
}
