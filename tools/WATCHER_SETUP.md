# Call recording setup (phone side)

This guide is for the person who makes the calls. It explains how to record calls
on the phone, how to get the recordings onto the laptop that runs Leadscout, and
what happens to the audio and the transcript afterwards.

The watcher that does the work is `src/recording-watcher.ts`.
It watches a folder, transcribes each new recording **locally**, matches it to a
lead by phone number, and creates a **draft** call note for you to review. It never
confirms a call on its own.

## Before you start: two warnings

1. **iPhone cannot record calls.** Apple does not allow an app to record a phone
   call on iOS. You need an Android phone for this flow. (Google Phone call
   recording is also not available in every country, including much of India.)
2. **Tell the other person you are recording.** Call recording laws differ by
   place and many require the other person's consent. Say that you are recording
   before the call starts, or do not record. Recording without disclosure can be
   illegal and is never worth the risk.

## Step 1: turn on the phone's built-in call recording

Use the phone's own recorder; do not install a third-party recorder unless your
phone has none.

- **Samsung (Phone app by Samsung):** open **Phone > three-dot menu > Settings >
  Record calls > Auto record calls** (or record manually with the **Record** button
  during a call). Recordings are saved to `Internal storage / Recordings / Call`
  (older models: `Sounds`).
- **Xiaomi / Redmi / POCO (MIUI / HyperOS):** open **Phone > Settings > Call
  recording > Record calls automatically** (or tap **Record** during a call).
  Recordings are saved under `MIUI/sound_recorder/call_rec`.
- **OnePlus (OxygenOS):** open **Phone > three-dot menu > Settings > Call
  recording > Record automatically**. Recordings are saved under
  `Recordings/Call recordings` (older builds use `Music/Recordings/Call recordings`).
- **Google Phone (Pixel and other phones with the Google dialer):** call recording
  is only offered where the law and Google allow it. If it is available, open
  **Phone > three-dot menu > Settings > Call recording > Always record**. If the
  option is missing, use the phone maker's dialer or your carrier's service.

Make one test call and confirm a recording file appears, so you know the exact
folder before wiring up the sync.

## Step 2: sync the recordings folder to the laptop

Pick one sync app and point it at the phone's call-recording folder
(`data/call-recordings/` on the laptop side).

- **Syncthing (open source, recommended).** Install Syncthing on the Android phone
  and on the laptop. Share the call-recording folder from the phone to the laptop,
  and set the laptop folder to `data/call-recordings/`. Use
  **Send Only** on the phone and **Receive Only** on the laptop so the laptop never
  changes your phone files.
- **Google Drive for desktop.** If you already back up the phone to Google Drive,
  install Google Drive for desktop on the laptop and point the mirror/stream of
  that folder at `data/call-recordings/`. This sends your
  recordings through Google's servers, so only use it if you are comfortable with
  that.
- **One-time copy.** You can also copy the folder over USB (or a file-sharing app)
  manually. The watcher only needs the files to land in the folder eventually.

The watcher treats a file as ready only after its size has stopped changing for
10 seconds, so a slow sync will not be transcribed half-way.

## Step 3: run the watcher

The watcher is **off until you start it**. Run it once per workspace, in the
foreground:

```
npx tsx src/recording-watcher.ts <workspaceId>
```

- Folder: env `LEADSCOUT_RECORDINGS_DIR` (default
  `data/call-recordings/`).
- Workspace id: the first argument, or env `LEADSCOUT_WORKSPACE`.
- Scan interval: env `LEADSCOUT_WATCH_INTERVAL_MS` (default 15000).
- Transcription is **local** (faster-whisper, see `tools/WHISPER_SETUP.md`). The
  cloud path in `transcribe.ts` stays off unless `GROQ_API_KEY` **and**
  `LEADSCOUT_TRANSCRIBE_CLOUD=1` are both set.

For each recording the watcher:

1. reads a phone number and a call time from the file name (Samsung, Xiaomi,
   OnePlus, Google Phone and Truecaller naming styles);
2. normalises the number to E.164 (`+91...`) and matches a lead by the last
   10 digits;
3. transcribes the audio locally, then polishes the transcript into a structured
   note;
4. saves a **draft** call note with status `needs_review`;
5. **moves** the recording into `processed/` — it is never deleted;
6. remembers the file in `.watcher-state.json` so it is never processed twice.

If no lead matches the number, the file is listed as **unmatched** for manual
assignment and left where it is.

Review drafts in the Call desk (the "Recordings to review" list) and **confirm**
the ones that are right; confirming is what creates a real call log entry.

## Where the files live, and how to delete them

- **Audio recordings:** stay on your laptop under
  `data/call-recordings/` and, once processed, under
  `data/call-recordings/processed/`. They are **local only** —
  nothing uploads them unless you explicitly turned on the cloud transcription
  option in Step 3.
- **Transcripts and drafts:** stored in the local SQLite database
  (`data/leadscout.db`, table `call_notes`). They are **local
  only**.
- **State file:** `data/call-recordings/.watcher-state.json`
  records which files have been handled.

To delete recordings: stop the watcher, then delete the audio files in the
recordings folder and in `processed/`. To delete the matching transcripts, delete
the draft call notes in the Call desk (discard) or remove the `call_notes` rows
from the local database. Deleting a recording in the phone's recorder or the
synced folder does **not** delete anything on the laptop by itself.

Keep the recordings and transcripts only as long as you need them, and follow the
disclosure rule in the warning at the top for every call.
