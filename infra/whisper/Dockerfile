# ============================================================================
#  Transcription, on this box.
#
#  Built rather than pulled, and that is the point: the alternative was
#  pointing Connect at OpenAI, and a fee committee discussing named children
#  is not something to post to a vendor because it was the easiest
#  integration. Nothing leaves the machine.
#
#  CPU ONLY. The box has no GPU and this image does not pretend otherwise —
#  no CUDA layers, no torch, nothing that adds two gigabytes to an image that
#  cannot use it. ctranslate2 under faster-whisper does the work in int8,
#  which on this hardware is roughly four times faster than float32 for a
#  difference in word error rate that does not survive a room microphone.
#
#  IT IS ALSO OFF. The compose service sits behind a profile, so this image is
#  not built and this container is not started unless somebody asks. See
#  infra/docker/docker-compose.base.yml.
# ============================================================================
FROM python:3.12-slim

# ffmpeg for decoding. faster-whisper can usually decode through PyAV without
# it, but "usually" covers the formats it was tested on, and this platform
# feeds it whatever egress wrote — OGG today, MP4 the moment somebody records
# video. ffmpeg is 60 MB and removes a whole class of "it works for audio".
#
# --no-install-recommends keeps that to ffmpeg rather than ffmpeg and a
# desktop's worth of codecs nobody asked for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Requirements first, and alone. Docker caches by layer, so a change to app.py
# must not reinstall ctranslate2 — which is the slow part of this build by a
# wide margin.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# WHERE THE WEIGHTS LIVE, AND WHY IT IS A VOLUME.
#
# The model downloads on first use, not at build time. Baking it in would make
# the image several gigabytes and would pin the choice of model to a rebuild;
# downloading at start would mean a container that cannot start without
# internet access. A volume means it is fetched once, kept, and the model is
# an environment variable.
ENV WHISPER_CACHE=/models
RUN mkdir -p /models

# A NON-ROOT USER, and a specific uid so the volume's ownership is something
# an operator can set rather than discover. The recordings volume already
# taught this module that lesson: a uid assumed from a Dockerfile rather than
# asked for cost a night, and every recording ran to completion and then died
# with "permission denied".
#
# This container only ever READS the recordings volume — it never writes to
# it — so it wants group read, nothing more.
RUN useradd --uid 5200 --create-home --shell /usr/sbin/nologin whisper \
 && chown -R whisper:whisper /models /srv
USER whisper

EXPOSE 8000

# One worker. Two would load the model twice into the memory of a box that is
# also carrying the SFU, and the caller is a worker with a queue that is
# perfectly happy to wait its turn.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
