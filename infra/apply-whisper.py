#!/usr/bin/env python3
"""Add the self-hosted transcription service to the compose files.

Same shape as apply-compose.py, and separate from it on purpose: that script
has already been applied to this repo, and re-running a script to get one new
edit means trusting its idempotence for six edits you did not want to think
about again. This one adds three things and can be run on its own.

Anchored string replacements, not a diff: a patch that fails to apply leaves
you guessing, whereas this refuses loudly and changes nothing. Every anchor is
asserted to appear EXACTLY ONCE, and running it twice is a no-op.

    python3 infra/apply-whisper.py .

NOTHING STARTS AFTER RUNNING THIS. The service sits behind a compose profile,
so it is neither built nor started until COMPOSE_PROFILES includes 'whisper'.
That is deliberate: transcription is CPU on a box that is already carrying the
SFU, and it is a decision, not a default.
"""
import sys, pathlib

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
BASE = ROOT / "infra/docker/docker-compose.base.yml"
PROD = ROOT / "infra/docker/docker-compose.production.yml"

# --------------------------------------------------------------------------
#  1. The service.
# --------------------------------------------------------------------------
NETWORKS_ANCHOR = "\n\nnetworks:\n  mailnet:\n"
WHISPER_SERVICE = '''
  # --------------------------------------------------------------------------
  #  Transcription, on this box.
  #
  #  ── WHY THIS IS HERE AT ALL. ─────────────────────────────────────────────
  #  ConnectTranscriber speaks the OpenAI /v1/audio/transcriptions contract,
  #  so pointing it at a vendor is three environment variables. The reason not
  #  to is the customer: a fee committee discussing named children, a clinic
  #  discussing patients. Connect's default is that NO audio leaves the
  #  server, and this is what makes that default survivable rather than a
  #  feature that never works.
  #
  #  ── IT IS OFF, AND STAYS OFF UNTIL SOMEBODY ASKS. ────────────────────────
  #  The profile below means this image is not built and this container is not
  #  started by an ordinary deploy. To turn it on, in infra/docker/.env:
  #
  #    COMPOSE_PROFILES=whisper
  #    CONNECT_TRANSCRIPTION_URL=http://whisper:8000/v1/audio/transcriptions
  #    CONNECT_TRANSCRIPTION_MODEL=small
  #    CONNECT_TRANSCRIPTION_LANGUAGE=en      # worth setting; see below
  #
  #  The API already reads all three (see Connect__Recording__Transcription*).
  #  Nothing else changes.
  #
  #  ── COST, HONESTLY. ──────────────────────────────────────────────────────
  #  'small' in int8 on CPU transcribes roughly 4-6x faster than real time on
  #  a couple of threads, so an hour-long meeting is ten to fifteen minutes of
  #  background work. That is why the notes worker does one at a time and why
  #  the thread count below is 2 rather than every core: a recording finishing
  #  ten minutes later is invisible, and a live meeting stuttering is not.
  #
  #  'base' is about twice as fast and noticeably worse on Indian-accented
  #  English; 'medium' is roughly three times slower than 'small' for a
  #  difference most people cannot hear. Start at 'small'.
  #
  #  SET THE LANGUAGE if the meetings are in one. Automatic detection is the
  #  single largest source of nonsense on short or noisy recordings — a
  #  thirty-second clip of a quiet room is regularly detected as Welsh.
  # --------------------------------------------------------------------------
  whisper:
    profiles: ["whisper"]
    build:
      context: ../whisper
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      WHISPER_MODEL: ${WHISPER_MODEL:-small}
      WHISPER_DEVICE: ${WHISPER_DEVICE:-cpu}
      WHISPER_COMPUTE: ${WHISPER_COMPUTE:-int8}
      # Two, not every core. This box carries the SFU.
      WHISPER_THREADS: ${WHISPER_THREADS:-2}
      # Empty is correct here: nothing outside the compose network can reach
      # this port. Set it, and CONNECT_TRANSCRIPTION_KEY to the same value, if
      # that ever stops being true.
      WHISPER_API_KEY: ${CONNECT_TRANSCRIPTION_KEY:-}
    volumes:
      # The weights, fetched once on the first transcription and kept. Not
      # baked into the image: that would make it several gigabytes and pin the
      # choice of model to a rebuild.
      - whispermodels:/models
      # The recordings, READ ONLY. This container decodes audio it did not
      # write and must never be able to delete a recording — :ro is the whole
      # of that guarantee, and it costs nothing.
      #
      # It reads through the API today, not from disk, so this mount is not
      # strictly needed. It is here because the alternative when that changes
      # is somebody adding it in a hurry without the :ro.
      - connectrec:/var/lib/connect/recordings:ro
    # No healthcheck: the image has no curl or wget, the same reason the api
    # and egress services have none. /health exists and is worth curling from
    # the api container when something looks wrong.
    networks: [mailnet]
'''

# --------------------------------------------------------------------------
#  2. Somewhere to keep the weights.
# --------------------------------------------------------------------------
VOLUMES_ANCHOR = "  connectrec:\n"
VOLUMES_ADD = "  whispermodels:\n"

# --------------------------------------------------------------------------
#  3. Production limits.
# --------------------------------------------------------------------------
PROD_ANCHOR = """  egress:
    deploy:
"""
PROD_ADD = """  whisper:
    deploy:
      resources:
        limits:
          # 'small' in int8 sits around 1 GB resident; 2 G is headroom for a
          # long recording and a hard stop well below what would take the box
          # down. Raise it BEFORE moving to 'medium', not after.
          memory: 2G
          # A hard ceiling as well as the thread count, because cpu_threads
          # governs the model and not ffmpeg's decoding.
          cpus: "2.0"
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "5" }

"""


def apply(path, edits, label):
    """edits: (marker, anchor, addition, where).

    `marker` must be a string that exists ONLY once this edit has been made —
    the same rule, and the same reason, as apply-compose.py: a marker derived
    from the addition's first line was once a substring of what an earlier
    edit inserted, and the later edit silently did nothing.
    """
    text = path.read_text(encoding="utf-8")
    original = text
    for marker, anchor, addition, where in edits:
        if marker in text:
            print(f"  = {label}: already applied — {marker.strip()[:52]}")
            continue
        n = text.count(anchor)
        if n != 1:
            raise SystemExit(
                f"REFUSING: anchor appears {n} times in {path.name}, expected exactly 1:\n"
                f"---\n{anchor}\n---")
        text = (text.replace(anchor, anchor + addition) if where == "after"
                else text.replace(anchor, addition + anchor))
        if marker not in text:
            raise SystemExit(f"REFUSING: {label} edit did not take — marker absent after write.")
    if text != original:
        path.write_text(text, encoding="utf-8")
        print(f"  + {label}: written")
    return text != original


if not BASE.exists():
    raise SystemExit(f"REFUSING: {BASE} not found — run this from the repo root.")
if not (ROOT / "infra/whisper/Dockerfile").exists():
    raise SystemExit("REFUSING: infra/whisper/Dockerfile not found — unpack it first.")

apply(BASE, [
    ('profiles: ["whisper"]', NETWORKS_ANCHOR, WHISPER_SERVICE, "before"),
    ("\n  whispermodels:\n", VOLUMES_ANCHOR, VOLUMES_ADD, "after"),
], "compose base")

apply(PROD, [("  whisper:\n    deploy:", PROD_ANCHOR, PROD_ADD, "before")], "production overlay")

print("""
done.

Nothing has started. To actually turn transcription on, add to
infra/docker/.env:

    COMPOSE_PROFILES=whisper
    CONNECT_TRANSCRIPTION_URL=http://whisper:8000/v1/audio/transcriptions
    CONNECT_TRANSCRIPTION_MODEL=small
    CONNECT_TRANSCRIPTION_LANGUAGE=en

then deploy. The first transcription downloads the model, so it takes several
minutes longer than the rest will.""")
