/** Optional output-only bridge to an avtrs Director deployment. */
export interface AvatarDirectorClient {
  start(): Promise<void>
  userTranscript(text: string): Promise<void>
  assistantTranscript(text: string): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Session = { readonly id: string; readonly eventsUrl: string }

const request = async (fetcher: Fetch, url: URL, init: RequestInit): Promise<Response> => {
  const response = await fetcher(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } })
  if (!response.ok) throw new Error(`Avatar Director request failed (${response.status})`)
  return response
}

/**
 * The Director is deliberately a sidecar: it consumes completed conversation
 * events and never acquires a microphone, sends text to Vowel, or owns tools.
 */
export const createAvatarDirectorClient = (options: { readonly baseURL: string; readonly fetch?: Fetch }): AvatarDirectorClient => {
  const baseURL = new URL(options.baseURL)
  const fetcher = options.fetch ?? fetch
  let session: Session | undefined
  let starting: Promise<void> | undefined
  let closed = false

  const start = async () => {
    if (closed || session) return
    if (starting) return starting
    starting = request(fetcher, new URL("/v1/avatar/sessions", baseURL), { method: "POST" })
      .then(async (response) => { session = await response.json() as Session })
      .finally(() => { starting = undefined })
    return starting
  }
  const event = async (body: unknown) => {
    await start()
    if (!session || closed) return
    await request(fetcher, new URL(session.eventsUrl, baseURL), { body: JSON.stringify(body), method: "POST" })
  }

  return {
    start,
    userTranscript: (text) => text.trim() ? event({ _tag: "TranscriptFinal", text: text.trim() }) : Promise.resolve(),
    assistantTranscript: (text) => text.trim() ? event({
      _tag: "SemanticBeatReady",
      beat: {
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        text: text.trim(),
        purpose: "answer",
        importance: "normal",
        estimatedSpeechMs: Math.max(500, text.trim().split(/\s+/).length * 330),
      },
    }) : Promise.resolve(),
    interrupt: () => event({ _tag: "UserInterrupted", at: Date.now() }),
    close: async () => {
      if (closed) return
      await start()
      if (session) await request(fetcher, new URL(session.eventsUrl, baseURL), { body: JSON.stringify({ _tag: "SessionClosed" }), method: "POST" })
      closed = true
    },
  }
}
