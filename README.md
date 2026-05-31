# OpenClaw Web UI

[![CI](https://github.com/Martinnn674/openclaw-web-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/Martinnn674/openclaw-web-ui/actions/workflows/ci.yml)

OpenClaw Web UI is a small local control panel for an OpenClaw workspace. It runs on your machine, talks to the `openclaw` CLI, and gives you a browser view for chat, tasks, sessions, memory files, agent settings, and swarm-style work planning.

It is built for loopback use on a developer machine. It is not a hosted dashboard, and it should not be exposed to the public internet without adding your own authentication layer.

## What You Get

- A dashboard for agent health, recent sessions, task counts, and workspace activity.
- Agent chat with streaming output, session continuity, and file attachments.
- A Kanban board for local task queueing and one-click task runs.
- Session log browsing, previews, exports, and memory file editing.
- Agent settings views for identity, model, thinking level, fast mode, skills, and tools.
- A swarm board for splitting a goal into worker lanes and tracking each assignment.
- Mock mode for UI development without calling real agents.

## Quick Start

Requirements:

- Node.js 20 or newer.
- OpenClaw installed locally.
- An OpenClaw config, usually `~/.openclaw/openclaw.json`.

```bash
git clone https://github.com/Martinnn674/openclaw-web-ui.git
cd openclaw-web-ui
npm start
```

Open:

```text
http://127.0.0.1:8787
```

If `openclaw` is not on your `PATH`, point the UI at it:

```bash
OPENCLAW_BIN=/path/to/openclaw npm start
```

For UI work without a real OpenClaw install:

```bash
OPENCLAW_WEB_UI_MOCK=1 npm start
```

## Docs

- [Setup guide](docs/setup.md)
- [Feature tour](docs/feature-tour.md)
- [Development notes](docs/development.md)
- [Maintainer guide](docs/maintainer-guide.md)
- [Privacy checklist](docs/privacy-checklist.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)

## Safety Notes

The app reads local OpenClaw memory, session logs, and config-adjacent data. Keep it on `127.0.0.1` unless you know exactly what you are doing.

Before releases, run:

```bash
npm run check
```

That includes syntax checks, the tracked-file privacy audit, and the mock smoke test.

## Status

Early, usable, and intentionally small. The current focus is keeping local agent work easier to inspect without turning OpenClaw into a cloud service. Maintenance work is tracked through GitHub issues, the [roadmap](ROADMAP.md), and release notes.

## Attribution

The UI incorporates MIT-licensed visual patterns from Hermes Workspace. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
