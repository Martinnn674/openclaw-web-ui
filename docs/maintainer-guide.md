# Maintainer Guide

This guide keeps releases boring, repeatable, and safe. The project reads local OpenClaw data, so maintenance work should favor small changes with visible checks over large rewrites.

## Triage

- Mark bugs that can expose local data or write to OpenClaw files as high priority.
- Ask for the operating system, Node version, OpenClaw version, and whether mock mode reproduces the issue.
- Keep feature requests tied to local-first OpenClaw workflows: chat, sessions, memory, tasks, settings, or swarm planning.
- Close issues that require hosted auth, cloud sync, or public internet exposure unless they are framed as documentation or optional hardening.

## Pull Request Review

Before merging:

```bash
npm run check
```

For changes that touch real OpenClaw routes, also run:

```bash
npm run test:live
```

The live test should only be run against a workspace where temporary task creation is acceptable.

## Release Checklist

1. Update `package.json`.
2. Add a top entry to `CHANGELOG.md`.
3. Run `npm run check`.
4. Push `main`.
5. Create a GitHub release named `Claw Space vX.Y.Z`.
6. Check the release page for accidental local paths, tokens, or private screenshots.

## Privacy Checks

`npm run audit:privacy` scans tracked files only. It is not a substitute for reviewing screenshots, release notes, issue attachments, or untracked files before publishing.

Do not commit:

- OpenClaw configs or memory files from a private workspace.
- Session logs that include personal data.
- Local absolute paths.
- API keys, bearer tokens, or GitHub tokens.
- Source-pack filenames or private planning documents.
