#!/usr/bin/env python3
"""
============================================================================
 What the compose files actually render for the transcription service.

 Reads a rendered config on stdin:

     docker compose -f base.yml -f production.yml --env-file .env \\
         --profile whisper config | python3 compose_check.py

 WHY RENDER RATHER THAN READ THE YAML

 The file on disk is not what runs. Two overlays are merged, ${VAR}
 interpolation happens, short volume syntax becomes long, and a profile
 decides whether the service exists at all. Every one of those is a place a
 change can look right in the file and be wrong in the container — and one of
 them, mounting the recordings volume without :ro, would hand a transcription
 service the ability to delete the recordings it is reading.

 So this asserts the rendered result, which is the thing docker will run.
============================================================================
"""
import sys

try:
    import yaml
except ImportError:
    print("  SKIP  pyyaml is not installed — pip install pyyaml to check the compose render")
    sys.exit(0)

PASS = FAILED = 0


def ok(what, cond):
    global PASS, FAILED
    if cond:
        PASS += 1
        print(f"    ok  {what}")
    else:
        FAILED += 1
        print(f"  FAIL  {what}")


c = yaml.safe_load(sys.stdin)
services = c.get("services") or {}
w = services.get("whisper")

print("\n  the transcription service, as rendered")
if w is None:
    print("  FAIL  the whisper service is not in the rendered config.")
    print("        Run  python3 infra/apply-whisper.py .  and render with --profile whisper")
    sys.exit(1)
PASS += 1
print("    ok  the service is there")

ok("it is behind the 'whisper' profile, so an ordinary deploy does not start it",
   w.get("profiles") == ["whisper"])
ok("it is BUILT from infra/whisper, not pulled — the point is that nothing leaves the box",
   "build" in w and "image" not in w)

env = w.get("environment") or {}
ok("the model defaults to 'small'", env.get("WHISPER_MODEL") == "small")
ok("int8 on cpu — no CUDA on a box that has no GPU",
   env.get("WHISPER_COMPUTE") == "int8" and env.get("WHISPER_DEVICE") == "cpu")
ok("threads are capped at 2 rather than taking every core from the SFU",
   str(env.get("WHISPER_THREADS")) == "2")

volumes = w.get("volumes") or []
recordings = [v for v in volumes if str(v.get("target", "")).endswith("/recordings")]
# The one that matters. A transcription service that can delete recordings is
# a transcription service that will, the first time a path is wrong.
ok("the recordings volume is mounted READ ONLY",
   bool(recordings) and recordings[0].get("read_only") is True)
ok("the model weights have their own volume, so they are fetched once",
   any(v.get("target") == "/models" for v in volumes))

ok("it is on the api's network", "mailnet" in (w.get("networks") or {}))

limits = ((w.get("deploy") or {}).get("resources") or {}).get("limits") or {}
ok("memory is capped", str(limits.get("memory", "")).startswith("2"))
# Compose normalises "2.0" to the number 2, so compare as a number — asserting
# the string passed until the first time it was rendered rather than read.
try:
    cpus = float(limits.get("cpus", 0))
except (TypeError, ValueError):
    cpus = 0.0
ok("cpu is capped too, because cpu_threads governs the model and not ffmpeg", cpus == 2.0)
ok("logs are rotated like every other service here",
   ((w.get("logging") or {}).get("options") or {}).get("max-size") == "50m")

ok("the weights volume is declared at the top level",
   "whispermodels" in (c.get("volumes") or {}))

print("\n  and nothing else moved")
ok("egress is still there", "egress" in services)
api = (services.get("api") or {}).get("environment") or {}
# The important negative. Adding the service must not, by itself, start
# sending audio anywhere: the API's transcription URL stays empty until
# somebody sets it in .env.
ok("the api's transcription url is still empty unless .env sets it",
   api.get("Connect__Recording__TranscriptionUrl") in ("", None))
ok("recording itself is still off by default",
   str(api.get("Connect__Recording__Enabled", "false")).lower() == "false")

print(f"\n  {PASS} ok, {FAILED} failed")
sys.exit(0 if FAILED == 0 else 1)
