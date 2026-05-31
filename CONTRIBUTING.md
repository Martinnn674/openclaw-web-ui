# Contributing

Thanks for helping improve OpenClaw Web UI.

## Local Setup

```bash
npm test
npm start
```

The smoke test runs against a temporary mock OpenClaw home. It should not call real agents.

## Pull Requests

- Keep changes focused.
- Run `npm test`.
- If you touch live OpenClaw routes, explain the manual or live verification you used.
- Do not include tokens, private config files, screenshots with secrets, or personal runtime data.

## Project Boundaries

This project is a local UI wrapper around an existing OpenClaw installation. It should keep external actions explicit and avoid hiding what an agent is about to do.
