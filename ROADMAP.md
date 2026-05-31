# Roadmap

OpenClaw Web UI is early and intentionally local-first. The project is useful today for inspecting an OpenClaw workspace, but the maintainer focus is still stability, privacy, and predictable local workflows before larger integrations.

## Current Focus

- Keep the default server loopback-only and make the local security posture visible in the UI.
- Improve setup paths for Windows, WSL, and mock-mode development.
- Keep tracked files free of local paths, tokens, private source packs, and runtime logs.
- Expand smoke tests around dashboard, task, memory, session, and swarm routes.

## Next

- Add richer live-test fixtures for multi-agent OpenClaw installs without making them mandatory.
- Add screenshot-based UI smoke checks for desktop and mobile dashboard layouts.
- Add a read-only mode for users who only want to inspect sessions and memory.
- Document a small plugin surface for custom dashboard panels.

## Later

- Add optional authentication guidance for people who deliberately bind outside loopback.
- Add import/export helpers for task board and swarm plans.
- Add accessibility checks for keyboard navigation and high-contrast themes.

## Out Of Scope

- Hosted multi-user dashboards.
- Cloud sync of OpenClaw memory or session logs.
- Hidden or automatic external actions from agents.
