# Leadscout

> **Finds local businesses, grades them, reads their websites, and hands your callers a call sheet
> that is actually worth dialing.** Node 24 + SQLite. No Docker required. No Kubernetes, ever. No drama.

Leadscout is a lead-research engine for people who sell services to local businesses (web design,
booking tools, automation, marketing). You tell it what you sell and who you want; it finds matching
businesses, reads their public websites, spots what is missing (no online booking, ancient copyright
year, no chat widget...), scores how well each one fits **your** offer, and writes a short dossier with
a line your caller can say out loud. Then it builds the day's call sheet, logs what happened on the
call, and learns which sources and signals actually turn into customers.

It runs on one machine, in one process, with one SQLite file. The language model is optional: it only
"polishes" dossier wording, and `LEADSCOUT_LLM_OFF=1` turns it off without losing anything else.

```
discover  ->  enrich  ->  verify  ->  score  ->  dossier  ->  call sheet  ->  call log  ->  learn
(OSM, CSV,   (read their   (is the    (fit +     (evidence    (DND-screened,  (notes,       (what
 Places,      own website)  phone     reach +    numbered,    per caller)     outcomes)     converts)
 plugins)                   real?)    timing)    no inventing)
```

## 5-minute quickstart

You need **Node 24 or newer** (`node --version`). That is all. No account, no API key, no database server.

```bash
git clone https://github.com/adityasmh/Leadscout.git
cd Leadscout
npm install          # installs tsx + typescript, nothing else
npm run demo         # offline tour: imports 5 fake dentists, scores them, prints a call sheet
npm start            # the real thing: http://localhost:8790
```

`npm run demo` starts its own throwaway server on a random port with a temp database, so it can never
touch real data. `npm start` creates `data/leadscout.db` (empty) on first use. It prints `.env not found. Continuing without it.`
when you have not created a `.env` yet: that is normal. Port 8790 taken? `LEADSCOUT_PORT=8890 npm start`.
Verify it is up: `curl localhost:8790/api/health` (it answers `{"ok":true,...}`).

Want discovery from the live map? Point Leadscout at an Overpass (OpenStreetMap) endpoint:

```bash
cp .env.example .env
# edit .env:  LEADSCOUT_OVERPASS_URLS=https://overpass-api.de/api/interpreter   (mind its usage policy)
npm start
```

Then open <http://localhost:8790>, create a workspace (what you sell + who you want), and hit discover.
Or do it over HTTP, see [docs/API.md](docs/API.md).

### Do I need Docker or Kubernetes?

**No.** Plain Node is the primary way to run Leadscout. A `Dockerfile` and `docker-compose.yml` are
included purely as a convenience (`docker compose up`), and they publish to `127.0.0.1` only.
Kubernetes is not supported and not needed: this is one process and one file.

## Configuration

Everything is an environment variable, documented line by line in [`.env.example`](.env.example).
`npm start` loads `.env` when it exists; with no `.env` you get the safe defaults.
`npm run check:env` fails if the code reads a variable that `.env.example` does not mention.

| You want | Set |
|---|---|
| a different port / DB file | `LEADSCOUT_PORT`, `LEADSCOUT_DB` |
| reachable from other machines (behind a proxy!) | `LEADSCOUT_HOST=0.0.0.0` (default is localhost only) |
| live OpenStreetMap discovery | `LEADSCOUT_OVERPASS_URLS` |
| live contact lookups on the web | `LEADSCOUT_RESOLVE_LIVE=1`, `LEADSCOUT_CHANNELS_LIVE=1` |
| model-polished dossiers | `LEADSCOUT_LLM_OFF=0` + `LEADSCOUT_LLM_URL` (see below) |
| API-key auth on workspace routes | `LEADSCOUT_REQUIRE_KEYS=1`, `LEADSCOUT_ADMIN_TOKEN` |
| region / vertical / browser channels | `LEADSCOUT_PLUGINS=...` (see [plugins](#plugins)) |
| emailing (off by default!) | `LEADSCOUT_SMTP_URL`, `LEADSCOUT_SEND_ENABLED=1` |

Secrets live only in your `.env`, which is git-ignored. Nothing in this repository contains a key.

### Bring your own LLM (optional)

Leadscout speaks one tiny contract to **whatever** you point `LEADSCOUT_LLM_URL` at:

```
POST {LEADSCOUT_LLM_URL}            default http://127.0.0.1:8787/chat
Content-Type: application/json     (+ Authorization: Bearer $LEADSCOUT_LLM_TOKEN if set)

request : { "prompt": "...", "system": "...", "taskHint": "dossier-polish" }
response: { "answer": "...", "usage": { "input_tokens": 123, "output_tokens": 45 }, "model": "optional" }
```

A ready-made adapter that forwards this to **any OpenAI-compatible API** (OpenAI, OpenRouter, DeepSeek,
Ollama, vLLM...) or to **Anthropic** lives in [`adapters/llm-adapter.ts`](adapters/llm-adapter.ts):

```bash
# .env
LLM_PROVIDER=openai            # or: anthropic
LLM_MODEL=gpt-4o-mini          # any model your provider offers
OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY=...
LEADSCOUT_LLM_OFF=0

npm run llm-adapter            # terminal 1: listens on 127.0.0.1:8787, holds YOUR key
npm start                      # terminal 2
```

Leadscout never sees your provider key; only the adapter does. Prefer to host your own endpoint? Anything
that returns `{answer}` works.

## Plugins

Core Leadscout ships only generic channels (OpenStreetMap discovery, a generic site reader,
company intel, dev forums, open data, podcasts, YouTube). Anything tied to **one region, one industry
vertical, or a logged-in browser** is an opt-in plugin in [`plugins/`](plugins/README.md):

| Plugin | Adds | Risk |
|---|---|---|
| [`wedding-events`](plugins/wedding-events/README.md) | wedding / event vendor directories, venues, expos | low |
| [`india-directories`](plugins/india-directories/README.md) | 18 Indian directories (JustDial, Zomato, Naukri, MagicBricks...) | high: scraping-sensitive |
| [`browser-social`](plugins/browser-social/README.md) | Instagram, Facebook, LinkedIn, Google Maps, WhatsApp via a real browser | **highest: platform ToS** |

```bash
LEADSCOUT_PLUGINS=wedding-events            # in .env; comma-separate several; "all" loads everything
```

Loading a plugin only *registers* channels; each channel still has its own off-by-default switch, and
`/api/channels/status` tells you what is on and, if not, why. Writing your own takes a copy-paste
template and about 100 lines: see [`plugins/README.md`](plugins/README.md) and
[`plugins/_template/`](plugins/_template/).

**Regional defaults.** The core still carries an India-first source registry (`src/india-sources.ts`,
`data/india-sources.json`, `data/india-cities.json`) that ranks channels per business category, plus the
sample `data/niche-packs/`. Outside India the ranking simply falls back to registration order; the OSM and
CSV paths work anywhere. Making the region profile itself pluggable is on the wish list (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

## Using it

- **UI:** `http://localhost:8790/` and its sibling pages: `calls.html` (call desk), `dossier.html`,
  `intake.html` (interview that builds your target brief), `opportunity.html`, `packs.html`,
  `settings.html`, `showcase.html`.
- **API:** JSON over HTTP, no framework. Full route list in [docs/API.md](docs/API.md).
- **CSV in/out:** import any scraper CSV (`POST /api/workspaces/:ws/import-csv`), export leads and call logs.
- **Do-not-call:** drop your regulator's DND export into `data/dnd/` and the call sheet screens it.

## Checks (no network needed)

```bash
npm run typecheck      # tsc --noEmit on all product code
npm run check:env      # every env var the code reads is documented
npm run check:all      # ~135 offline PASS/FAIL scripts (src, plugins, adapters, deploy), plugins force-enabled
npm run check:all -- billing     # only files whose path contains "billing"
```

Each `*-check.ts` is a plain script that prints `PASS`/`FAIL` and exits non-zero on failure; they use
fixtures and injected fakes, never the real internet. (`tsc` skips the `*-check.ts` files, which are
loosely typed on purpose; `npm run typecheck:checks` shows their ~40 known type nits.)

## Project map

New to the codebase (human or LLM)? Read [AGENTS.md](AGENTS.md) first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version:

```
src/            the product: server.ts (HTTP), pipeline.ts (the stages), store.ts (SQLite), channels/ (registry + core adapters)
plugins/        opt-in channels: wedding-events, india-directories, browser-social, _template
adapters/       reference LLM adapter (OpenAI-compatible + Anthropic)
data/           config JSON (categories, price book, templates, intake questions, niche packs); the DB lands here too
public/         the static UI
fixtures-v2/    synthetic fixtures for the checks      test-fixtures/  tiny HTML pages for the site reader
scripts/        run-checks.ts, env-check.ts, demo.ts   deploy/  optional Docker helpers + backup script
```

## Legal and compliance: read this before you dial or scrape anyone

Leadscout is a tool; **you** are the operator and you are responsible for how it is used. Full text in
[docs/LEGAL.md](docs/LEGAL.md). The short version:

1. **Website terms and robots.txt.** Many sites forbid automated reading. The enrichment step reads a
   business's own site politely (checks `robots.txt`, homepage plus one contact page, descriptive
   User-Agent, page cache). Plugin channels, especially `india-directories` and `browser-social`, can
   break a site's terms and get accounts banned. They are off by default and never solve captchas.
   Read each plugin's README and the site's terms first.
2. **Calling and messaging rules.** Cold calls, SMS, WhatsApp and email are regulated almost everywhere
   (do-not-call registries, consent rules such as TCPA, PECR, CAN-SPAM, GDPR/ePrivacy, India's TRAI DND
   rules, and more). Leadscout can screen against a DND file you supply and keeps an opt-out list, but it
   does **not** make a call legal. Email sending is off by default (`LEADSCOUT_SEND_ENABLED=0`).
3. **Opt-out.** `public/optout.html` and the opt-out list suppress a business from future outreach; honour
   every request promptly.
4. **Data protection.** Leads are personal data when they name individuals (a sole trader's phone is
   personal data under GDPR and similar laws). Collect only what you need, tell people where you got it,
   delete on request, keep the SQLite file private and backed up. Leadscout binds to localhost and has no
   login; put it behind your own auth if you expose it.
5. **No guarantees.** Scores, signals and "reach" estimates are heuristics. Facts in dossiers are copied
   from public pages with their source URL; verify before you quote them to anyone.

## Contributing, license, security

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [MIT license](LICENSE)

If this saves you a few hundred cold calls, a star is a fine way to say thanks. If it breaks, open an issue
with the failing check name and we will be delighted to be wrong in public.
