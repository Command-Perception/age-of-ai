# Vowel popup UI: current implementation

This document describes the Vowel conversation popup implemented in the
`vowel-cloudflare` Admin application. It is a source guide for the popup only;
it does not describe the Admin resource pages, the historical telemetry page,
or an external application integration.

The implementation lives in this checkout. All paths below are relative to the
`vowel-cloudflare` repository root.

## Entry point and lifecycle

`apps/admin/src/main.tsx` owns the popup mount and the sidebar launcher.

| Concern | Current implementation |
| --- | --- |
| Availability | The Vowel sidebar button opens the popup only after a session profile is selected. Otherwise it navigates to Session Profiles. |
| Mount | `VowelOverlay` receives the profile-bound `VoiceApi`, `open`, and `onClose`. It is keyed by profile, base URL, and API key so an Admin connection/profile change creates a clean runtime. |
| Runtime | `VowelOverlay` creates one assistant-ui local runtime and registers one `VowelRealtimeAdapter` as its `voice` adapter. `AssistantRuntimeProvider`, human-tool UIs, the transcript, typed input, and the microphone all share that runtime. |
| Close | Hiding the popup leaves the Admin shell usable. Disconnecting a voice session tears down microphone capture, Web Audio playback, socket work, attachment delivery, and live mic state. |

The popup is not a separate app or iframe. It runs inside the Admin React tree
and uses the Admin connection configuration plus the selected session profile.

## Source map

| File | Responsibility |
| --- | --- |
| `apps/admin/src/voice/vowel-overlay.tsx` | Fixed popup chrome, draggable/resizable layout, folds, controls, attachment queue, typed composer, and runtime provider. |
| `apps/admin/src/voice/vowel-adapter.ts` | Live microphone/WebSocket session, realtime events, audio output, barge-in, cancellation, and voice telemetry. |
| `apps/admin/src/voice/voice-panel.tsx` | Typed Vowel chat model and human approval UI for mutation tools. |
| `apps/admin/src/voice/voice-thread.tsx` | assistant-ui thread renderer. |
| `apps/admin/src/voice/microphone.ts` | Browser capture, resampling/PCM conversion, shared live microphone state, and local interruption signal. |
| `apps/admin/src/voice/pcm16-playback.ts` | 24 kHz PCM playback and interruption-safe buffer handling. |
| `apps/admin/src/voice/attachments.ts` and `voice-attachment-sender.ts` | Image/PDF attachment validation, preview state, encoding, and delivery with the next turn. |
| `apps/admin/src/voice/voice-settings.tsx` and `voice-settings-store.ts` | Popup session-profile switcher, voice picker, favorites, and audio preview. |
| `apps/admin/src/voice/telemetry*.tsx`, `telemetry.ts`, and `voice-timeline.ts` | Popup telemetry fold, live trace persistence, and responsiveness timeline. |
| `apps/admin/src/voice/use-overlay-layout.ts` | Pointer and keyboard move/resize behavior with a reset action. |

## Popup layout and controls

`VowelOverlay` is a fixed, top-centred window (`z-50`) with a bounded viewport
height. It remains non-modal: the Admin application below it is still usable.
The window has an accessible drag handle and a resize handle when a fold,
settings, or the composer is open. Both support keyboard movement/resizing and
Home resets the layout.

| UI element | Behavior |
| --- | --- |
| Microphone button | Starts or stops the assistant-ui voice session. Its glow and live meter use the shared microphone store. |
| Status text | Shows the most recent assistant text, active tool/reasoning state, connection/microphone errors, or the current listening/thinking state. |
| Conversation button | Shows or hides the transcript fold. |
| Telemetry button | Shows or hides the session responsiveness fold. Conversation and telemetry are mutually exclusive. |
| Settings button | Opens the popup’s profile/voice configuration section. Switching profile disconnects the active voice session. |
| Attach button | Opens the file picker; files may also be dragged onto the popup. Queued files are previewed and can be removed before sending. |
| Keyboard button | Shows the typed composer independently of the conversation/telemetry fold. |
| Close button | Hides the popup through the Admin owner. |

Inactive conversation, telemetry, and composer folds are `aria-hidden` and
`inert`. The composer focuses shortly after opening. Enter sends a message;
Shift+Enter adds a newline. The send action is disabled while a model response
or attachment preparation is in progress.

## Conversation behavior

### Voice

`VowelRealtimeAdapter` mints a profile-bound ephemeral client secret through
the Admin’s authenticated self-minting flow, opens `/v1/realtime`, then sends a
`session.update` with the test-assistant instructions and client tool catalog.
It captures microphone audio, sends Vowel input events, receives server events,
and schedules 24 kHz PCM output through Web Audio.

The adapter owns the safety-critical lifetime:

- microphone capture starts before the connection settles so permission failure
  is visible promptly;
- local speech can interrupt scheduled playback and emits `response.cancel`;
- socket closure, abort, or microphone error closes capture, playback, timers,
  input delivery, and subscriptions;
- audio PCM handling preserves odd trailing bytes between messages;
- provider/server events and local timing observations feed live telemetry.

The popup supports the configured VAD mode and client-side endpointing where
the selected session requires it. The microphone implementation must remain
the single capture source—do not add a second microphone or a second
`response.create` path when changing the UI.

### Typed messages

The typed composer uses `vowelChatModel` in `voice-panel.tsx`, not a direct
model-provider request. Each typed turn mints a short-lived Vowel session,
opens the same realtime WebSocket contract, sends
`conversation.item.create` and `response.create`, and streams assistant text
into the assistant-ui thread. It can run without microphone permission.

Both voice and typed paths use the Admin sample client-tool catalog. Tools are
executed through `executeSocketTool`; tools declared in `HUMAN_VOICE_TOOLS`
render an explicit Approve/Decline card. The UI never reports a mutation as
successful unless its tool result is `ok: true`.

## Attachments

The popup accepts the MIME types declared by `ATTACHMENT_ACCEPT`: supported
images, PDFs, and text/code inputs (including common structured-data and source
file extensions). A reservation protects queued files while a typed or voice
turn is prepared: success commits the reservation; failure restores it to the
queue. Attachments associate with their transcript message after the turn is
created.

Treat the attachment store as popup-local state. It validates and previews
inputs before transmission, but it is not a persistent document store.

## Popup settings

The settings fold is available when `VoiceApi.settings` is present. It provides:

- a searchable session-profile picker;
- a provider-backed searchable voice picker;
- profile-local selected voice and favorites in `localStorage`, bucketed by TTS
  provider so incompatible provider catalogs do not mix;
- streaming 24 kHz voice preview with Stop, error feedback, and cleanup;
- provider compatibility checks for favorites.

The persisted selection is a UI preference, not a provider credential. Provider
credentials and session-profile settings remain in the Vowel control plane.

## Telemetry fold

The popup telemetry fold is a responsiveness view, not the Admin’s historical
analytics page. It follows the current Vowel session and shows timestamped
voice traces/timelines. It can expand to `/telemetry`, where the same live
client-side trace store is shown in its full-page form.

| Capability | Current behavior |
| --- | --- |
| Live traces | Client events and `vowel.telemetry.*` server events merge into question/interaction cards. |
| Responsiveness | The timeline records turn, VAD, STT, LLM, TTS, playback, and barge-in milestones when available. |
| Scope | Coordinator, background-worker, answer-delivery, and filler-delivery interactions remain distinguishable. |
| Display | The popup can hide individual/all responsiveness cards, expand/collapse spans, and follows the latest measurement. |
| Persistence | Trace data and hidden-card preferences use browser storage; they remain available across reconnects and page reloads until cleared. |
| Clear | Clearing popup telemetry clears the live trace and voice timeline stores, not server-side historical interaction records. |

Do not replace this store with the server telemetry API. The full Admin
Telemetry view is a separate historical/usage surface. The popup needs local
event timing so it can show work before server-side aggregation completes.

## Accessibility and UI constraints

- Keep the popup non-modal; do not add a page-blocking backdrop.
- Preserve accessible labels, pressed/expanded state, status and alert regions,
  `inert` inactive folds, and keyboard move/resize controls.
- Preserve reduced-motion behavior in the shared UI styles.
- Keep error states actionable: unavailable configuration, mint failure,
  microphone denial, attachment failure, and socket failure must leave typed
  interaction or recovery actions visible when possible.
- Keep microphone activity in the shared store so the sidebar launcher and
  popup reflect one source of truth.

## Verification checklist

1. Select a session profile, open the sidebar Vowel launcher, then move, resize,
   reset, and close the popup with pointer and keyboard controls.
2. Verify microphone permission, live meter, a voice turn, barge-in playback
   interruption, disconnect cleanup, and a denied-microphone typed fallback.
3. Send typed text; verify streamed assistant output and that no microphone
   permission is requested.
4. Queue, remove, and send a supported image/PDF; verify an invalid attachment
   produces an inline error without losing valid queued files.
5. Exercise a regular client tool and an approval-required tool; Approve and
   Decline must produce correct status and telemetry.
6. Switch profile while connected and confirm the current voice connection is
   torn down before the new profile is used.
7. Check the popup telemetry fold, hide/undo a card, expand to `/telemetry`,
   reload, and clear live telemetry. Confirm historical Admin telemetry was not
   cleared.

## Focused regression tests

Keep the popup’s existing targeted tests aligned with changes:

- `vowel-adapter*.test.ts`, `microphone*.test.ts`,
  `pcm16-playback.test.ts`, and `silence-commit.test.ts` for voice/audio
  lifecycle and cancellation;
- `attachments.test.ts` and `voice-panel.test.ts` for attachments and typed
  conversation/tool behavior;
- `telemetry.test.ts`, `vowel-server-telemetry.test.ts`, and
  `voice-timeline.test.ts` for trace merging and responsiveness measurements;
- `overlay-geometry.test.ts` for popup move/resize bounds;
- `voice-settings-store.test.ts` for selection/favorites persistence.
