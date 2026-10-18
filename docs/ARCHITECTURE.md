# Architecture

One process, one SQLite file, zero runtime dependencies. This document explains how the pieces fit so you
(or an LLM) can change things without reading 60k lines first. Orientation and rules: [../AGENTS.md](../AGENTS.md).

## Runtime shape

```
 browser / curl / CSV
        |
   src/server.ts  (node:http, static files from public/, JSON API, optional Bearer-key auth)
        |  one dynamic-import hook per routes-*.ts module (a module that fails to load answers 501)
        v
   src/pipeline.ts  ---->  src/channels/registry.ts  ---->  adapters (core: src/channels/*, opt-in: plugins/*)
        |                         ^                                |
        |                         |                                v
        |                  src/plugins.ts (LEADSCOUT_PLUGINS)   reach.ts: search + page read (injectable, sanitised)
        v
   src/store.ts  ->  node:sqlite  ->  LEADSCOUT_DB (default data/leadscout.db, created empty on first use)
        |
   src/llm.ts -> POST LEADSCOUT_LLM_URL (optional; only "polishes" dossiers)
```

## The pipeline (`src/pipeline.ts`)

A job runs these stages for a batch of leads. Every stage records errors and keeps going; a job ends `done` or `failed`.

| Stage | What happens | Main modules |
|---|---|---|
| S0 Discover | find businesses for (category, city): OpenStreetMap via Overpass, Google Places (key), CSV import, or channel adapters | `discover.ts`, `sources-extra.ts`, `channels/registry.ts` |
| S1 Listing pre-score | cheap score from listing data alone, drop obvious misses | `score.ts` |
| S1.5 Contact resolution | find phone/email on the web, keeping source URL + fetch time for every value; never invents | `resolve.ts`, `resolve-channels.ts` |
| S2 Enrich | read the business's own site (robots.txt, homepage, one contact page), extract signals | `enrich.ts`, `page-cache.ts`, `fc-reader.ts` |
| S3 Verify | is the phone/email real and reachable? | `verify.ts` |
| S4 Match + score | fit vs *your* offer (transparent rules), reach, timing; `total = 0.5 fit + 0.3 reach + 0.2 timing` | `match.ts`, `score.ts`, `timing.ts`, `learn-score.ts` |
| S5 Evidence | numbered evidence (E1..En) with sources | `evidence.ts` |
| S6 Dossier | template dossier from evidence (no model) | `dossier.ts` |
| S7 Model polish | optional wording polish through the LLM endpoint; token budget and selection gate | `llm.ts`, `cost.ts`, `dossier-prompts.ts` |

After the pipeline: `gate.ts` decides who may reach a caller (opt-outs, DND, missing phone), `delivery.ts` builds the call
sheet, `calls.ts` / `call-notes.ts` log outcomes, `learn-score.ts`, `source-trust.ts`, `shared-lessons.ts` and `yield-loop.ts`
feed outcomes back into scoring and channel ranking.

## Channels and plugins

A **channel adapter** implements `ChannelAdapter` (`src/channels/types.ts`): `id`, `tier`, `categories`, `status()`,
`discover()`, `enrich()`, `signals()`. It self-registers with `registerChannel()` when its file is imported.

- `src/channels/index.ts` imports the **core** adapters, then awaits `loadPlugins()`.
- `src/plugins.ts` imports `plugins/<id>/index.ts` for each id in `LEADSCOUT_PLUGINS` (or all of them for `all`).
- The registry ranks adapters per category (India registry order, then learned source trust, then registration order),
  runs them with a per-job call budget, merges and de-duplicates by name + area + phone.
- Reading is always: web search first, then a polite page read, then the logged-in browser (`channels/browser.ts`)
  only if both were blocked, and only when `LEADSCOUT_BROWSER` is on.

Tiers: **A** official API, **B** public pages, **C** browser-only or terms-sensitive. See [../plugins/README.md](../plugins/README.md).

## Data model (SQLite)

Core tables are in `src/store.ts` (`workspaces`, `leads`, `jobs`). Most other modules create their own tables lazily with
`CREATE TABLE IF NOT EXISTS`, on the same database:

`dossiers`, `evidence_snapshots`, `verifications`, `lead_scores`, `lead_events`, `page_cache`, `llm_ledger`, `call_logs`,
`call_notes`, `call_assignments`, `opt_outs`, `outreach_sends`, `api_keys`, `usage`, `limits`, `share_tokens`,
`price_books`, `branding`, `feeds`, `feed_runs`, `delivered_leads`, `intake_briefs`, `niche_packs`, `workspace_packs`,
`workspace_plan`, `usage_events`, `yield_stats`, `category_explainers`.

A **workspace** = one seller (what you offer + who you want). Leads, jobs, keys, price book and branding hang off it.

## Static config (`data/`)

`categories.json` (canonical categories), `default-pricebook.json`, `plans.json`, `outreach-templates.json`,
`intake-questions.json` (the interview tree), `service-rules.json`, `season-calendar.json`, `source-trust-seed.json` (priors),
`canaries.json` (self-healing channel canaries), `browser-allowlist.json`, `india-sources.json` / `india-cities.json` /
`seed-india.json` (default regional profile), `niche-packs/` (sample packs), `dnd/` (put your do-not-call exports here).

## Trust model

- All fetched text is **untrusted**: sanitised by `reach.sanitizeUntrusted`, stored as evidence with `untrusted: true`,
  and prompts treat it as data. Dossier text must cite evidence ids.
- The browser backend has a kill switch (`LEADSCOUT_BROWSER=0`), a hard deny list (mail, banking), an allowlist file,
  per-platform hourly caps, random pauses, and stops for a human at the first login wall or captcha.
- The server binds to `127.0.0.1` by default and has no login of its own; workspace routes can require Bearer keys
  (`LEADSCOUT_REQUIRE_KEYS=1`).

## Testing approach

`npm run check:all` runs every `*-check.ts` (src, plugins, adapters, deploy) as a separate process with plugins force-enabled
(`scripts/run-checks.ts`). Checks are offline: injected fetch, fixtures under `fixtures-v2/` and `test-fixtures/`, temp databases.

## History note

Comments mention internal order ids (`L41`, `CW1`...) and files under `docs/leadgen/`. They come from the private project this
was extracted from and are not part of this repository. They are safe to ignore.
