# Feature Tour

OpenClaw Web UI is meant to answer a simple question: what is my local agent workspace doing, and what can I safely ask it to do next?

## Dashboard

The dashboard shows the current OpenClaw roster, session counts, task counts, and recent logs. It is the first place to check whether the UI can read the configured workspace.

Useful when:

- You just restarted OpenClaw and want a quick health check.
- You want to jump back into a recent session.
- You want to see whether the app is running in mock or live mode.

## Chat

The chat tab sends messages through the local `openclaw agent` route. It supports:

- Agent selection.
- Streamed status updates.
- Session continuity.
- File attachments.
- Raw run details for debugging.

The UI keeps external actions explicit. It should show what is being sent instead of hiding agent work behind a single magic button.

## Task Board

The task board is a lightweight local queue backed by `data/tasks.json`.

It supports:

- Backlog, todo, in progress, review, blocked, and done lanes.
- Priority and due date fields.
- Manual task runs.
- Optional auto-run mode.
- Result and error summaries on each card.

Runtime task state is ignored by Git so local work does not leak into the repository.

## Memory And Sessions

The memory view helps inspect OpenClaw session logs and workspace memory files.

It supports:

- Session lists per agent.
- Formatted previews.
- Session downloads.
- Agent-level exports.
- Memory file browsing.
- Editing allowed memory files from the browser.

This is one of the sensitive parts of the app. Session logs and memory files can contain private data, so keep the server on loopback.

## Agent Settings

The settings view gives a browser form for common agent configuration fields:

- Name and identity.
- Model.
- Thinking level.
- Fast mode.
- Skills.
- Tool profile and tool allow/deny fields.

The server validates and backs up changes before writing them.

## Swarm Board

The swarm view turns a goal into worker cards. It can map tasks to configured agents, show assignment status, and keep a simple report trail.

It is most useful when your OpenClaw config has multiple worker agents. On a minimal install with only `main`, the route still works, but there are no worker lanes to fill.

## Mock Mode

Mock mode lets contributors work on the UI without a real OpenClaw setup:

```bash
OPENCLAW_WEB_UI_MOCK=1 npm start
```

This is the preferred path for layout changes, screenshots, and quick browser checks.
