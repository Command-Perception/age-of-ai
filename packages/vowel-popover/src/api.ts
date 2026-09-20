import * as Data from "effect/Data";
import { createVoiceSettings, type VoiceSettingsStore } from "./voice-settings-store";
import { ensureClientKeySecret, selfMintClientSecret, type Config, type RecordItem } from "./host/control-plane";
import { executeClientToolPromise, openAiToolDefinition } from "./host/client-tools/index";
import { sampleClientTools } from "./host/client-tools/sample-tools";
import type { ToolResult, VoiceAvailability, VoiceSession, VoiceTool } from "./domain";
import { createAvatarDirectorClient, type AvatarDirectorClient } from "./avatar-director";
import type { VoiceInstructions } from "./voice-instructions";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly code: "VoiceError";
  readonly message: string;
}> {}

export class ApiRequestError extends Data.TaggedError("ApiRequestError")<{
  readonly endpoint: string;
  readonly status: number;
}> {
  override get message() {
    return `Voice api request failed (${this.status}): ${this.endpoint}.`;
  }
}

/** Use the Admin's authenticated, profile-bound self-minting flow. */
export const createVoiceApi = (
  config: Config,
  profile: RecordItem,
  sessionInstructions: VoiceInstructions = {},
  fallbackAppId: string = "",
) => {
  const avatarDirectorURL = import.meta.env.VITE_AVATAR_DIRECTOR_URL as string | undefined;
  const settings = createVoiceSettings(config, profile);
  return {
  settings,
  sessionInstructions,
  avatarDirector: avatarDirectorURL ? () => createAvatarDirectorClient({ baseURL: avatarDirectorURL }) : undefined,
  voiceAvailability: async (): Promise<VoiceAvailability> => ({ available: Boolean(config.apiKey && config.baseURL && profile.id) }),
  voiceSession: async (): Promise<VoiceSession> => {
    const profile = settings.getSnapshot().profile;
    const sessionId = crypto.randomUUID();
    // Global session profiles carry no app binding, so the voice test keys
    // off the app the admin is currently browsing (which their organization
    // owns) and only falls back to the local-development fixture app.
    const appName =
      profile.app_id && profile.app_id.length > 0
        ? profile.app_id
        : fallbackAppId.length > 0
          ? fallbackAppId
          : "local-development-app";
    const key = await ensureClientKeySecret(config, appName, profile.id);
    const clientSecret = await selfMintClientSecret(config, key, { session_id: sessionId });
    const url = new URL("/v1/realtime", config.baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { sessionId, clientSecret, expiresAt: 0, realtimeUrl: url.toString() };
  },
  voiceTools: async (): Promise<ReadonlyArray<VoiceTool>> => sampleClientTools.map(openAiToolDefinition),
  executeVoiceTool: async (name: string, args: unknown): Promise<ToolResult> => {
    try {
      const result = await executeClientToolPromise(sampleClientTools, name, args);
      return { ok: true, operation: name, result };
    } catch (error) {
      return { ok: false, operation: name, error: { recoverable: true, code: "ToolError", message: error instanceof Error ? error.message : String(error) } };
    }
  },
};
};
export type VoiceApi = Omit<ReturnType<typeof createVoiceApi>, "settings" | "avatarDirector" | "sessionInstructions"> & { readonly sessionInstructions?: VoiceInstructions; readonly settings?: VoiceSettingsStore; readonly avatarDirector?: (() => AvatarDirectorClient) | undefined; readonly profileLocked?: boolean };
