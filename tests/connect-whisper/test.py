#!/usr/bin/env python3
"""
============================================================================
 The transcription shim, tested against the request the API actually sends.

     bash infra/scripts/connect-whisper-test.sh

 WHY THIS EXISTS

 infra/whisper/app.py sits between ConnectTranscriber and faster-whisper, and
 the whole value of it is that it speaks the OpenAI /v1/audio/transcriptions
 contract exactly. "Exactly" is not something to eyeball: the fields are a
 multipart form, the response is read by a C# file one repository away, and
 the failure mode of getting it slightly wrong is a transcript that silently
 has no timeline — which produces notes that look fine and cannot tell a
 two-minute answer from a passing remark.

 So the requests below are built to match ConnectTranscriber.cs field for
 field: `file` with its real name, `model`, `response_format=verbose_json`,
 an optional `language`, and an optional Bearer header. If that file changes,
 this should be the thing that notices.

 faster-whisper itself is FAKED. Not to avoid the work — because the thing
 under test is the contract, and a real model would make this a test of
 whether a download succeeded. What is real: the FastAPI app, the multipart
 parsing, the temp file, the auth, the limits, the error mapping, and the
 exact shape of the JSON that goes back.
============================================================================
"""

from __future__ import annotations

import io
import json
import os
import sys
import types
from pathlib import Path

# ── the fake model, installed before app.py imports it ──────────────────────


class FakeSegment:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


class FakeInfo:
    def __init__(self, language="en", duration=12.5):
        self.language, self.duration = language, duration


class FakeModel:
    """Records what it was asked, so the test can assert on it."""

    last = None

    def __init__(self, model, device=None, compute_type=None, cpu_threads=None,
                 download_root=None):
        FakeModel.last = self
        self.model, self.device = model, device
        self.compute_type, self.cpu_threads = compute_type, cpu_threads
        self.path = None
        self.kwargs = None
        self.raise_with = None

    def transcribe(self, path, **kwargs):
        self.path = path
        self.kwargs = kwargs
        if FAIL["next"]:
            FAIL["next"] = False
            raise RuntimeError("ffmpeg exited with code 1")
        return (
            iter([
                FakeSegment(0.0, 4.321, "  Good morning everyone.  "),
                FakeSegment(4.321, 11.08, "Let us start with the fee structure."),
                FakeSegment(11.08, 11.2, "   "),        # blank: must be dropped
            ]),
            FakeInfo(),
        )


FAIL = {"next": False}

fake = types.ModuleType("faster_whisper")
fake.WhisperModel = FakeModel                                  # type: ignore[attr-defined]
sys.modules["faster_whisper"] = fake

# ── load the REAL app ───────────────────────────────────────────────────────

HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "infra" / "whisper"))

os.environ.setdefault("WHISPER_MODEL", "small")
os.environ.setdefault("WHISPER_THREADS", "2")

import app as shim                                             # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

client = TestClient(shim.app, raise_server_exceptions=False)

# ── harness ─────────────────────────────────────────────────────────────────

PASS = FAILED = 0


def ok(what, cond):
    global PASS, FAILED
    if cond:
        PASS += 1
        print(f"    ok  {what}")
    else:
        FAILED += 1
        print(f"  FAIL  {what}")


def section(title):
    print(f"\n  {title}")


def post(audio=b"OggS-not-really-audio", name="rec-0f9c1d2e.ogg",
         fmt="verbose_json", language=None, key=None, model="whisper-1"):
    """
    Exactly what ConnectTranscriber.cs builds. Field names, order and the
    filename all matter — most OpenAI-compatible servers decide how to decode
    from the extension rather than the content type, which is why the C# side
    goes out of its way to send a real one.
    """
    data = {"model": model, "response_format": fmt}
    if language:
        data["language"] = language
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    return client.post(
        "/v1/audio/transcriptions",
        files={"file": (name, io.BytesIO(audio), "audio/ogg")},
        data=data,
        headers=headers,
    )


print("\n  Transcription shim\n  ═══════════════════════════════════════════════════")

section("the response is the shape the API reads")
r = post()
ok("200", r.status_code == 200)
body = r.json()
ok("text is the whole transcript",
   body["text"] == "Good morning everyone. Let us start with the fee structure.")
ok("a blank segment is dropped rather than becoming an empty line",
   len(body["segments"]) == 2)
ok("segment text is trimmed", body["segments"][0]["text"] == "Good morning everyone.")
ok("start and end are NUMBERS, not strings — the notes step does arithmetic on them",
   isinstance(body["segments"][0]["start"], float)
   and isinstance(body["segments"][0]["end"], float))
ok("and they are the real offsets", body["segments"][1]["end"] == 11.08)
ok("language is reported", body["language"] == "en")
ok("duration is reported", body["duration"] == 12.5)
ok("segments are numbered from zero, in order",
   [s["id"] for s in body["segments"]] == [0, 1])

section("what the model is asked for")
m = FakeModel.last
ok("the file keeps its extension, because the decoder chooses by it",
   m.path.endswith(".ogg"))
ok("VAD is on — without it the model invents speech in the silences, and "
   "those inventions end up in the minutes",
   m.kwargs["vad_filter"] is True)
ok("previous text does not condition the next segment, so timestamps do not drift",
   m.kwargs["condition_on_previous_text"] is False)
ok("no language is sent as None, not as an empty string",
   m.kwargs["language"] is None)
ok("threads are capped rather than taking the whole box", m.cpu_threads == 2)
ok("int8 on cpu by default", m.compute_type == "int8" and m.device == "cpu")

r = post(language="hi")
ok("a configured language is passed through", FakeModel.last.kwargs["language"] == "hi")

r = post(name="meeting-2026-08-18.mp4")
ok("an mp4 recording keeps its extension too", FakeModel.last.path.endswith(".mp4"))

# A multipart part with no filename is not a file — the framework parses it as
# an ordinary form field and answers 422 before any of this code runs. Asserted
# rather than dropped, because it says exactly where that boundary is:
# ConnectTranscriber always sends Path.GetFileName(path), so this is not a case
# the platform can reach, and if it ever starts to the answer is a clear 422
# rather than a transcript of nothing.
r = post(name="")
ok("a part with no filename is refused by the framework, before this code",
   r.status_code == 422)

section("the model field is accepted and ignored, on purpose")
r = post(model="whisper-large-v3")
ok("asking for another model does not fail", r.status_code == 200)
ok("and does not load a second one on a box running the SFU",
   FakeModel.last.model == "small")

section("formats")
r = post(fmt="text")
ok("response_format=text gives plain text", r.status_code == 200
   and r.headers["content-type"].startswith("text/plain"))
ok("and it is the transcript", "fee structure" in r.text)

section("things that should be refused")
r = post(audio=b"")
ok("an empty file is 400, not a crash", r.status_code == 400)

shim.MAX_BYTES = 64
r = post(audio=b"x" * 4096)
ok("an oversized recording is 413 rather than filling the disk", r.status_code == 413)
shim.MAX_BYTES = 2 * 1024 * 1024 * 1024

section("the key, when one is set")
ok("no key configured means no check", post().status_code == 200)
shim.API_KEY = "s3cret"
ok("a missing key is 401", post().status_code == 401)
ok("a wrong key is 401", post(key="wrong").status_code == 401)
ok("the right key is 200", post(key="s3cret").status_code == 200)
shim.API_KEY = ""

section("when the model fails")
# The app logs the traceback, correctly — on the box that is exactly what an
# operator needs. In a test run it reads like the test itself crashed, so it is
# silenced for the two cases that fail on purpose and turned straight back on.
import logging  # noqa: E402
shim.log.setLevel(logging.CRITICAL)
FAIL["next"] = True
r = post()
ok("a decode failure is 502, not 500 — the caller tells 'broken' from "
   "'could not do this one'", r.status_code == 502)
ok("and the reason comes back so it can be stored on the row",
   "ffmpeg" in json.dumps(r.json()))
ok("the next request still works — one bad recording does not poison the service",
   post().status_code == 200)

section("temp files do not accumulate")
before = len(list(Path("/tmp").glob("*.ogg")))
for _ in range(5):
    post()
FAIL["next"] = True
post()
after = len(list(Path("/tmp").glob("*.ogg")))
ok("every upload is cleaned up, including the one that failed", after == before)

section("health says which of three states it is in")
shim.log.setLevel(logging.INFO)
h = client.get("/health").json()
ok("it reports the model", h["model"] == "small")
ok("and whether it is loaded", h["loaded"] is True)
ok("and carries no error when there is none", h["error"] is None)

print(f"\n  ═══════════════════════════════════════════════════\n  {PASS} ok, {FAILED} failed\n")
sys.exit(0 if FAILED == 0 else 1)
