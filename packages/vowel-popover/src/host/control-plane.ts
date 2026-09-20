export interface Config {
  readonly apiKey: string;
  readonly baseURL: string;
}

export interface RecordItem {
  readonly stt_provider?: string;
  readonly llm_provider?: string;
  readonly tts_provider?: string;
  readonly reasoning_effort?: string;
  readonly execution_mode?: string;
  readonly router_provider?: string;
  readonly router_model?: string;
  readonly router_reasoning_effort?: string;
  readonly filler_enabled?: number;
  readonly filler_delay_ms?: number;
  readonly filler_provider?: string;
  readonly filler_model?: string;

  readonly allowed_origins?: ReadonlyArray<string>;
  readonly app_id?: string;
  readonly app_name?: string;
  readonly base_url?: string | null;
  readonly created_at: number;
  readonly default_profile_id?: string | null;
  readonly id: string;
  readonly is_default?: number | boolean;
  readonly kind?: "client" | "server";
  readonly llm_credential_id?: string;
  readonly model?: string | null;
  readonly name?: string | null;
  readonly prefix?: string;
  readonly profile_id?: string | null;
  readonly profile_name?: string | null;
  readonly provider?: string;
  readonly revoked_at?: number | null;
  readonly stt_credential_id?: string;
  readonly tts_credential_id?: string;
  readonly voice?: string;
}

export const localAdminKey = import.meta.env.VITE_LOCAL_ADMIN_API_KEY ?? "";

const request = async (
  config: Config,
  path: string,
  init: RequestInit = {},
) => {
  const response = await fetch(new URL(path, config.baseURL), {
    ...init,
    credentials: "include",
    headers: {
      ...(config.apiKey.length === 0 ? {} : { Authorization: `Bearer ${config.apiKey}` }),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  return response;
};

export const api = async <A,>(
  config: Config,
  path: string,
  init: RequestInit = {},
): Promise<A> => {
  const response = await request(config, path, init);
  return response.status === 204
    ? (undefined as A)
    : ((await response.json()) as A);
};

export const apiStream = async (config: Config, path: string, init: RequestInit = {}) => {
  const response = await request(config, path, init);
  if (!response.body) throw new Error("No audio stream received");
  return response.body;
};

export const apiBlob = async (
  config: Config,
  path: string,
  init: RequestInit = {},
) => (await request(config, path, init)).blob();

/**
 * Finds (or creates) an active client key for the app and returns its secret, so browser-side
 * test sessions can self-mint ephemeral credentials exactly like an approved end-user origin.
 */
export const ensureClientKeySecret = async (
  config: Config,
  appId: string,
  profileId: string,
): Promise<string> => {
  const { data } = await api<{ readonly data: ReadonlyArray<RecordItem> }>(
    config,
    `/v1/api-keys?app_id=${encodeURIComponent(appId)}`,
  );
  const existing = data.find(
    (key) => key.kind === "client" && key.profile_id === profileId,
  );
  if (existing !== undefined) {
    try {
      const revealed = await api<{ readonly secret: string }>(
        config,
        `/v1/api-keys/${existing.id}/secret`,
      );
      return revealed.secret;
    } catch {
      // Stored copy unretrievable (legacy key); mint a fresh client key below.
    }
  }
  const created = await api<{ readonly secret?: string }>(config, "/v1/api-keys", {
    body: JSON.stringify({
      app_id: appId,
      kind: "client",
      profile_id: profileId,
    }),
    method: "POST",
  });
  if (created.secret === undefined)
    throw new Error("Client key creation did not return a secret");
  return created.secret;
};

/** Mints an ephemeral credential from the browser using a client key (self-minting pattern). */
export const selfMintClientSecret = async (
  config: Config,
  clientKeySecret: string,
  body: { readonly profile_id?: string; readonly session_id: string },
): Promise<string> => {
  const response = await fetch(
    new URL("/v1/realtime/client_secrets", config.baseURL),
    {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${clientKeySecret}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  if (!response.ok)
    throw new Error(
      `Self-mint failed (${response.status}): ${await response.text()}`,
    );
  return ((await response.json()) as { readonly client_secret: string })
    .client_secret;
};
