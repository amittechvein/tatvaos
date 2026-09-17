# Multi-stage. The runtime image carries no SDK, no source and no build tools -
# a smaller attack surface as much as a smaller image.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY TatvaOS.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .

# ---------------------------------------------------------------------------
#  libfontconfig1 — for SkiaSharp (Space thumbnails).
#
#  SkiaSharp.NativeAssets.Linux ships libSkiaSharp.so, which links against
#  fontconfig. The .NET runtime images are deliberately slim and do not carry
#  it, so without this line the native library fails to load — and it fails at
#  PROCESS START, not on the first thumbnail request, because the assembly is
#  resolved eagerly. The whole API would refuse to boot, with a DllNotFound
#  message that says nothing about thumbnails.
#
#  Thumbnails need no fonts; fontconfig is simply an unconditional dependency
#  of the Skia build. Installed with --no-install-recommends and the apt lists
#  removed in the same layer, which keeps the addition to a couple of MB.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
#  ffmpeg — to get the speech out of a video recording before transcribing it.
#
#  Connect records MP4 when a meeting has video, because that is what somebody
#  wants to watch back. But 95 seconds of 720p is 36 MB, and OpenAI's
#  transcription endpoint refuses anything over 25 MB — so on 22 August 2026
#  the very first real recording failed, and so would every meeting after it,
#  including short ones. The failure read as an AI problem. It was arithmetic.
#
#  ffmpeg strips the picture and writes mono 16 kHz Opus: about 11 MB an hour
#  instead of 36 MB a minute, and no worse for the model, which resamples to
#  16 kHz mono regardless. See ConnectTranscriber.PrepareAudioAsync.
#
#  ~60 MB in the image for a feature that cannot work without it. The
#  transcriber falls back to sending the original file if this is ever missing,
#  so an image built without it degrades rather than breaks.
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends libfontconfig1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
#  Never run as root. A container escape should not land on a root shell.
#
#  Uses the non-root user Microsoft already ships in the runtime image (app,
#  UID 1654, exposed as $APP_UID) rather than creating one. The previous
#  version ran `adduser`, which does not exist in these images - it is a
#  Debian perl script from the adduser package, and the .NET runtime images
#  are slim enough not to carry it. That failed with exit 127.
#
#  Note there is deliberately no chown of /app. The published files stay owned
#  by root and readable by app, so the process cannot modify its own binaries.
#  Chowning them to the runtime user would make an RCE self-persisting.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
#  /dkim — where DKIM private keys are materialised for OpenDKIM.
#
#  Created here, owned by the runtime user, BEFORE the volume is mounted.
#  Docker seeds a fresh named volume from the image's directory, ownership
#  included — so this line is what makes the volume writable by a non-root
#  process. Without it the mount arrives root-owned, every key write fails
#  with EACCES, and the only symptom is that outbound mail is never signed.
#
#  0700: the API is the sole writer. OpenDKIM reads through its own container,
#  where the entrypoint runs as root before dropping privilege.
# ---------------------------------------------------------------------------
#  Owned by 5000 (vmail), NOT $APP_UID. The container runs as vmail so the
#  ingest worker can read Dovecot's private maildir (see the `user:` note in
#  docker-compose.base.yml). /dkim must therefore be writable by 5000 too, or
#  DKIM key generation on a new domain fails with EACCES and outbound mail is
#  never signed. On a FRESH deploy Docker seeds the dkim volume from this
#  directory's ownership; an EXISTING volume keeps its old ownership, so a
#  one-time `chown 5000:5000` of the dkimkeys volume is needed when migrating.
RUN mkdir -p /dkim && chown 5000:5000 /dkim && chmod 700 /dkim
# Same for the OpenID Connect provider's keys (decision 0004): a fresh
# oidckeys volume takes this directory's ownership; the API generates the
# first key pair on its first start and rotates them with --oidc-rotate.
RUN mkdir -p /oidc && chown 5000:5000 /oidc && chmod 700 /oidc

# vmail — uid/gid 5000, matching Dovecot's mail user. Numeric on purpose: the
# slim runtime image has no such named account, and Docker does not need one.
USER 5000:5000

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

# ---------------------------------------------------------------------------
#  No HEALTHCHECK here, on purpose.
#
#  These images ship no wget and no curl, so the old check could never pass -
#  the container would sit permanently "unhealthy" while serving traffic
#  perfectly, which is worse than no check because it trains everyone to
#  ignore the column.
#
#  Adding curl would fix the check and hand an attacker with code execution a
#  ready-made exfiltration tool inside the container that holds customer mail.
#  Not worth it: liveness is covered by `restart: unless-stopped` for crashes,
#  and the deploy workflow's smoke test hits /health from outside, which
#  exercises Caddy and TLS too - more of the real path than a loopback check.
# ---------------------------------------------------------------------------

ENTRYPOINT ["dotnet", "TatvaOS.Api.dll"]
