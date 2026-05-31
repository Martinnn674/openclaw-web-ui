# Contributing

Thanks for helping improve Claw Space.

## Local Setup

```bash
npm run check
npm start
```

The smoke test runs against a temporary mock OpenClaw home. It should not call real agents.

For live route work, use:

```bash
npm run test:live
```

Run this only against an OpenClaw workspace where temporary task creation is acceptable.

## Pull Requests

- Keep changes focused.
- Run `npm run check`.
- If you touch live OpenClaw routes, explain the manual or live verification you used.
- Do not include tokens, private config files, screenshots with secrets, or personal runtime data.

## Triage

- Bugs should include OS, Node version, OpenClaw version, and whether mock mode reproduces the issue.
- Feature requests should stay tied to local-first OpenClaw workflows.
- See [docs/maintainer-guide.md](docs/maintainer-guide.md) for release and review steps.

## Project Boundaries

This project is a local UI wrapper around an existing OpenClaw installation. It should keep external actions explicit and avoid hiding what an agent is about to do.
