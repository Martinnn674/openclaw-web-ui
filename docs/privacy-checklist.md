# Privacy Checklist

Run before public releases:

```bash
npm run audit:privacy
git status --ignored -sb
```

Release checklist:

- No `data/tasks.json` runtime state is tracked.
- No `*.log` files are tracked.
- No absolute local user paths are tracked.
- No private research/source-pack filenames are tracked.
- No token-shaped credentials are tracked.
- `/api/health` returns sanitized config metadata instead of absolute paths.
