/**
 * Browser-owned VAD (ALCHEMY-FLOCI-VOWEL.MD): when session.turn_detection is
 * null the client commits the audio buffer after the user stops speaking.
 * Vowel starts the response automatically; do not send response.create again. Volume is the same rmsVolume used by the mic meter.
 */

export const SPEECH_VOLUME = 0.05;
export const SILENCE_COMMIT_MS = 700;

export type SilenceCommitState = {
  readonly armed: boolean;
  readonly lastSpeechAt: number;
};

export const idleSilenceCommit = (): SilenceCommitState => ({
  armed: false,
  lastSpeechAt: 0,
});

export const stepSilenceCommit = (
  state: SilenceCommitState,
  volume: number,
  now: number,
  silenceMs = SILENCE_COMMIT_MS,
): { readonly state: SilenceCommitState; readonly commit: boolean } => {
  if (volume >= SPEECH_VOLUME) {
    return { state: { armed: true, lastSpeechAt: now }, commit: false };
  }
  if (!state.armed) return { state, commit: false };
  if (now - state.lastSpeechAt < silenceMs) return { state, commit: false };
  return { state: idleSilenceCommit(), commit: true };
};
