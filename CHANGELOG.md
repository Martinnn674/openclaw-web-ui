# Changelog

## 0.1.2 - 2026-05-31

- Added `npm run audit:privacy` to scan tracked files for local path leaks, private source-pack filenames, and token-shaped secrets.
- Added the privacy audit to CI.
- Documented the privacy audit in the README.

## 0.1.1 - 2026-05-31

- Redacted absolute local config paths from `/api/health`.
- Added smoke/live assertions that the health endpoint does not expose `configPath`.
- Updated security notes to document the sanitized health response.
- Changed the license copyright holder to the GitHub project/contributors.

## 0.1.0 - 2026-05-31

- Initial public release.
- Added dashboard, chat, memory/session views, task board, and swarm workflow routes.
- Added mock smoke tests, live OpenClaw route tests, CI, security notes, and third-party attribution.
