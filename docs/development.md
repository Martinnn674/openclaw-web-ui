# Development Notes

The project is intentionally plain:

- `server.js` contains the local HTTP server and API routes.
- `public/index.html` is the app shell.
- `public/app.js` contains browser-side behavior.
- `public/styles.css` contains the UI styling.
- `tests/smoke.js` runs the mock-mode route test.
- `tests/live.js` runs against a real OpenClaw workspace.
- `scripts/privacy-audit.js` scans tracked files before release.

There is no build step right now.

## Local Checks

Run the full local check:

```bash
npm run check
```

That runs:

```bash
node --check server.js
node --check public/app.js
npm run audit:privacy
npm test
npm run test:browser
```

The browser smoke check uses Playwright with Chromium. After a fresh install, run:

```bash
npx playwright install chromium
```

## Live Check

Run this only when a real OpenClaw install is available:

```bash
npm run test:live
```

The live test is intentionally adaptive. It supports minimal OpenClaw configs with only `main`, and richer configs with worker agents.

## Release Checklist

```bash
npm run check
npm run test:live
git status --ignored -sb
```

Check that only expected runtime files are ignored:

- `data/tasks.json`
- `*.log`

Then update `CHANGELOG.md`, bump `package.json`, commit, tag, push, and create the GitHub release.

## Design Notes

The UI should stay local, readable, and operational. Prefer clear state and boring controls over decorative complexity.

Good changes:

- Make a route safer.
- Make a local failure easier to understand.
- Add a mock test for a real UI workflow.
- Improve wording around risky actions.
- Keep runtime files out of Git.

Avoid:

- Hosting assumptions.
- Hidden network calls.
- Sending private logs to third-party services.
- Large framework rewrites without a clear reason.
