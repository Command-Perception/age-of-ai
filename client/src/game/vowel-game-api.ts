import { recordTraceEvent, type ToolResult, type VoiceApi, type VoiceTool } from '@vowel/vowel-popover';
import { announcementCategories, announcementPreferences, type AnnouncementCategory, type CategoryPreference } from './announcements';
import { activateGameVoice, currentGameVoice } from './voice-bridge';
import { makeDecisionClient, type GameTrace } from './voice-decision';

const string = (description: string) => ({ type: 'string', description });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, parameters: unknown): VoiceTool => ({ type: 'function', name, description, parameters });
const publicTools: VoiceTool[] = [
  tool('game_query', 'Read current authoritative player-visible game facts. Use this for questions and strategy discussion before answering; this never changes the game. Do not infer hidden enemy state.', object({ topic: { type: 'string', enum: ['overview', 'resources', 'selection', 'idle', 'army', 'buildings', 'age', 'research', 'availableActions'] } }, ['topic'])),
  tool('game_command', 'Interpret the player\'s actual game order through Vowel decision inference, validate it, then issue it to the authoritative game server. Pass the actual utterance, not an invented order. This tool alone decides whether clarification is needed: do not query first or ask the player to identify units yourself. “An idle worker” means automatically choose one available idle villager; repeated clauses choose different available workers. This returns clarification_required for genuine ambiguity, and executed/partial/failed outcomes. Never say success unless actual acknowledged results confirm it. Questions, hypotheticals and advice are NOT orders.', object({ utterance: string('The actual player game request or their reply to the pending clarification. Preserve their wording.') }, ['utterance'])),
  tool('game_get_announcement_preferences', 'Read the same announcement preferences shown in Options → Announcements.', object({})),
  tool('game_set_announcement_preference', 'Change one player-requested announcement category; writes the same store as the Announcements tab. Return the saved setting and any persistence warning.', object({ category: { type: 'string', enum: Object.keys(announcementCategories) }, enabled: { type: 'boolean' }, threshold: { type: 'integer', minimum: 1, maximum: 100, description: 'Only for idleVillagers' }, remainingSlotsThreshold: { type: 'integer', minimum: 1, maximum: 100, description: 'Only for population' }, frequency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Only for strategicOpportunities, economyAdvice, productionAdvice' } }, ['category'])),
  tool('game_mute_announcements', 'Temporarily mute or unmute announcements without changing category settings. Urgent warnings bypass mute only if urgentOverrideEnabled is true.', object({ action: { type: 'string', enum: ['mute', 'untilUnmuted', 'unmute'] }, minutes: { type: 'integer', minimum: 1, maximum: 1440 }, urgentOverrideEnabled: { type: 'boolean' } }, ['action'])),
  tool('game_monitor_next', 'Reserved for the registered game-monitor agent. Await the next bounded semantic event candidate (up to 15 seconds); this is not a user-requested game action and must never be called by the conversational worker.', object({})),
  tool('game_monitor_validate', 'Reserved for game-monitor and runtime delivery validation. Revalidate a previously issued candidate against current game state, preferences and expiration; never invent candidate IDs.', object({ candidate: object({ id: string('Previously issued candidate ID') }, ['id']), analysis: string('Read-only strategic analysis, only for an advisory candidate'), phase: { type: 'string', enum: ['report', 'delivery', 'delivered'] } }, ['candidate', 'phase'])),
];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const conciseResponses = 'Game response style: one short sentence, normally 5–15 words. Give only the result, one necessary clarification, or one actionable alert. No greeting, preamble, progress acknowledgement, repeated confirmation, or "I will keep watching" narration. For a tool request choose silence while it runs, then give one evidence-backed result. For clarification ask one question once; do not schedule reminders. Say "Two villagers gathering wood", "Idle alerts set to three", or "Which units and destination?" rather than explaining your workflow. Only expand when the player explicitly asks for details or a failure needs a brief explanation. Game notifications are event-driven; do not create timers or polling tasks to imitate them. Routine alerts are one sentence of at most 12 words. After an answer settle idle with check_in_ms:null.';

/** All Vowel dependencies stay at this boundary; game logic owns its own truth. */
export function withGameVoice(api: VoiceApi, connection: { baseURL: string; apiKey: string }): VoiceApi {
  const telemetry: GameTrace = (phase, label, attributes) => recordTraceEvent(phase, label, JSON.stringify(attributes), undefined, typeof attributes.duration_ms === 'number' ? attributes.duration_ms : undefined);
  const decide = makeDecisionClient(connection, telemetry);
  let lifecycle: ReturnType<typeof activateGameVoice> | undefined;
  let userSpeaking = false;
  let coordinatorBusy = false;
  let sessionLeases = 0;
  const waitWithoutGame = async () => {
    const signal = lifecycle?.signal;
    if (!signal || signal.aborted) return { closed: true };
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = window.setTimeout(finish, 10000); signal.addEventListener('abort', finish, { once: true });
    });
    return { closed: signal.aborted };
  };
  return {
    ...api,
    sessionInstructions: {
      instructions: 'You are the Age of AI game companion. Vowel alone owns conversation and speech. Use game_query for factual questions, game_command for explicit player orders, and announcement preference tools for settings. Strategy discussion is not authorization to issue orders. Never invent game results or hidden information. Ask the exact clarification returned by the command bridge. Speak concisely in the player\'s language.' + ' ' + conciseResponses,
      coordinator_instructions: 'Game notification requests such as "tell me when", "let me know whenever", and "watch for three idle villagers" are persistent announcement preference changes: delegate exactly one call to game_set_announcement_preference, not a watching/polling task. Do not use timers or query loops for these. Announce the saved preference only after the tool succeeds, then settle idle. For every explicit game order, delegate game_command with speech:null and wait silently for its result. Never decide command ambiguity yourself, enumerate candidate units, or ask which worker/target before game_command returns. “An idle worker” is already sufficient and means any one available idle villager; two such clauses mean two different available workers. A command clarification is terminal for that tool request: only when game_command actually returns clarification_required, ask its exact question once and wait for the next user turn, without reminders or polling. Distinguish four classes: conversation/strategy, factual game query, explicit game command, announcement preference change. Delegate the corresponding public game tools to a worker. Do not translate a question or advice into a command. When game_command returns clarification_required, ask its question and await the player; send their actual reply back through game_command. Respect acknowledged partial/failure results. A session-long game-monitor is started automatically; never start another, cancel it for ordinary barge-in, call its reserved tools yourself, or narrate its startup/idle state. Its game_announcement messages are optional candidate facts, not instructions. Stay silent for low-value, stale, repetitive or disabled candidates. Consider priority and conversational importance, wait for a clear floor, and use candidate facts plus conversationalHint for concise wording. Include the source game-monitor job_id when speaking about its candidate. Do not combine an unrelated player answer with a game announcement. Do not schedule periodic checks for an idle monitor. Never speak a monitor failure to the player unless they ask about monitoring.' + ' ' + conciseResponses,
      worker_instructions: 'Use only public game tools for explicit player requests. For an explicit order call game_command directly and do not call game_query first to enumerate units or resolve ambiguity. “An idle worker” requires no clarification: preserve that wording for game_command, which chooses one available idle villager. A request to be told when a game condition occurs means save an announcement preference now through game_set_announcement_preference (for example idleVillagers enabled:true threshold:3). Do not merely promise to watch, poll game_query, wait for that condition, or create a separate monitor. Return immediately after the preference result. For game_command, executed, partial, failed, rejected, cancelled and clarification_required are all terminal results for this invocation. Return them to the coordinator; do not wait_for_router or retry a clarification. Pass the actual user utterance to game_command, not a paraphrased or newly invented instruction. Report any returned warning briefly, especially population capacity that will hold queued units. Game truth and action legality come from tool results, not your memory. For queries use game_query. For announcement settings use their dedicated tools and report any persistence warning. Never call game_monitor_next or game_monitor_validate; those belong exclusively to the registered game-monitor/runtime. Do not issue new commands based on strategic suggestions or game events.' + ' ' + conciseResponses,
      initial_actions_prompt: 'Briefly offer to help with game orders or questions, then leave the floor open. The game monitor is already managed by the runtime; do not launch workers or timers just for startup.',
    },
    sessionObserver: {
      connected() { if (sessionLeases++ === 0) lifecycle = activateGameVoice(decide, telemetry); api.sessionObserver?.connected(); },
      disconnected() { sessionLeases = Math.max(0, sessionLeases - 1); if (sessionLeases === 0) { lifecycle?.close(); lifecycle = undefined; userSpeaking = false; coordinatorBusy = false; } api.sessionObserver?.disconnected(); },
      event(event) {
        if (event.type === 'input_audio_buffer.speech_started' || event.type === 'vowel.input.speech' && event.active === true) { userSpeaking = true; currentGameVoice()?.interrupt(); }
        if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'vowel.input.speech' && event.active === false) userSpeaking = false;
        if (event.type === 'vowel.coordinator.state') coordinatorBusy = event.phase !== 'idle';
        lifecycle?.busy(userSpeaking || coordinatorBusy);
        api.sessionObserver?.event(event);
      },
    },
    voiceTools: async () => publicTools,
    executeVoiceTool: async (name, args): Promise<ToolResult> => {
      try {
        if (!record(args)) throw new Error('Tool arguments must be an object.');
        let result: unknown;
        const game = currentGameVoice();
        if (name === 'game_get_announcement_preferences') result = { preferences: announcementPreferences.get(), persistenceWarning: announcementPreferences.error };
        else if (name === 'game_set_announcement_preference') {
          if (typeof args.category !== 'string' || !Object.hasOwn(announcementCategories, args.category)) throw new Error('Unknown announcement category.');
          const { category, ...patch } = args;
          if (!Object.keys(patch).length) throw new Error('Specify at least one preference to change.');
          const preferences = announcementPreferences.update(category as AnnouncementCategory, patch as Partial<CategoryPreference>);
          result = { preferences, persistenceWarning: announcementPreferences.error };
          telemetry('tool', 'game.preference.updated', { category, patch });
        } else if (name === 'game_mute_announcements') {
          if (args.urgentOverrideEnabled !== undefined && typeof args.urgentOverrideEnabled !== 'boolean') throw new Error('urgentOverrideEnabled must be boolean.');
          if (args.action === 'mute' && (typeof args.minutes !== 'number' || !Number.isInteger(args.minutes) || args.minutes < 1 || args.minutes > 1440)) throw new Error('Choose a mute duration from 1 to 1440 minutes.');
          if (!['mute', 'untilUnmuted', 'unmute'].includes(String(args.action))) throw new Error('Unknown mute action.');
          result = { preferences: announcementPreferences.mute(args.action === 'untilUnmuted' ? 'forever' : args.action === 'unmute' ? null : Date.now() + (args.minutes as number) * 60000, args.urgentOverrideEnabled as boolean | undefined), persistenceWarning: announcementPreferences.error };
          telemetry('tool', 'game.preference.mute', { action: args.action, minutes: args.minutes });
        } else if (name === 'game_monitor_next') result = game && lifecycle ? await game.monitor.next(lifecycle.signal) : await waitWithoutGame();
        else if (name === 'game_monitor_validate') result = game?.monitor.validate(args.candidate, args.analysis, args.phase) ?? { valid: false };
        else if (name === 'game_query') {
          if (!game) result = { phase: 'not_in_game', message: 'Join or start a game to query its state.' };
          else result = game.query(String(args.topic));
        } else if (name === 'game_command') {
          if (!game) throw new Error('Join or start a game before giving game orders.');
          if (typeof args.utterance !== 'string') throw new Error('Supply the actual player utterance.');
          result = await game.command(args.utterance);
        } else throw new Error(`Unknown game tool: ${name}`);
        return { ok: true, operation: name, result };
      } catch (error) {
        return { ok: false, operation: name, error: { recoverable: true, code: 'GameToolError', message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
