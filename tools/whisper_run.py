#!/usr/bin/env python
"""Local faster-whisper runner for Leadscout voice notes (order CALL3).

Usage:
    python whisper_run.py <audio_path> [model_size] [language]

model_size defaults to "small"; language defaults to "auto" (auto-detect).

On success it prints ONE JSON object to stdout and exits 0:
    {"text": "...", "language": "en", "segments": [{"start": 0.0, "end": 1.2}, ...]}

Nothing else is written to stdout. Errors go to stderr with a non-zero exit code.
No network is used by this script: faster-whisper loads the model from its local
cache (downloaded on first use, see WHISPER_SETUP.md). The caller
(transcribe.ts) enforces the 180 second timeout and hides the window.
"""

import json
import sys


def main(argv):
    if len(argv) < 2 or not argv[1]:
        sys.stderr.write("usage: whisper_run.py <audio_path> [model_size] [language]\n")
        return 2

    audio_path = argv[1]
    model_size = argv[2] if len(argv) > 2 and argv[2] else "small"
    language = argv[3] if len(argv) > 3 and argv[3] else "auto"

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001 - report any import failure plainly
        sys.stderr.write("faster-whisper is not installed: %s\n" % exc)
        return 3

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        lang_arg = None if language in ("", "auto") else language
        segments, info = model.transcribe(audio_path, language=lang_arg, vad_filter=True)

        out_segments = []
        parts = []
        for segment in segments:
            parts.append(segment.text)
            out_segments.append({"start": float(segment.start), "end": float(segment.end)})

        detected = getattr(info, "language", None) or language
        result = {
            "text": "".join(parts).strip(),
            "language": detected,
            "segments": out_segments,
        }
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("transcription failed: %s\n" % exc)
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
