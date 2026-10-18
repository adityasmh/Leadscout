# Contributing to Leadscout

Thanks for helping. This project is small on purpose: one process, one SQLite file, no runtime dependencies.

## Setup

```bash
git clone https://github.com/adityasmh/Leadscout.git && cd Leadscout
npm install
npm run typecheck && npm run check:env && npm run check:all     # should be all green before you start
```

Node 24+ is required (`node:sqlite`, global `WebSocket`, `--env-file-if-exists`).

## The quality gate

A change is done when all three are green: `npm run typecheck`, `npm run check:env`, `npm run check:all`.
Never delete or weaken a check to get green. If a check is wrong, fix it in the same change and say why.

## Ground rules

- **No network in checks.** Inject fakes; use `fixtures-v2/` and `test-fixtures/`.
- **No real data.** Fixtures use `*.example` domains and `+1 555 01xx` numbers. Never commit `.db`, `.env`, exported lists, call logs, recordings.
- **Secrets never go in code.** Add new variables to `.env.example` with a one-line comment (the env check enforces it).
- **Off by default** for anything that touches the outside world, with a plain-language `why` in `status()`.
- **Fetched text is untrusted**: sanitise, cite, never invent.
- Match the surrounding style; comments explain *why*, not *what*.

## Writing a channel plugin

Copy `plugins/_template/`, read `plugins/README.md`, include a `*-check.ts`, document the site's terms in your plugin README.
New plugins that scrape sites which forbid it in their terms will be asked to default to off and carry a warning.

## Wish list (good first projects)

- Make the **regional profile pluggable**: move `india-sources.ts`, `india-cities.json`, `seed-india.json` and the phone/category
  normalisers behind a `region` plugin interface, and ship a generic default.
- Tighten types in the `*-check.ts` files (`npm run typecheck:checks` lists ~40 nits).
- More providers in `adapters/llm-adapter.ts`; a Dockerfile that runs `tsc` once instead of `tsx` at runtime.
- A shell twin for `deploy/backup.ps1` (SQLite `VACUUM INTO` backup with retention).

## Pull requests

Small and focused. Describe what changed and which checks cover it. By contributing you agree your work is released under the MIT license.
