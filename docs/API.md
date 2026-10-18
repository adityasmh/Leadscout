# HTTP API

Base URL `http://localhost:8790` (`LEADSCOUT_PORT`, `LEADSCOUT_HOST`). JSON in, JSON out, bodies up to 1 MB.
With `LEADSCOUT_REQUIRE_KEYS=1`, `/api/workspaces/*` routes need `Authorization: Bearer <workspace key>`; `PUT .../limits`
needs the `LEADSCOUT_ADMIN_TOKEN`. Routes live in `src/server.ts` (core) and `src/routes-*.ts` (modules). `:ws` is a workspace id.

## Quick tour

```bash
# 1. create a workspace: what you sell + who you want
curl -s -X POST localhost:8790/api/workspaces -H 'content-type: application/json' -d '{
  "name": "My agency",
  "offer": { "services": ["website","online-booking"], "description": "Websites and booking pages for clinics." },
  "icp":   { "categories": ["dentist"], "cities": ["Springfield"], "countries": ["US"] } }'

# 2a. discover from OpenStreetMap (needs LEADSCOUT_OVERPASS_URLS)         -> 202 {jobId}
curl -s -X POST localhost:8790/api/workspaces/$WS/discover -H 'content-type: application/json' \
  -d '{"category":"dentist","city":"Springfield","limit":25}'
# 2b. ...or import a CSV you already have (columns: name,category,address,phone,website,rating,reviews,link)
curl -s -X POST localhost:8790/api/workspaces/$WS/import-csv --data-binary @examples/demo-leads.csv

# 3. enrich + score everything new                                        -> 202 {jobId, leads}
curl -s -X POST localhost:8790/api/workspaces/$WS/process
curl -s localhost:8790/api/workspaces/$WS/jobs

# 4. read results
curl -s "localhost:8790/api/workspaces/$WS/leads?sort=score&limit=20"
curl -s localhost:8790/api/workspaces/$WS/leads/$LEAD/dossier
curl -s "localhost:8790/api/workspaces/$WS/callsheet?format=json"
```

## Core (`src/server.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness + which optional integrations are on (names only) + channel counts |
| GET | `/api/channels/adapters` | registered channel adapters |
| GET | `/api/channels/status` | per-channel `enabled` + plain `why` (also browser backend status) |
| GET/POST | `/api/workspaces` | list / create |
| GET/PUT | `/api/workspaces/:ws` | read / update name, offer, icp |
| POST | `/api/workspaces/:ws/discover` | start a discovery job (`source`: `osm` default, `google-places`, `csv`) |
| POST | `/api/workspaces/:ws/process` | enrich + score all unscored `new` leads |
| GET | `/api/workspaces/:ws/jobs` | job list and status |
| GET | `/api/workspaces/:ws/usage` | usage vs limits |
| PUT | `/api/workspaces/:ws/limits` | set limits (admin token) |
| POST/GET | `/api/workspaces/:ws/keys` (+ `/:id`) | workspace API keys |
| GET + write | `/api/workspaces/:ws/pricebook` | your prices per service |
| GET + write | `/api/workspaces/:ws/branding` | sender name, accent colour, footer |
| GET | `/api/workspaces/:ws/leads` | filter by `status, minScore, city, category, signal, q`, `sort`, `limit`, `offset` |
| GET/PATCH | `/api/workspaces/:ws/leads/:id` | one lead / update `status` (new, shortlisted, contacted, replied, won, rejected) and `notes` |
| POST | `/api/workspaces/:ws/leads/:id/process` | re-run one lead |
| GET/POST | `/api/workspaces/:ws/leads/:id/dossier` | dossier (level 0 template; level 1 = model polish) |
| POST | `/api/workspaces/:ws/leads/:id/outreach` | build a draft; body `{channel: "email"\|"whatsapp"\|"call"}` |
| POST | `/api/workspaces/:ws/leads/:id/outreach/send` | send the email draft (refused unless `LEADSCOUT_SEND_ENABLED=1` and SMTP is configured; opt-outs enforced) |
| GET | `/api/workspaces/:ws/export?format=generic\|hubspot\|zoho\|twenty\|jsonl`, `.../export.csv` | export leads for a CRM / as CSV |
| POST | `/api/workspaces/:ws/share` | create a read-only share link |
| POST | `/api/workspaces/:ws/import-csv` | import a scraper CSV (body = CSV text) |
| GET/POST | `/api/workspaces/:ws/invoices` (+ `.html`, `/pay-link`) | usage invoices; Razorpay/Stripe links when keys are set |
| GET | `/api/report/:token` | public read-only report behind a share token |
| POST | `/api/optout` | public opt-out (rate limited per IP); stored as a global suppression |
| GET/POST | `/api/workspaces/:ws/intake/{next,answer,refine}`, `/brief`, `/brief/run`, `/lookalike/profile` | guided intake -> target brief -> queries; ideal-customer profile |

## Route modules

| Module | Routes |
|---|---|
| `routes-calls.ts` | `GET .../call-queue`, `GET .../calls.csv`, `GET .../call-stats`, `POST/GET .../leads/:id/calls`, `PATCH .../calls/:callId` |
| `routes-callnotes.ts` | `GET .../call-notes`, `POST/GET .../leads/:id/call-notes`, `GET .../call-notes/:noteId`, `POST .../confirm`, `POST .../discard` |
| `routes-delivery.ts` | `GET .../callsheet?date=&perCaller=&callers=a,b&format=json\|csv\|html`, `POST .../callsheet/assign` |
| `routes-feeds.ts` | `POST/GET /api/feeds`, `GET /api/feeds/:id`, `POST /api/feeds/:id/{run,enable,disable}`, `GET /api/feeds/:id/runs`, `GET /api/feeds/due` |
| `routes-intake.ts` | `GET .../intake`, `GET/PUT .../brief`, `POST .../brief/run`, `GET /api/channels/status` |
| `routes-opportunity.ts` | `GET .../opportunity`, `GET .../opportunity/next` (where the gaps are, by area and category) |
| `routes-packs.ts` | `GET/POST /api/niche-packs`, `GET .../niche-packs`, `POST .../niche-packs/:id/{attach,detach}` |
| `routes-showcase.ts` | `GET .../showcase` (client-facing overview data) |

The source of truth is the code: each routes file starts with a comment block listing its routes and body shapes.

## UI pages (`public/`)

`index.html` (workspaces/leads), `calls.html` (call desk), `dossier.html`, `intake.html`, `brief.html`, `opportunity.html`,
`packs.html`, `settings.html`, `showcase.html`, `showcase2.html`, `optout.html`.
