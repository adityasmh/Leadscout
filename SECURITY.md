# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's "Report a vulnerability" (private security
advisory) on this repository. Include steps to reproduce; you will get a reply as soon as a maintainer can.

## Design notes worth knowing

- The server binds to `127.0.0.1` by default and has **no login**. Exposing it (`LEADSCOUT_HOST=0.0.0.0`) without a reverse proxy,
  TLS and authentication in front is unsafe. Workspace routes can require Bearer keys (`LEADSCOUT_REQUIRE_KEYS=1`).
- All secrets come from environment variables / your private `.env` (git-ignored). The LLM provider key lives only in the
  optional adapter process, never in Leadscout.
- Fetched web text is treated as hostile (prompt-injection aware): sanitised, stored as untrusted evidence, never executed.
- `npm run check:all` includes checks for the opt-out, gating, key-auth and secret-handling behaviour.
- The browser backend has a kill switch (`LEADSCOUT_BROWSER=0`) and refuses mail and banking sites outright.
