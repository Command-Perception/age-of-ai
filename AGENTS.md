# AGENTS.md — age-of-ai

Project rules for coding agents working in this repository.

## Canonical local development environment

This project has exactly one long-lived development environment: the tmux
session **`age-of-ai`**. Never run the application as a bare background
process, under `nohup`, or in a second project session. Reuse the existing
session before starting or restarting services, and inspect a process before
interrupting it.

```sh
tmux has-session -t age-of-ai 2>/dev/null || \
  tmux new-session -d -s age-of-ai -n dev -c /srv/store/Shared/Development/cmdpr/age-of-ai
tmux has-session -t age-of-ai:dev 2>/dev/null || \
  tmux new-window -t age-of-ai -n dev -c /srv/store/Shared/Development/cmdpr/age-of-ai

tmux list-windows -t age-of-ai
tmux capture-pane -t age-of-ai:dev -p -S -100
```

Keep the canonical session available for the next agent. Kill it only when
explicitly requested or during a deliberate clean restart.

## Local dev servers

The client is served through Portless and the WebSocket server runs on port
18081 in this workspace because ports 8080 and 8081 are already reserved by
other local services. Long-lived processes belong in the `age-of-ai:dev`
window:

```sh
tmux send-keys -t age-of-ai:dev "AGE_OF_AI_SERVER_PORT=18081 PORT=18081 npm run dev:server" Enter
tmux send-keys -t age-of-ai:dev "portless age-of-ai --app-port 5199 npm run dev -w client" Enter
```

The canonical client URL is:

- **https://age-of-ai.localhost**

The client’s Vite proxy forwards `/ws` to the authoritative server on
`localhost:18081`; do not create a second public WebSocket route or invent a
different local domain. Check the existing session and Portless routes before
starting anything:

```sh
portless list
portless doctor
tmux capture-pane -t age-of-ai:dev -p -S -100
```

If a route is stale, use `portless list`, `portless doctor`, and
`portless prune` as needed. Do not use broad `pkill` commands that could
terminate another project’s services.

## Verification

Use the running application for manual acceptance checks. The repository also
provides `npm run typecheck` and `npm run build`; do not add or run automated
tests unless the project owner explicitly requests them.
