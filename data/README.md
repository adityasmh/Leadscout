# data/

Static configuration the app reads at runtime (all synthetic or generic), plus the place where your own database lands.

| File / folder | What it is |
|---|---|
| `categories.json` | canonical business categories and aliases |
| `default-pricebook.json`, `plans.json` | starter price book and plan limits (placeholders, edit freely) |
| `outreach-templates.json` | email / WhatsApp / call-script templates with `{placeholders}` |
| `intake-questions.json` | the guided interview that builds a target brief |
| `service-rules.json`, `season-calendar.json` | rules for matching services to signals, and seasonal timing |
| `source-trust-seed.json`, `canaries.json`, `channel-matrix.json` | channel trust priors, self-healing canary definitions, last probe matrix |
| `browser-allowlist.json` | sites the browser backend may open (a hard deny list for mail/banking always wins) |
| `india-sources.json`, `india-cities.json`, `seed-india.json` | default regional profile (India); see the README note on regional defaults |
| `niche-packs/` | sample niche packs (`example-dental.json`, `wedding-events.json`) |
| `dnd/` | put your do-not-call exports here (`*.csv`, one number per line); never committed |
| `leadscout.db` | **created on first run**; git-ignored; this is your data |
