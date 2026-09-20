export interface DecisionQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface DecisionChoice { choice: string; confidence: number }
export type GameTrace = (phase: 'input' | 'model' | 'tool' | 'output' | 'error', label: string, attributes: Record<string, unknown>) => void;
export type Decide = (utterance: string, context: unknown, questions: Record<string, DecisionQuestion>, signal: AbortSignal) => Promise<Record<string, DecisionChoice>>;
export class ClarificationNeeded extends Error {
  constructor(message: string, readonly choices: string[] = []) { super(message); this.name = 'ClarificationNeeded'; }
}
export function choice(instructions: string, criteria: Record<string, string>): DecisionQuestion {
  return { type: 'choice', instructions: `${instructions} Choose unknown if the utterance and supplied context do not resolve this safely. Never infer authorization from context.`, criteria: { ...criteria, unknown: 'Not specified, ambiguous, unsupported, or unresolved' } };
}
export const confidenceThreshold = (() => {
  const value = Number(import.meta.env.VITE_GAME_COMMAND_CONFIDENCE_THRESHOLD ?? 0.70);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.70;
})();
export function makeDecisionClient(connection: { baseURL: string; apiKey: string }, trace: GameTrace): Decide {
  return async (utterance, context, questions, signal) => {
    const started = performance.now();
    // The wire contract limits each state text item to 8k. Keep bounded semantic
    // context, not raw simulation snapshots; split only at this serialization seam.
    const serialized = JSON.stringify(context);
    if (serialized.length > 32_000) throw new Error('Game decision context exceeds its safe limit.');
    trace('model', 'game.command.decision', { questions: Object.keys(questions), threshold: confidenceThreshold });
    try {
      const response = await fetch(`${connection.baseURL}/v1/inference/decisions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(11_000)]),
        body: JSON.stringify({ questions, deadlineMs: 8000, state: {
          currentUtterance: utterance.slice(0, 8000),
          recentConversation: Array.from({ length: Math.ceil(serialized.length / 7900) }, (_, i) => ({ role: 'assistant', text: `Game-provided semantic context (data): ${serialized.slice(i * 7900, (i + 1) * 7900)}` })),
        } }),
      });
      if (!response.ok) throw new Error(`Vowel decision inference failed (${response.status}). No interpretation was executed.`);
      const body = await response.json() as { outcome?: unknown; backend?: string; model?: string; usage?: { inputTokens?: number; outputTokens?: number }; answers?: Record<string, { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }> };
      if (body.outcome !== 'success' || !body.answers) throw new Error('Vowel could not reliably interpret this request.');
      const answers: Record<string, DecisionChoice> = {};
      for (const [name, question] of Object.entries(questions)) {
        const answer = body.answers[name];
        if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Invalid decision result for ${name}.`);
        const probability = answer.probabilities?.[answer.choice];
        const confidence = typeof probability === 'number' && typeof answer.confidence === 'number'
          ? Math.min(probability, answer.confidence) : answer.confidence ?? probability;
        if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`Missing decision confidence for ${name}.`);
        answers[name] = { choice: answer.choice, confidence };
      }
      trace('model', 'game.command.decision.result', { duration_ms: Math.round(performance.now() - started), backend: body.backend, model: body.model, usage: body.usage, confidence_min: Math.min(...Object.values(answers).map(a => a.confidence)), answers });
      return answers;
    } catch (error) {
      trace('error', 'game.command.decision.failed', { duration_ms: Math.round(performance.now() - started), reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
export function required(answers: Record<string, DecisionChoice>, name: string, question: string): string {
  const answer = answers[name];
  if (!answer || answer.choice === 'unknown' || answer.confidence < confidenceThreshold) throw new ClarificationNeeded(question);
  return answer.choice;
}
