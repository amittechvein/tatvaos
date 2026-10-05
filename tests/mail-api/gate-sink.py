#!/usr/bin/env python3
"""
A stand-in for Postfix's submission port, for tests/mail-api/test-bounce-gate.sh.

It makes the SAME decision Postfix makes, at the same moment, with the same
SQL: at MAIL FROM it runs the query in local/postfix/sql/sender-external-gate.cf
(as the mail edge's role, tatvaos_mailedge) for the envelope sender; at RCPT TO,
if that said 'internal_only', it allows the recipient only when the query in
local/postfix/sql/local-recipient-domains.cf finds its domain - exactly the
internal_only restriction class in local/postfix/main.cf - and otherwise
answers 550 5.7.1, as Postfix does.

Why a stand-in and not Postfix: no Docker on this laptop. What this cannot
show: Postfix's own parsing of the .cf files and its escaping of %s. CI's Mail
stack job runs the real Postfix. What it does show, and the test is about: the
gate's SQL, run at submit time, against the database the API is writing to.

Usage: gate-sink.py PORT PSQL_COMMAND TRANSCRIPT_FILE
  PSQL_COMMAND runs SQL given as its last argument, as a superuser, -At.
"""
import shlex
import socket
import subprocess
import sys
import threading

PORT = int(sys.argv[1])
PSQL = shlex.split(sys.argv[2])
LOG = sys.argv[3]
ROOT = sys.argv[4]


def cf_query(path):
    """The `query = ...` value of a Postfix pgsql .cf file, continuation lines included."""
    lines, take = [], False
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line.lstrip().startswith("#"):
                continue
            if line.startswith("query"):
                take = True
                lines.append(line.split("=", 1)[1])
            elif take and (line.startswith(" ") or line.startswith("\t")) and line.strip():
                lines.append(line)
            elif take:
                break
    return " ".join(l.strip() for l in lines)


GATE = cf_query(f"{ROOT}/local/postfix/sql/sender-external-gate.cf")
LOCAL = cf_query(f"{ROOT}/local/postfix/sql/local-recipient-domains.cf")


def as_mailedge(sql):
    """Run SQL as the mail edge's role; return the first row, or '' for none."""
    out = subprocess.run(PSQL + [f"SET ROLE tatvaos_mailedge; {sql}"],
                         capture_output=True, text=True)
    rows = [l for l in out.stdout.replace("\r", "").splitlines() if l and l != "SET"]
    if out.returncode != 0:
        return "ERROR " + out.stderr.strip().replace("\n", " ")[:200]
    return rows[0] if rows else ""


def q(s):
    """Postfix escapes %s/%d for SQL before substituting; so do we."""
    return s.replace("'", "''")


def log(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def serve(conn):
    f = conn.makefile("rwb", buffering=0)

    def say(text):
        f.write((text + "\r\n").encode())

    say("220 gate-sink ESMTP")
    gate_class, sender, in_data = "", "", False
    for raw in f:
        line = raw.decode(errors="replace").rstrip("\r\n")
        if in_data:
            if line == ".":
                in_data = False
                say("250 2.0.0 queued")
            continue
        verb = line[:4].upper()
        if verb in ("EHLO", "HELO"):
            say("250 gate-sink")
        elif line.upper().startswith("MAIL FROM:"):
            sender = line[10:].strip().split(" ")[0].strip("<>")
            gate_class = as_mailedge(GATE.replace("%s", q(sender)))
            log(f"MAIL {sender} gate=[{gate_class}]")
            say("250 2.1.0 ok")
        elif line.upper().startswith("RCPT TO:"):
            rcpt = line[8:].strip().split(" ")[0].strip("<>")
            if gate_class.startswith("ERROR"):
                log(f"RCPT {rcpt} -> 451 (gate query failed: {gate_class})")
                say("451 4.3.0 gate query failed")
            elif gate_class == "internal_only":
                domain = rcpt.rsplit("@", 1)[-1]
                local = as_mailedge(LOCAL.replace("%d", q(domain)).replace("%s", q(rcpt)))
                if local == "OK":
                    log(f"RCPT {rcpt} -> 250 (internal_only, local domain)")
                    say("250 2.1.5 ok")
                else:
                    log(f"RCPT {rcpt} -> 550 (internal_only, outside)")
                    say("550 5.7.1 Sending outside your organisation requires a verified domain.")
            else:
                log(f"RCPT {rcpt} -> 250 (gate allowed)")
                say("250 2.1.5 ok")
        elif verb == "DATA":
            in_data = True
            say("354 go ahead")
        elif verb == "RSET":
            gate_class, sender = "", ""
            say("250 ok")
        elif verb == "NOOP":
            say("250 ok")
        elif verb == "QUIT":
            say("221 bye")
            break
        else:
            say("502 5.5.2 not implemented")
    conn.close()


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(5)
log(f"READY port={PORT} gate_query=[{GATE[:80]}...]")
while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
