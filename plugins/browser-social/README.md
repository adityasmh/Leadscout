# Plugin: Browser & social

> **Terms-of-service warning.** These channels read pages that platforms generally do not allow
> to be scraped, and they drive a real, logged-in browser session. Using them can get the
> account banned and may breach the platform's terms or local law. They are **off by default**,
> need two separate opt-ins, are rate-capped, and stop for a human at the first login wall or
> captcha (they never solve or bypass one). Use them only with accounts and content you are
> entitled to use, at low volume, and read the platform's current terms first. The authors accept
> no responsibility for how you use them.

Instagram, Facebook pages, LinkedIn company pages, Google Maps/Places and WhatsApp Business lookups, plus Instagram vendor discovery.

- **Region / vertical:** global
- **Default:** off
- **Enable:** `LEADSCOUT_PLUGINS=browser-social` (comma-add to other plugins)
- **Per-channel switches:** `LEADSCOUT_BROWSER`, `LEADSCOUT_INDIA_TIER_C`, `LEADSCOUT_CDP_URL`, `CHANNEL_CH_INSTAGRAM_VENDORS` (each channel's file header says exactly which one it reads)
- **Channels (adapter ids):** `instagram-business`, `facebook-pages`, `linkedin-company`, `google-maps-places`, `whatsapp-business`, `ch-instagram-vendors`
- **Files:** `ch-instagram-vendors.ts`, `facebook.ts`, `google.ts`, `instagram.ts`, `linkedin.ts`, `whatsapp.ts`; one `*-check.ts` per adapter (offline, fixtures only)

## Legal and etiquette

ToS-sensitive. See the warning at the top of this README.

The browser backend itself (`src/channels/browser.ts`) stays in core: it is off unless `LEADSCOUT_BROWSER` is set, has a kill switch, a hard deny list (mail, banking) and an allowlist in `data/browser-allowlist.json`.

Whatever you enable, you remain responsible for the site's terms of service, `robots.txt`, data-protection
law and calling rules. See the main README's legal section.

## Check it

```bash
LEADSCOUT_PLUGINS=browser-social npx tsx plugins/browser-social/ch-instagram-vendors-check.ts
npm run check:all -- plugins/browser-social
```

## How it plugs in

`index.ts` imports each adapter file; each adapter calls `registerChannel()` from `src/channels/registry.ts`.
Contract and template: [`plugins/README.md`](../README.md).
