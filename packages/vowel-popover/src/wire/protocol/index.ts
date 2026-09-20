import { InputAttachments } from "./attachments.ts"
import { voiceEventNames } from "../telemetry/voice"
import * as Effect from "effect/Effect"
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

export const TurnDetection = Schema.Union([
  Schema.Null,
  Schema.Struct({
    create_response: Schema.optional(Schema.Boolean),
    interrupt_response: Schema.optional(Schema.Boolean),
    prefix_padding_ms: Schema.optional(Schema.Number),
    silence_duration_ms: Schema.optional(Schema.Number),
    threshold: Schema.optional(Schema.Number),
    type: Schema.Literal("server_vad")
  })
])
export type TurnDetection = typeof TurnDetection.Type

export const RealtimeFunctionTool = Schema.Struct({
  description: Schema.optional(Schema.String),
  name: Schema.String,
  parameters: Schema.optional(Schema.Unknown),
  type: Schema.Literal("function")
})
export type RealtimeFunctionTool = typeof RealtimeFunctionTool.Type

export const RealtimeToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ name: Schema.String, type: Schema.Literal("function") })
])
export type RealtimeToolChoice = typeof RealtimeToolChoice.Type

export const SessionConfiguration = Schema.Struct({
  modalities: Schema.optional(Schema.Array(Schema.Literals(["text", "audio"])).check(Schema.isMinLength(1))),
  input_audio_format: Schema.optional(Schema.Literals(["pcm16", "g711_ulaw", "g711_alaw"])),
  instructions: Schema.optional(Schema.String),
  coordinator_instructions: Schema.optional(Schema.String),
  initial_actions_prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  worker_instructions: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  output_audio_format: Schema.optional(Schema.Literals(["pcm16", "g711_ulaw", "g711_alaw"])),
  tool_choice: Schema.optional(RealtimeToolChoice),
  tools: Schema.optional(Schema.Array(RealtimeFunctionTool)),
  turn_detection: Schema.optional(TurnDetection),
  voice: Schema.optional(Schema.String)
})
export type SessionConfiguration = typeof SessionConfiguration.Type

export const SessionUpdate = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  session: SessionConfiguration,
  type: Schema.Literal("session.update")
})

export const InputAudioBufferAppend = Schema.Struct({
  audio: Schema.String,
  event_id: Schema.optional(Schema.String),
  type: Schema.Literal("input_audio_buffer.append")
})

export const InputAudioBufferCommit = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  type: Schema.Literal("input_audio_buffer.commit")
})

export const InputAudioBufferClear = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  type: Schema.Literal("input_audio_buffer.clear")
})

export const ConversationItemCreate = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  item: Schema.Unknown,
  type: Schema.Literal("conversation.item.create")
})

export const ConversationItemDelete = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  item_id: Schema.String,
  type: Schema.Literal("conversation.item.delete")
})

export const ConversationItemTruncate = Schema.Struct({
  audio_end_ms: Schema.Number,
  event_id: Schema.optional(Schema.String),
  item_id: Schema.String,
  type: Schema.Literal("conversation.item.truncate")
})

export const ResponseCreate = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  response: Schema.optional(Schema.Unknown),
  type: Schema.Literal("response.create")
})

export const ResponseCancel = Schema.Struct({
  interaction_id: Schema.optional(Schema.String),
  event_id: Schema.optional(Schema.String),
  response_id: Schema.optional(Schema.String),
  type: Schema.Literal("response.cancel")
})

export const VoiceTimelineEvent = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  name: Schema.Literals(voiceEventNames),
  at: Schema.Number,
  clock: Schema.Literals(["client", "server"]),
  estimated: Schema.Boolean,
  uncertaintyMs: Schema.Number,
  attributes: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
})
export const ClientSpeechState = Schema.Struct({ type: Schema.Literal("vowel.input.speech"), active: Schema.Boolean })
export const PlaybackState = Schema.Struct({ type: Schema.Literal("vowel.playback.state"), response_id: Schema.String, state: Schema.Literals(["started", "completed", "interrupted"]) })
export const WorkerCancel = Schema.Struct({ type: Schema.Literal("vowel.worker.cancel") })
export const AudioIdle = Schema.Struct({ type: Schema.Literal("vowel.audio.idle") })
export const VoiceClockPing = Schema.Struct({ type: Schema.Literal("vowel.telemetry.clock"), client_at: Schema.Number })
export const VoiceTurnStart = Schema.Struct({ type: Schema.Literal("vowel.telemetry.turn.start"), client_turn_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)) })
export const VoiceClientEvents = Schema.Struct({
  type: Schema.Literal("vowel.telemetry.client"),
  interaction_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  events: Schema.Array(VoiceTimelineEvent).check(Schema.isMaxLength(64)),
})

export const ClientRealtimeEvent = Schema.Union([
  InputAttachments, PlaybackState, ClientSpeechState, WorkerCancel, AudioIdle, VoiceClockPing, VoiceTurnStart, VoiceClientEvents,
  SessionUpdate,
  InputAudioBufferAppend,
  InputAudioBufferCommit,
  InputAudioBufferClear,
  ConversationItemCreate,
  ConversationItemDelete,
  ConversationItemTruncate,
  ResponseCreate,
  ResponseCancel
])
export type ClientRealtimeEvent = typeof ClientRealtimeEvent.Type

const EventId = Schema.String.check(Schema.isMinLength(1))

export const ConversationItem = Schema.Struct({
  arguments: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  id: Schema.String,
  name: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(["assistant", "system", "user"])),
  status: Schema.optional(Schema.Literals(["completed", "in_progress", "incomplete"])),
  type: Schema.String
})

export const ErrorEvent = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.String),
    event_id: Schema.optional(Schema.String),
    message: Schema.String,
    param: Schema.optional(Schema.String),
    type: Schema.String
  }),
  event_id: EventId,
  type: Schema.Literal("error")
})

export const SessionCreated = Schema.Struct({
  event_id: EventId,
  session: SessionConfiguration,
  type: Schema.Literal("session.created")
})

export const SessionUpdated = Schema.Struct({
  event_id: EventId,
  session: SessionConfiguration,
  type: Schema.Literal("session.updated")
})

export const ConversationItemCreated = Schema.Struct({
  event_id: EventId,
  item: ConversationItem,
  previous_item_id: Schema.optional(Schema.String),
  type: Schema.Literal("conversation.item.created")
})

export const ConversationItemDeleted = Schema.Struct({
  event_id: EventId,
  item_id: Schema.String,
  type: Schema.Literal("conversation.item.deleted")
})

export const InputAudioBufferCommitted = Schema.Struct({
  event_id: EventId,
  item_id: Schema.String,
  type: Schema.Literal("input_audio_buffer.committed")
})

export const InputAudioBufferSpeechStarted = Schema.Struct({
  audio_start_ms: Schema.Number,
  event_id: EventId,
  item_id: Schema.String,
  type: Schema.Literal("input_audio_buffer.speech_started")
})

export const InputAudioBufferSpeechStopped = Schema.Struct({
  audio_end_ms: Schema.Number,
  event_id: EventId,
  item_id: Schema.String,
  type: Schema.Literal("input_audio_buffer.speech_stopped")
})

export const InputAudioBufferTranscriptionCompleted = Schema.Struct({
  event_id: EventId,
  item_id: Schema.String,
  transcript: Schema.String,
  type: Schema.Literal("conversation.item.input_audio_transcription.completed")
})

export const ResponseCreated = Schema.Struct({
  question_id: Schema.optional(Schema.String),
  speech_kind: Schema.optional(Schema.Literals(["answer", "filler"])),
  coordinator_decision_id: Schema.optional(Schema.String),
  speech_id: Schema.optional(Schema.String),
  job_ids: Schema.optional(Schema.Array(Schema.String)),
  job_id: Schema.optional(Schema.String),
  worker_status: Schema.optional(Schema.Literals(["progress", "completed", "failed"])),
  interaction_id: Schema.optional(Schema.String),
  event_id: EventId,
  response: Schema.Struct({ id: Schema.String, status: Schema.String }),
  type: Schema.Literal("response.created")
})

export const ResponseTextDelta = Schema.Struct({
  delta: Schema.String,
  event_id: EventId,
  item_id: Schema.String,
  output_index: Schema.Number,
  response_id: Schema.String,
  type: Schema.Literal("response.text.delta")
})

export const ResponseTextDone = Schema.Struct({
  event_id: EventId,
  item_id: Schema.String,
  output_index: Schema.Number,
  response_id: Schema.String,
  text: Schema.String,
  type: Schema.Literal("response.text.done")
})

export const ResponseAudioDelta = Schema.Struct({
  delta: Schema.String,
  event_id: EventId,
  item_id: Schema.String,
  output_index: Schema.Number,
  response_id: Schema.String,
  type: Schema.Literal("response.audio.delta")
})

export const ResponseAudioTranscriptDelta = Schema.Struct({
  delta: Schema.String,
  event_id: EventId,
  item_id: Schema.String,
  output_index: Schema.Number,
  response_id: Schema.String,
  type: Schema.Literal("response.audio_transcript.delta")
})

export const ResponseFunctionCallArgumentsDone = Schema.Struct({
  job_id: Schema.optional(Schema.String),
  arguments: Schema.String,
  call_id: Schema.String,
  event_id: EventId,
  item_id: Schema.String,
  name: Schema.String,
  output_index: Schema.Number,
  response_id: Schema.String,
  type: Schema.Literal("response.function_call_arguments.done")
})

export const ResponseOutputItemAdded = Schema.Struct({
  event_id: EventId,
  item: ConversationItem,
  output_index: Schema.Number,
  response_id: Schema.String,
  type: Schema.Literal("response.output_item.added")
})

export const ResponseFunctionCallStarted = Schema.Struct({
  call_id: Schema.String,
  event_id: EventId,
  name: Schema.String,
  response_id: Schema.String,
  type: Schema.Literal("response.function_call.started")
})

export const ResponseDone = Schema.Struct({
  event_id: EventId,
  response: Schema.Struct({ id: Schema.String, status: Schema.String }),
  type: Schema.Literal("response.done")
})

export const TelemetryPhase = Schema.Literals(["input", "model", "output", "tool", "error"])

export const VowelTelemetryInteractionStarted = Schema.Struct({
  question_id: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["decision", "worker", "speech", "filler"])),
  correlation_id: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.String),
  client_turn_id: Schema.optional(Schema.String),
  event_id: EventId,
  input: Schema.String,
  interaction_id: Schema.String,
  started_at: Schema.Number,
  type: Schema.Literal("vowel.telemetry.interaction.started")
})

export const VowelTelemetrySpanCompleted = Schema.Struct({
  question_id: Schema.optional(Schema.String),
  span_id: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  detail: Schema.optional(Schema.String),
  duration_ms: Schema.Number,
  event_id: EventId,
  interaction_id: Schema.String,
  label: Schema.String,
  phase: TelemetryPhase,
  started_at: Schema.Number,
  type: Schema.Literal("vowel.telemetry.span.completed")
})

export const VowelTelemetryInteractionCompleted = Schema.Struct({
  question_id: Schema.optional(Schema.String),
  estimated_cost_usd: Schema.Number,
  event_id: EventId,
  interaction_id: Schema.String,
  outcome: Schema.Literals(["error", "success"]),
  type: Schema.Literal("vowel.telemetry.interaction.completed"),
  usage: Schema.Struct({
    llm_input_tokens: Schema.Number,
    llm_output_tokens: Schema.Number,
    stt_duration_ms: Schema.Number,
    tts_characters: Schema.Number
  })
})

export const VoiceClockReply = Schema.Struct({ type: Schema.Literal("vowel.telemetry.clock"), event_id: EventId, client_at: Schema.Number, server_at: Schema.Number })
export const VoiceServerEvent = Schema.Struct({ type: Schema.Literal("vowel.telemetry.event"), event_id: EventId, interaction_id: Schema.String, event: VoiceTimelineEvent })

export const CoordinatorStateEvent = Schema.Struct({
  type: Schema.Literal("vowel.coordinator.state"), event_id: EventId,
  phase: Schema.Literals(["thinking", "speaking", "waiting", "idle"]),
  pending_jobs: Schema.Number, pending_speech: Schema.Boolean, next_wake_at: Schema.optional(Schema.Number),
})

export const WorkerStatusEvent = Schema.Struct({
  type: Schema.Literal("vowel.worker.status"), event_id: EventId,
  job_id: Schema.String, query: Schema.String, agent_id: Schema.optional(Schema.String), parent_job_id: Schema.optional(Schema.String),
  status: Schema.Literals(["started", "progress", "completed", "failed", "cancelled"]),
  message: Schema.String,
})

export const ServerRealtimeEvent = Schema.Union([
  CoordinatorStateEvent, WorkerStatusEvent, VoiceClockReply, VoiceServerEvent,
  ErrorEvent,
  SessionCreated,
  SessionUpdated,
  ConversationItemCreated,
  ConversationItemDeleted,
  InputAudioBufferCommitted,
  InputAudioBufferSpeechStarted,
  InputAudioBufferSpeechStopped,
  InputAudioBufferTranscriptionCompleted,
  ResponseCreated,
  ResponseTextDelta,
  ResponseTextDone,
  ResponseAudioDelta,
  ResponseAudioTranscriptDelta,
  ResponseOutputItemAdded,
  ResponseFunctionCallStarted,
  ResponseFunctionCallArgumentsDone,
  ResponseDone,
  VowelTelemetryInteractionStarted,
  VowelTelemetrySpanCompleted,
  VowelTelemetryInteractionCompleted
])
export type ServerRealtimeEvent = typeof ServerRealtimeEvent.Type

export class ProtocolDecodeError extends Data.TaggedError("ProtocolDecodeError")<{
  readonly message: string
}> {}

export const decodeClientRealtimeEvent = (value: unknown) =>
  Schema.decodeUnknownEffect(ClientRealtimeEvent)(value).pipe(
    Effect.mapError((error) => new ProtocolDecodeError({ message: error.message }))
  )

export const encodeClientRealtimeEvent = Schema.encodeEffect(ClientRealtimeEvent)
export const decodeServerRealtimeEvent = Schema.decodeUnknownEffect(ServerRealtimeEvent)
export const encodeServerRealtimeEvent = Schema.encodeEffect(ServerRealtimeEvent)

export const decodeClientRealtimeEventJson = (wire: string) =>
  Effect.try({
    try: () => JSON.parse(wire) as unknown,
    catch: (cause) => new ProtocolDecodeError({ message: `Invalid JSON: ${String(cause)}` })
  }).pipe(Effect.flatMap(decodeClientRealtimeEvent))

export const encodeServerRealtimeEventJson = (event: ServerRealtimeEvent) =>
  encodeServerRealtimeEvent(event).pipe(Effect.map(JSON.stringify))
