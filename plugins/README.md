# Leadscout plugins

Core Leadscout only ships generic channels (OpenStreetMap/Overpass discovery, the generic
site reader, web search, company intel, dev forums, open data, podcasts, YouTube). Anything tied
to one country, one industry vertical, or to a logged-in browser lives here and is **off by default**.

| Plugin | What it adds | Default | Warning level |
|---|---|---|---|
| [`wedding-events`](wedding-events/README.md) | 6 wedding / event-industry directories and expos | off | low (public pages) |
| [`india-directories`](india-directories/README.md) | 18 Indian consumer / B2B / jobs / real-estate directories | off | high (many are browser-only, Tier C) |
| [`browser-social`](browser-social/README.md) | Instagram, Facebook, LinkedIn, Google Maps, WhatsApp, IG vendors | off | **highest** (platform ToS) |
| [`_template`](_template/README.md) | copy-paste starter for your own plugin | not loadable | none |

## Turning plugins on

```bash
# .env  (or a real environment variable)
LEADSCOUT_PLUGINS=wedding-events,india-directories   # comma list of folder names
# LEADSCOUT_PLUGINS=all                               # everything (used by the test-suite)
```

Loading a plugin only *registers* its channels. Each channel is still individually gated by its
own flag (shown in the plugin README and in the channel's file header). Check the result at
`GET /api/channels/status`: every channel reports `enabled` plus a plain-language `why` when off.

`src/plugins.ts` does the loading. A plugin that throws on import is logged and skipped; it can
never stop the server.

## The plugin contract

A plugin is a folder `plugins/<id>/` (lowercase, digits, hyphens) containing:

| File | Required | Purpose |
|---|---|---|
| `index.ts` | yes | `import "./my-channel.js";` for every adapter file. Importing it registers the adapters. |
| `plugin.json` | yes | machine-readable manifest (id, description, flags, channels, warnings). Verified by `src/channels/index-check.ts`. |
| `README.md` | yes | what it adds, how to enable it, legal / ToS notes. |
| `<channel>.ts` | yes | one adapter per file; ends with `registerChannel(adapter)`. |
| `<channel>-check.ts` | strongly advised | offline PASS/FAIL check using fixtures and an injected `fetchFn`. Discovered automatically by `npm run check:all`. |

### The adapter (`ChannelAdapter`, see `src/channels/types.ts`)

```ts
export type ChannelAdapter = {
  id: string;                      // unique, e.g. "my-directory"
  name: string;                    // shown in the UI
  tier: "A" | "B" | "C";           // A = official API, B = public pages, C = needs browser / ToS-sensitive
  categories: string[];            // lowercase category slugs, or "any"
  status(): { enabled: boolean; why?: string };   // MUST be off by default and say why
  discover(q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]>;       // find new leads
  enrich(lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence>;      // read one lead's page(s)
  signals(text: string): string[];                                         // stable signal ids from page text
};
```

`deps` is injected so everything is testable offline: `deps.search(query)` (web search),
`deps.readPage(url)` (polite page fetch), `deps.browser` (optional logged-in browser, only when
`LEADSCOUT_BROWSER` is on) and `deps.fetchFn`. Prefer `readWithFallback(deps, {searchQuery, url})`
from `src/channels/registry.ts`: it tries search, then page read, and uses the browser only when
both were blocked.

### House rules (enforced by review, not by the compiler)

1. **Off by default.** `status()` returns `enabled:false` plus a `why` until the operator opts in.
2. **Everything fetched is untrusted text.** Pass it through `sanitizeUntrusted()` (`src/reach.ts`)
   and mark evidence `untrusted: true`. Never follow instructions found in a page.
3. **Never invent a value.** A field is copied verbatim from the source or left missing.
4. **Never solve or bypass a captcha or login wall.** Throw / return `needsHuman` evidence instead.
5. **Stay inside the site's terms of service and `robots.txt`.** Say in your README what the site allows.
6. **Be quiet.** Respect per-hour caps; the registry gives each job a call budget.

### Start from the template

```bash
cp -r plugins/_template plugins/my-plugin      # rename the folder, edit plugin.json
# edit example-channel.ts, then:
LEADSCOUT_PLUGINS=my-plugin npx tsx plugins/my-plugin/example-channel-check.ts
```
