# Plugin: India directories

Indian consumer, B2B, jobs, real-estate and map directories (JustDial, Zomato, Swiggy, Sulekha, Urban Company, MagicBricks, NoBroker, Naukri, 99acres, travel sites, BookMyShow, Mappls, IndiaMART, Udaan, Practo, Lybrate, ShareChat).

- **Region / vertical:** India
- **Default:** off
- **Enable:** `LEADSCOUT_PLUGINS=india-directories` (comma-add to other plugins)
- **Per-channel switches:** `LEADSCOUT_BROWSER`, `LEADSCOUT_INDIA_TIER_C`, `MAPPLS_API_KEY`, `CHANNEL_BOOKMYSHOW`, `LEADSCOUT_PRACTO`, `LEADSCOUT_LYBRATE`, `LEADSCOUT_SHARECHAT_ENABLED` (each channel's file header says exactly which one it reads)
- **Channels (adapter ids):** `justdial`, `zomato`, `swiggy`, `sulekha`, `urban-company`, `magicbricks`, `nobroker`, `naukri`, `ninenine-acres`, `jobs-india`, `travel`, `bookmyshow`, `mappls`, `indiamart`, `udaan`, `practo`, `lybrate`, `sharechat`
- **Files:** `acres99.ts`, `bookmyshow.ts`, `indiamart.ts`, `jobs-india.ts`, `justdial.ts`, `lybrate.ts`, `magicbricks.ts`, `mappls.ts`, `naukri.ts`, `nobroker.ts`, `practo.ts`, `sharechat.ts`, `sulekha.ts`, `swiggy.ts`, `travel.ts`, `udaan.ts`, `urbancompany.ts`, `zomato.ts`; one `*-check.ts` per adapter (offline, fixtures only)

## Legal and etiquette

Most are Tier C: they only work through the browser backend (`LEADSCOUT_BROWSER`) and a second switch (`LEADSCOUT_INDIA_TIER_C=1`). Mappls is Tier B and needs `MAPPLS_API_KEY`. Directory sites commonly forbid scraping in their terms.

Core still ships the India source registry (`src/india-sources.ts`, `data/india-sources.json`) that ranks channels per category; see the main README, section 'Regional defaults'.

Whatever you enable, you remain responsible for the site's terms of service, `robots.txt`, data-protection
law and calling rules. See the main README's legal section.

## Check it

```bash
LEADSCOUT_PLUGINS=india-directories npx tsx plugins/india-directories/acres99-check.ts
npm run check:all -- plugins/india-directories
```

## How it plugs in

`index.ts` imports each adapter file; each adapter calls `registerChannel()` from `src/channels/registry.ts`.
Contract and template: [`plugins/README.md`](../README.md).
