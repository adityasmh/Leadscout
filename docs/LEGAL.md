# Legal and compliance notes

**This is not legal advice.** Leadscout is software; the person who runs it (you) decides what it reads, who it
contacts and what it stores, and is responsible for doing so lawfully where you and your targets live. Laws differ by
country and change; check with a qualified adviser for your situation.

## 1. Reading websites (scraping)

- A site's **terms of service** may forbid automated access even to public pages. Breaching terms can mean banned
  accounts, blocked IPs, contract claims, and in some places statutory claims (database rights, computer-misuse laws).
- **robots.txt** is the site's stated crawl policy. The enrichment step reads it and fetches only a homepage and one
  contact page per business. Plugin authors should do the same.
- Prefer **official APIs** (Google Places with your own key, Overpass/OpenStreetMap under its usage policy) over scraping.
- Channel tiers tell you the risk: **A** official API, **B** public pages through search and polite reads,
  **C** needs a logged-in browser or is explicitly terms-sensitive. Tier C is off by default and needs two switches.
- The browser backend drives *your own* logged-in browser at low volume, with hourly caps and random pauses. It stops at
  login walls and captchas and **never solves or bypasses them**. Using it on social platforms is against most of their terms;
  your account may be restricted. You accept that risk by enabling it.
- Be a good citizen: set `LEADSCOUT_CONTACT` so site owners can reach you, keep volumes small, cache (Leadscout does).
- Licensed data: OpenStreetMap data is ODbL (attribute and share-alike if you publish a derived database). Third-party
  directory content belongs to them; Leadscout stores short factual fields with source URLs, not whole pages for republication.

## 2. Contacting people (calls, SMS, WhatsApp, email)

Cold outreach is regulated almost everywhere. Examples (non-exhaustive): US TCPA and Do-Not-Call registry, CAN-SPAM;
UK PECR and TPS; EU GDPR + ePrivacy; Canada CASL; Australia Spam Act and Do Not Call Register; India TRAI/TCCCPR DND rules;
many others. Typical requirements: lawful basis or consent, honest sender identity, a working opt-out, honouring registries,
calling-hour limits, recording-consent rules.

What Leadscout gives you:

- A **gate** (`src/gate.ts`) that keeps leads without a usable number, opted-out leads and (when you supply files) numbers on
  your do-not-call lists off the call sheet. Put the official registry exports in `data/dnd/` (see `data/dnd/README.md`).
  Leadscout does not download registries or know which one applies to you.
- An **opt-out list** (`src/compliance.ts`, `public/optout.html`, `POST /api/optout`) that suppresses a business or number everywhere.
- **Email sending is OFF** (`LEADSCOUT_SEND_ENABLED=0`, no SMTP configured) until you turn it on.
- Drafts only for WhatsApp and call scripts: it never sends WhatsApp messages or places calls for you.
- A **checklist** per outreach (`compliance.ts`) that reminds you of the basics.

What it cannot do: decide whether a particular call or message is lawful, or whether you may call a number at all.

## 3. Personal data

Business listings often contain personal data: a sole trader's name, a doctor's mobile number, an owner's email address.

- Collect what you need, no more. Say where you got it when asked (every phone/email is stored with its source URL and fetch time).
- Honour access, correction and deletion requests; delete the lead (and its call notes) from the SQLite file.
- **Call recordings and transcripts** (`recording-watcher`, `transcribe`) can need the other party's consent. Audio is
  deleted after transcription unless you set `LEADSCOUT_KEEP_AUDIO=1`. Transcription is local by default; cloud transcription
  (Groq) sends audio off your machine and needs two explicit switches.
- If you enable the **LLM**, dossier text (business facts, not your private notes) goes to the provider behind your adapter.
  Use `LEADSCOUT_LLM_OFF=1` to keep everything local.
- Protect the database file (`data/leadscout.db`): disk encryption, backups (`deploy/backup.ps1` uses SQLite `VACUUM INTO`),
  restrictive permissions. The server has no login by default and listens on localhost only. If you expose it, put it behind
  authentication and TLS, and set `LEADSCOUT_REQUIRE_KEYS=1`.

## 4. Accuracy

Scores, signals and "reach" are heuristics. Dossier facts are copied from public pages with citations to numbered evidence;
the system is built never to invent a number or claim, but pages can be wrong or stale. Verify before you quote a fact to a prospect.

## 5. Your checklist before the first real campaign

1. Which laws apply to my caller and to the people I will contact? Do I need registry screening or prior consent?
2. Have I put current DND/DNC exports in `data/dnd/`?
3. Is `LEADSCOUT_PLUGINS` limited to channels whose terms I have read?
4. Is email sending configured with a real unsubscribe path and a truthful From address?
5. Where is the database stored, who can read it, who can delete a person's data?
