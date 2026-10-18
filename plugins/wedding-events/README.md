# Plugin: Wedding & events vertical

Public wedding-vendor directories, venue sites and expo / award lists, for selling to wedding and event businesses.

- **Region / vertical:** India-first, vertical: weddings & events
- **Default:** off
- **Enable:** `LEADSCOUT_PLUGINS=wedding-events` (comma-add to other plugins)
- **Per-channel switches:** `CHANNEL_CH_WEDMEGOOD`, `CHANNEL_CH_WEDDINGWIRE_IN`, `CHANNEL_CH_WEDDINGSUTRA`, `CHANNEL_CH_VENUES`, `CHANNEL_CH_EXPOS_AWARDS`, `CHANNEL_CH_EVENT_ORGANISERS`, `CHANNEL_CH_WEBSEARCH_DISCOVERY` (each channel's file header says exactly which one it reads)
- **Channels (adapter ids):** `ch-wedmegood`, `ch-weddingwire-in`, `ch-weddingsutra`, `venuelook / ch-venues`, `ch-expos-awards`, `ch-event-organisers`, `ch-websearch-discovery`
- **Files:** `ch-event-organisers.ts`, `ch-expos-awards.ts`, `ch-venues.ts`, `ch-weddingsutra.ts`, `ch-weddingwire-in.ts`, `ch-wedmegood.ts`; one `*-check.ts` per adapter (offline, fixtures only)

## Legal and etiquette

Tier B: public pages through web search + polite page reads. Check each site's terms and robots.txt before enabling its flag.

The matching niche pack is `data/niche-packs/wedding-events.json` (core ships it as an example pack).

Whatever you enable, you remain responsible for the site's terms of service, `robots.txt`, data-protection
law and calling rules. See the main README's legal section.

## Check it

```bash
LEADSCOUT_PLUGINS=wedding-events npx tsx plugins/wedding-events/ch-event-organisers-check.ts
npm run check:all -- plugins/wedding-events
```

## How it plugs in

`index.ts` imports each adapter file; each adapter calls `registerChannel()` from `src/channels/registry.ts`.
Contract and template: [`plugins/README.md`](../README.md).
