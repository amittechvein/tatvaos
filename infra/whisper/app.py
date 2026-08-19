"""
TatvaOS Connect — transcription, on this box.

═══════════════════════════════════════════════════════════════════════════
 WHY THIS EXISTS, AND WHY IT IS THIS SMALL.

 ConnectTranscriber speaks the OpenAI /v1/audio/transcriptions contract, and
 it speaks it because that contract is the one thing every transcription
 option has in common — OpenAI, Groq, a colleague's GPU box, or this. Which
 one a deployment uses is three environment variables, not a rebuild.

 The default is NONE. With no TranscriptionUrl set, no audio leaves this
 server and transcripts are honestly marked unavailable. That is the right
 default for a platform holding school meetings, and it is also why "just
 point it at OpenAI" was never the whole answer: a fee committee discussing
 named children is not something to post to a vendor because it was the
 easiest integration.

 So this: faster-whisper, on the same box, behind the same contract. Nothing
 leaves the machine. It is CPU-only by default because the box has no GPU,
 and it is OFF unless somebody starts the profile.

 WHAT THIS IS NOT. It is not a general OpenAI-compatible server. It
 implements exactly the request ConnectTranscriber sends and exactly the
 response ConnectTranscriber reads, and it says so, because a shim that
 pretends to be a whole API is a shim somebody points a second client at.
═══════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

log = logging.getLogger("whisper")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Configuration ──────────────────────────────────────────────────────────
#
# Every one of these is an environment variable with a default that works, so
# the service starts correctly with no configuration at all and every knob is
# a compose change rather than a rebuild.

MODEL = os.environ.get("WHISPER_MODEL", "small")

# int8 on CPU is not a corner cut: it is roughly 4× faster than float32 on the
# same box for a difference in word error rate that does not survive the noise
# of a room microphone. This box is already carrying the SFU.
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")

# Threads. Left at 0 the library takes every core, which on THIS box means
# transcription competes with the media server for the CPU that is carrying
# live meetings. A recording finishing ten minutes later is invisible; a
# meeting stuttering is not.
THREADS = int(os.environ.get("WHISPER_THREADS", "2"))

# The shared secret, if one is set. Empty means no check — correct on a
# compose network nothing else can reach, and wrong the moment this is
# exposed, so it is available and documented rather than absent.
API_KEY = os.environ.get("WHISPER_API_KEY", "").strip()

# One request at a time. Two hours of audio decoded concurrently on two
# threads each is four threads of the box gone, and the caller is a worker
# with a queue that is perfectly happy to wait.
LOCK = threading.Lock()

MAX_BYTES = int(os.environ.get("WHISPER_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))

app = FastAPI(title="TatvaOS Connect transcription", docs_url=None, redoc_url=None)

_model = None
_model_error: str | None = None


def load_model():
    """
    Loaded once, lazily, and kept.

    Lazily because the first load downloads weights, and a container that
    cannot start because a download failed is a container that takes the whole
    compose stack's health with it. This way the service starts, reports
    honestly on /health, and the first transcription is the thing that waits.
    """
    global _model, _model_error
    if _model is not None:
        return _model
    try:
        from faster_whisper import WhisperModel

        started = time.monotonic()
        log.info("loading model=%s device=%s compute=%s threads=%d",
                 MODEL, DEVICE, COMPUTE, THREADS)
        _model = WhisperModel(
            MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS,
            download_root=os.environ.get("WHISPER_CACHE", "/models"),
        )
        log.info("model ready in %.1fs", time.monotonic() - started)
        _model_error = None
        return _model
    except Exception as e:                                   # noqa: BLE001
        # Recorded, not raised at import: /health has to be able to SAY this.
        _model_error = f"{type(e).__name__}: {e}"
        log.error("model could not be loaded: %s", _model_error)
        raise


@app.get("/health")
def health():
    """
    Honest about three different states, because they need three different
    actions: not loaded yet (wait), loaded (fine), failed (look at the log).
    """
    return {
        "status": "ok",
        "model": MODEL,
        "device": DEVICE,
        "compute": COMPUTE,
        "loaded": _model is not None,
        "error": _model_error,
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form(default=""),
    response_format: str = Form(default="json"),
    language: str = Form(default=""),
):
    """
    The one endpoint, and the exact shape ConnectTranscriber sends.

    `model` is ACCEPTED AND IGNORED, deliberately. This process has one model
    loaded; honouring the field would mean loading a second on demand, on a
    box that is also running the SFU. The caller sends it because the OpenAI
    contract requires it, and pretending to switch would be worse than plainly
    not switching.
    """
    if API_KEY:
        sent = request.headers.get("authorization", "")
        expected = f"Bearer {API_KEY}"
        # Length-independent compare would be better; this is a shared secret
        # on a private network, and the honest note is worth more than the
        # false comfort of a constant-time compare over a variable-length
        # header that has already been split.
        if sent != expected:
            raise HTTPException(status_code=401, detail="Bad or missing key.")

    # The FILE NAME matters: the decoder chooses by extension. ogg from an
    # audio recording, mp4 from a video one. A name we do not recognise still
    # gets tried — ffmpeg is better at guessing than we are.
    name = Path(file.filename or "audio.ogg").name
    suffix = Path(name).suffix or ".ogg"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        path = tmp.name
        written = 0
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_BYTES:
                tmp.close()
                Path(path).unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="That recording is too large.")
            tmp.write(chunk)

    if written == 0:
        Path(path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty file.")

    try:
        with LOCK:
            result = run(path, language)
    except HTTPException:
        raise
    except Exception as e:                                   # noqa: BLE001
        log.exception("transcription failed")
        # 502, not 500: the caller distinguishes "the service is broken" from
        # "the service could not do this one", and marks the transcript
        # accordingly rather than retrying forever.
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})
    finally:
        Path(path).unlink(missing_ok=True)

    if response_format == "text":
        return JSONResponse(content=result["text"], media_type="text/plain")

    # verbose_json is what the caller asks for, and the timeline is the reason:
    # a wall of text cannot be jumped through and gives the notes step no way
    # to tell a two-minute answer from a passing remark.
    return result


def run(path: str, language: str) -> dict:
    whisper = load_model()

    segments, info = whisper.transcribe(
        path,
        language=language or None,
        # VAD, because a recording of a class is mostly silence and a room
        # tone. Without it the model hallucinates confidently into the gaps —
        # the classic "thank you for watching" at the end of every quiet
        # stretch — and those inventions end up in the minutes.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=int(os.environ.get("WHISPER_BEAM", "1")),
        # Whisper's own timestamps drift on long audio; this keeps them
        # anchored, which matters because the notes are timestamped from them.
        condition_on_previous_text=False,
    )

    out = []
    text_parts = []
    for s in segments:                      # a generator: this is where the work happens
        body = (s.text or "").strip()
        if not body:
            continue
        out.append({
            "id": len(out),
            "start": round(float(s.start), 3),
            "end": round(float(s.end), 3),
            "text": body,
        })
        text_parts.append(body)

    return {
        "task": "transcribe",
        "language": getattr(info, "language", "") or language or "",
        "duration": round(float(getattr(info, "duration", 0.0)), 3),
        "text": " ".join(text_parts),
        "segments": out,
    }
