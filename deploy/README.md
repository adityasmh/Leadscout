# deploy/: optional Docker and backup helpers

**You do not need any of this.** The primary way to run Leadscout is `npm install && npm start`.
This folder is for people who prefer a container or want scheduled backups.

| File | Purpose |
|---|---|
| `deploy-check.ts` | Offline PASS/FAIL checks for the Docker pack (Dockerfile, compose, `.env.example`, backup function). Picked up by `npm run check:all`. |
| `backup.ps1` | Timestamped SQLite backup: `-Db <path> -BackupDir <dir> [-Keep <n>]` (default 14). Uses `VACUUM INTO` through Node's built-in `node:sqlite`; prunes older backups to the newest `-Keep`. |

## What the container does

- Image `node:24-alpine`; copies `package.json`, `src`, `plugins`, `adapters`, `data` and `public`; runs `tsx src/server.ts` as the
  non-root user `node` (no build step; `tsx` is the one global package, pinned).
- Database: SQLite at `/data/leadscout.db` on the named volume `leadscout-data`.
- Network: binds `0.0.0.0` inside the container; `docker-compose.yml` publishes it to `127.0.0.1:${LEADSCOUT_PORT:-8790}` only.
- Health check: `GET /api/health`.
- Configuration comes from your `.env` (`env_file: .env`); copy `.env.example` first.

```bash
cp .env.example .env
docker compose up -d
```

## HTTPS with Caddy (optional)

The compose file has an optional `caddy` service under the `tls` profile. Create `deploy/Caddyfile` first (the service bind-mounts it),
for example:

```caddy
leadscout.example.com {
    reverse_proxy leadscout:8790
}
```

then `docker compose --profile tls up -d`. Replace `leadscout.example.com` with your own domain (DNS must point at the host).
Leadscout has no login of its own: if it is reachable from the internet, add authentication in front of it and set
`LEADSCOUT_REQUIRE_KEYS=1`.

## Backups

`backup.ps1` writes `leadscout-yyyyMMdd-HHmmss.db` copies of the database passed as `-Db` into `-BackupDir`, keeping the newest `-Keep`
(default 14); only files matching that pattern are pruned. Schedule it with Task Scheduler (Windows) or cron plus PowerShell 7 (`pwsh`).
To restore, stop Leadscout and copy a backup over `LEADSCOUT_DB`.

## Checks

```bash
npx tsx deploy/deploy-check.ts
```

No network, Docker daemon or containers are needed: static text checks plus a temp SQLite file.
