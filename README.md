# OpenClaw Web UI

Local-first web UI for OpenClaw agent chat, task queueing, session export, memory files, agent settings, and a swarm-style control surface.

The app is a small Node/static server that talks to the local `openclaw` CLI and reads from the configured OpenClaw workspace. It is designed for loopback use on a developer machine, not for public internet exposure.

## Features

- Dashboard with agent health, recent sessions, memory activity, and quick actions.
- Chat surface with agent selection, streaming replies, and file attachments.
- Swarm surface for decomposing missions into worker assignments.
- Kanban task board backed by local JSON runtime state.
- Session log preview/export and editable memory files.
- Agent settings editor with validation-oriented server routes.

## Requirements

- Node.js 20 or newer.
- OpenClaw installed and available as `openclaw` on `PATH`.
- An OpenClaw config, usually at `~/.openclaw/openclaw.json`.

## Run

```bash
npm start
```

The server binds to `127.0.0.1:8787` by default.

Open the UI:

```text
http://127.0.0.1:8787
```

Open the swarm surface directly:

```text
http://127.0.0.1:8787/?tab=swarm
```

## Configuration

Environment variables:

- `OPENCLAW_CONFIG`: path to `openclaw.json`.
- `OPENCLAW_BIN`: OpenClaw executable name or path. Defaults to `openclaw`.
- `OPENCLAW_WEB_UI_HOST`: bind host. Defaults to `127.0.0.1`.
- `OPENCLAW_WEB_UI_PORT`: bind port. Defaults to `8787`.
- `OPENCLAW_WEB_UI_DATA_DIR`: runtime data directory. Defaults to `./data`.
- `OPENCLAW_WEB_UI_MOCK=1`: run mock mode for tests and UI development.

## Test

```bash
node --check server.js
node --check public/app.js
npm test
```

The smoke test runs in mock mode against a temporary OpenClaw home and does not call real agents.

Live Gateway check:

```bash
npm run test:live
```

The live test uses your real local OpenClaw environment and may create temporary sessions/tasks that it cleans up.

## Security Notes

This app can read local OpenClaw memory, sessions, and config-adjacent data. Keep it bound to loopback unless you add your own authentication and transport security.

Do not commit `data/tasks.json`, screenshots with private data, OpenClaw config files, or session exports.

## Attribution

The UI incorporates MIT-licensed visual patterns from Hermes Workspace. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
