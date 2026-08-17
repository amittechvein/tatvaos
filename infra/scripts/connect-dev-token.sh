#!/usr/bin/env bash
# ============================================================================
#  Connect Phase 0 — mint a test token for the /connect/dev page.
#
#      bash infra/scripts/connect-dev-token.sh amit
#      bash infra/scripts/connect-dev-token.sh priya-phone room2 4
#
#  Args: <identity> [room] [hours]   (defaults: room "dev", 12 hours)
#  Prints ONE line — the token — so it can be piped or copied clean.
#
#  Reads LIVEKIT_API_KEY / LIVEKIT_API_SECRET from infra/docker/.env on the
#  box. Pure python3 stdlib — no docker image, no npm, no network. The JWT it
#  produces was verified against the official livekit-server-sdk verifier
#  (claim-for-claim identical to the SDK's own AccessToken output).
#
#  Phase 0 is deliberately API-free: tokens come from here, never from a
#  browser, and the key pair never leaves the box. The real token mint is
#  Phase 1's /join endpoint — docs/CONNECT_API.md.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

IDENTITY="${1:?usage: connect-dev-token.sh <identity> [room] [hours]}"
ROOM="${2:-dev}"
HOURS="${3:-12}"
ENV_FILE=infra/docker/.env

KEY=$(grep -E '^LIVEKIT_API_KEY='    "$ENV_FILE" | tail -1 | cut -d= -f2-)
SECRET=$(grep -E '^LIVEKIT_API_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
if [ -z "$KEY" ] || [ -z "$SECRET" ]; then
    echo "LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set in $ENV_FILE" >&2
    exit 1
fi

LK_KEY="$KEY" LK_SECRET="$SECRET" LK_ID="$IDENTITY" LK_ROOM="$ROOM" LK_HOURS="$HOURS" \
python3 - << 'PYEOF'
import base64, hashlib, hmac, json, os, time

def b64(d: bytes) -> bytes:
    return base64.urlsafe_b64encode(d).rstrip(b"=")

key, secret = os.environ["LK_KEY"], os.environ["LK_SECRET"]
identity, room = os.environ["LK_ID"], os.environ["LK_ROOM"]
hours = float(os.environ["LK_HOURS"])

now = int(time.time())
header = {"alg": "HS256", "typ": "JWT"}
claims = {
    "iss": key,                      # API key
    "sub": identity,                 # LiveKit identity
    "name": identity,
    "nbf": now - 10,
    "exp": now + int(hours * 3600),
    "video": {                       # room-scoped grant — never "any room"
        "roomJoin": True,
        "room": room,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishData": True,
    },
}
si = b64(json.dumps(header, separators=(",", ":")).encode()) + b"." + \
     b64(json.dumps(claims, separators=(",", ":")).encode())
sig = hmac.new(secret.encode(), si, hashlib.sha256).digest()
print((si + b"." + b64(sig)).decode())
PYEOF
