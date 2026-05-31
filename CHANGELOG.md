# Changelog

## 0.1.6 - 2026-05-31

- Renamed the project to Claw Space and updated package, repository, README, and documentation references.
- Updated public app metadata so health responses and task prompts use the Claw Space name.

## 0.1.5 - 2026-05-31

- Added a screenshot showcase built from mock data so the project page shows the dashboard, swarm board, and mobile layout without exposing local files.
- Fixed mobile navigation so the Chat tab has a visible Back path and the Memory view is reachable from the bottom nav.
- Changed task cards without due dates to show "No due date" instead of reusing the creation timestamp as a due date.
- Ran a desktop and mobile visual/function audit across dashboard, chat, swarm, tasks, memory, and settings.

## 0.1.4 - 2026-05-31

- Added a dashboard local-access status panel that shows bind host, port, mock/live mode, config filename, and loopback warnings.
- Added sanitized network and security metadata to `/api/health` without exposing absolute config paths.
- Added maintainer guide, roadmap, issue templates, and a pull request template.
- Generalized the privacy audit's Unix home-path check so it no longer names a local user.

## 0.1.3 - 2026-05-31

- Reworked the README into a clearer project front page with a short description, quick start, safety notes, and doc links.
- Added a setup guide covering local, WSL, mock-mode, live-test, and troubleshooting flows.
- Added a feature tour for dashboard, chat, task board, memory/session, settings, swarm, and mock mode.
- Added development notes with project structure, local checks, live checks, release checklist, and design boundaries.

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
