# Security Policy

OpenClaw Web UI is designed for local loopback use. It can read OpenClaw memory, sessions, and config-adjacent data from the configured OpenClaw home.

The public health endpoint intentionally reports only sanitized config metadata, not an absolute local filesystem path.

## Reporting A Vulnerability

Please open a GitHub security advisory or a private maintainer contact if one is listed. Do not post tokens, private config, session logs, or screenshots with secrets in public issues.

## Local Use Guidance

- Bind to `127.0.0.1` unless you have added your own authentication layer.
- Treat `OPENCLAW_CONFIG`, OpenClaw session logs, and memory files as sensitive.
- Do not expose this app directly to the public internet.
