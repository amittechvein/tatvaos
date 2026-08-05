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
RUN mkdir -p /dkim && chown $APP_UID:$APP_UID /dkim && chmod 700 /dkim

USER $APP_UID

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
