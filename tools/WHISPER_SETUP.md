# Local voice-note transcription setup (order CALL3)

Leadscout transcribes call voice notes **locally and privately** with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper). Nothing is sent to a
cloud service unless the operator explicitly turns it on (see "Cloud fallback"
below).

The order that adds this feature does **not** install anything. These are the
steps an operator runs by hand, on their own machine.

## 1. Create the virtual environment

From `` (so the venv lands where the code expects it):

```powershell
python -m venv deps\whisper-venv
```

The default launcher path used by `src/transcribe.ts` is:

```
deps/whisper-venv/Scripts/python.exe   (Windows)
deps/whisper-venv/bin/python           (macOS / Linux)
```

Set `LEADSCOUT_WHISPER_PY` to override it if the venv lives somewhere else.

## 2. Install faster-whisper

```powershell
deps\whisper-venv\Scripts\python.exe -m pip install --upgrade pip
deps\whisper-venv\Scripts\python.exe -m pip install faster-whisper
```

`faster-whisper` pulls in `ctranslate2` and `av`; no GPU is required. CPU with
`compute_type="int8"` is what `tools/whisper_run.py` uses by default.

## 3. First run downloads the model

The first transcription downloads the requested model size into the
faster-whisper/Hugging Face cache (a few hundred MB for `small`). Model sizes:
`tiny`, `base`, `small` (default), `medium`, `large-v3`. To pin a size, pass it
as the second argument to `tools/whisper_run.py` (`small` is the default).

## 4. Check it works

```powershell
deps\whisper-venv\Scripts\python.exe tools\whisper_run.py sample.wav small en
```

It prints one JSON line with `text`, `language` and `segments` (`start`/`end`
in seconds). A missing venv or a missing `faster-whisper` package produces a
clear error on stderr; the TypeScript wrapper turns that into a readable
`{ok:false, error}` result and never throws.

## 5. Cloud fallback (off by default)

The Groq Whisper endpoint is used **only** when BOTH environment variables are
set:

- `GROQ_API_KEY` — the API key
- `LEADSCOUT_TRANSCRIBE_CLOUD=1` — the explicit opt-in

If either is missing the cloud path is refused and only the local launcher runs.
Recordings are private by default; do not set these on a shared machine.
