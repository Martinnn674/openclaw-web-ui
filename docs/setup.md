# Setup Guide

This app is a local Node server. It serves the static UI and calls your local OpenClaw CLI from server routes.

## Requirements

- Node.js 20 or newer.
- Git.
- A working OpenClaw install.
- An OpenClaw config file, usually at `~/.openclaw/openclaw.json`.

Check the basics:

```bash
node --version
openclaw --version
openclaw config validate
```

## Install

```bash
git clone https://github.com/Martinnn674/claw-space.git
cd claw-space
npm install
```

The app uses Node's built-in HTTP, filesystem, crypto, and child process modules at runtime. It also installs Playwright as a dev dependency for the standard browser smoke check.

## Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

The default bind address is loopback only.

If you plan to run the full local checks on a fresh machine, install the Playwright browser once:

```bash
npx playwright install chromium
```

## Common Environment Variables

```bash
OPENCLAW_BIN=/path/to/openclaw
OPENCLAW_CONFIG=/path/to/openclaw.json
OPENCLAW_WEB_UI_HOST=127.0.0.1
OPENCLAW_WEB_UI_PORT=8787
OPENCLAW_WEB_UI_DATA_DIR=./data
OPENCLAW_WEB_UI_MOCK=1
```

What they do:

- `OPENCLAW_BIN`: executable name or full path for the OpenClaw CLI.
- `OPENCLAW_CONFIG`: config file to read.
- `OPENCLAW_WEB_UI_HOST`: host to bind. Keep this as `127.0.0.1` for normal use.
- `OPENCLAW_WEB_UI_PORT`: port to bind.
- `OPENCLAW_WEB_UI_DATA_DIR`: directory for local runtime task state.
- `OPENCLAW_WEB_UI_MOCK`: set to `1` to run without a real OpenClaw install.

## Windows And WSL

If OpenClaw is installed inside WSL, run the UI from WSL too:

```bash
cd /path/to/claw-space
OPENCLAW_BIN=/path/to/openclaw npm start
```

Then open `http://127.0.0.1:8787` from Windows. WSL usually forwards loopback ports automatically.

If you run the UI from Windows while OpenClaw only exists in WSL, the server will not be able to execute the Linux `openclaw` binary. Use mock mode on Windows or run the server inside WSL.

## Mock Mode

Mock mode is useful for UI work and smoke tests:

```bash
OPENCLAW_WEB_UI_MOCK=1 npm start
```

It creates a small in-memory-style fixture with `main` and `coder` agents and returns mock chat replies. It should not call real agents.

## Live Test

Run this only when you want to test against your real OpenClaw workspace:

```bash
npm run test:live
```

The live test checks routes that read sessions, memory, tasks, chat, and swarm data. It creates temporary tasks and cleans them up.

## Troubleshooting

`openclaw` is not found:

```bash
OPENCLAW_BIN=/full/path/to/openclaw npm start
```

Config cannot be read:

```bash
OPENCLAW_CONFIG=/full/path/to/openclaw.json npm start
```

Port is busy:

```bash
OPENCLAW_WEB_UI_PORT=8788 npm start
```

Dashboard shows no workers:

Your OpenClaw config may only define the main agent. Chat and session browsing can still work; swarm views become more useful once worker agents are configured.
