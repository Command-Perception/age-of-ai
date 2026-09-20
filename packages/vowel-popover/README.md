# @vowel/vowel-popover

The complete Vowel voice popover — UI, mic capture, client-side Silero VAD,
PCM playback, realtime wire client, and telemetry waterfall — in one package.

## Contents

- `src/` — popover modules (entry: `src/index.ts`; React component: `VowelOverlay`).
- `src/components/ui/` — vendored shadcn components the popover uses (button, tooltip,
  popover, dialog, command, field, input-group + transitive input/textarea/label/separator).
- `src/lib/` — `utils.ts` (cn) + `notify.ts` (sonner toasts) needed by the vendored UI.
- `src/host/` — vendored `control-plane.ts` (HTTP session minting) and client tools.
- `src/wire/` — vendored protocol (`protocol/`) and voice telemetry (`telemetry/`) sources
  the adapter speaks.
- `assets/vad/` — Silero ONNX + vad-web worklet bundle; the host copies these to
  `<site>/vad/` so the client can fetch them same-origin (see `apps/admin/vite.config.ts`).

## Use in another project

1. Copy this folder into your tree (or link the workspace) and install the deps in
   `package.json`.
2. Copy the `/vad/` asset copying block from `apps/admin/vite.config.ts` (or serve
   `assets/vad/` from your public dir).
3. Render `<VowelOverlay />` and pass `createVoiceApi(...)` — the admin's flow is the
   reference implementation in `src/main.tsx` (host wires config + session profile).

## Tailwind

Classes rely on the `packages/ui` design tokens (tw-animate-css, shimmer, etc.); import
`@vowel/ui/globals.css` (or copy it) so styling resolves.
