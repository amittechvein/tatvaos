#!/usr/bin/env python3
"""
The From-line filter for port 587: a mail filter (milter) Postfix consults
for SIGNED-IN submissions only. It applies the same ownership rule as
Postfix's envelope check, mail.sender_logins(), to the visible From: line,
and keeps the evidence record for warn mode.

WHY. 2 Oct 2026: port 587 let a signed-in user send as any address. PR 380
makes Postfix refuse an envelope sender the user does not own
(reject_authenticated_sender_login_mismatch). But mail apps show the person
the From: HEADER, and Postfix cannot compare a header with the sign-in.
Mr. Singh: "Apply the same ownership rule to From: on port 587, so a message
with an honest envelope and a forged From: is refused as well." Only a milter
sees both the sign-in ({auth_authen}) and the headers.

TWO MODES, from /etc/postfix/sender-ownership-mode (the entrypoint writes it
from TATVAOS_SENDER_OWNERSHIP; read again for every message):
  warn     (how it first ships, Amit 2 Oct): nothing is refused; every
           message that WOULD be (envelope or From: not owned) is written to
           /var/log/tatvaos/sender-ownership-YYYY-MM.jsonl (one file per UTC
           month), on the maillogs volume,
           so it survives deploys. Postfix's own log (container stdout) is
           lost at every deploy, which is why the 30-day count Mr. Singh asked
           for could not be made. This record is that count, from now on.
  enforce  a From: the signed-in mailbox does not own is refused, 550 5.7.1,
           after the headers. (The envelope is refused by Postfix itself.)

THE RECORD holds, per mismatch: time, kind (envelope|header), mode, action,
class, the sign-in's organisation id, the claimed address's organisation id
and type, and a 12-character hash of the sign-in (to count people without
naming them). NEVER an address - the test asserts the file has no '@'.
Classes: other_org, same_org_shared_no_right (the fixable case: add the
permission), same_org_other, not_hosted, unreadable.

FAILURE. If the database is unreachable: warn continues; enforce answers 451
(try later). If this process is down, Postfix's per-milter default_action
(accept, main.cf) lets mail through and the envelope check - Postfix's own,
not this - still holds. The entrypoint restarts it.

The milter protocol (Sendmail milter, version 6): a 4-byte length, a command
byte, data. Postfix sends the negotiation, macros, MAIL FROM, each header,
end-of-headers, end-of-message; we answer "continue", or a reply code. No
modification of the message, ever (actions = 0).

local/scripts/test-mail.sh, section "Port 587", runs it through the real
Postfix: refused forged From: in enforce, recorded mismatches in warn.
"""
import hashlib
import json
import os
import pwd
import socketserver
import struct
import sys
import threading
import time
from email.utils import getaddresses

import psycopg2

LISTEN = ("127.0.0.1", int(os.environ.get("SENDER_MILTER_PORT", "10028")))
MODE_FILE = "/etc/postfix/sender-ownership-mode"
LOOKUP_CF = "/etc/postfix/sql/sender-login-maps.cf"   # rendered: the mail edge's credentials
EVIDENCE_DIR = "/var/log/tatvaos"
RUN_AS = "postfix"
DB_SETTINGS = {}            # read ONCE, as root, before the privilege drop


def evidence_path():
    """One file per UTC month (Mr. Singh, 3 Oct: rotate it so it stays readable)."""
    return f"{EVIDENCE_DIR}/sender-ownership-{time.strftime('%Y-%m', time.gmtime())}.jsonl"

# Protocol flags we ask Postfix NOT to send (only those it offers are kept).
NO_CONNECT, NO_HELO, NO_RCPT, NO_BODY, NO_UNKNOWN, NO_DATA = 0x1, 0x2, 0x8, 0x10, 0x100, 0x200
WANT_SKIPPED = NO_CONNECT | NO_HELO | NO_RCPT | NO_BODY | NO_UNKNOWN | NO_DATA
REFUSAL = b"550 5.7.1 The From: address is not one this signed-in mailbox may send as\0"
TRY_LATER = b"451 4.3.0 Sender ownership could not be checked, try again later\0"

_evidence_lock = threading.Lock()


def log(msg):
    print(f"[sender-milter] {msg}", flush=True)


def mode():
    try:
        with open(MODE_FILE, encoding="utf-8") as f:
            m = f.read().strip()
    except OSError:
        return "warn"
    return m if m in ("warn", "enforce") else "warn"


def db_settings():
    """hosts/user/password/dbname from the rendered Postfix lookup file: one
    source for the mail edge's credentials, never a second copy."""
    out = {}
    with open(LOOKUP_CF, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = (p.strip() for p in line.split("=", 1))
            if k in ("hosts", "user", "password", "dbname"):
                out[k] = v
    return out


class Db:
    def __init__(self):
        self.conn = None

    def _cur(self):
        if self.conn is None or self.conn.closed:
            s = DB_SETTINGS
            self.conn = psycopg2.connect(host=s["hosts"].split()[0], user=s["user"],
                                         password=s["password"], dbname=s["dbname"], connect_timeout=5)
            self.conn.autocommit = True
        return self.conn.cursor()

    def owns(self, login, address):
        with self._cur() as c:
            c.execute("SELECT mail.sender_logins(%s)", (address,))
            row = c.fetchone()
        owners = (row[0] or "") if row else ""
        return login.lower() in {o.strip().lower() for o in owners.split(",") if o.strip()}

    def tenant_of_login(self, login):
        with self._cur() as c:
            c.execute("SELECT tenant_id::text FROM mail.mailboxes WHERE lower(address::text) = lower(%s) LIMIT 1", (login,))
            row = c.fetchone()
        return row[0] if row else None

    def claimed(self, address):
        with self._cur() as c:
            c.execute("SELECT tenant_id::text, type FROM mail.mailboxes WHERE lower(address::text) = lower(%s) "
                      "UNION ALL SELECT tenant_id::text, 'alias' FROM mail.aliases WHERE lower(address::text) = lower(%s) "
                      "LIMIT 1", (address, address))
            row = c.fetchone()
        return (row[0], row[1]) if row else (None, None)

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass


def record(db, kind, m, action, login, address):
    login_tenant = db.tenant_of_login(login)
    if address is None:
        claimed_tenant, claimed_type, cls = None, None, "unreadable"
    else:
        claimed_tenant, claimed_type = db.claimed(address)
        if claimed_tenant is None:
            cls = "not_hosted"
        elif claimed_tenant != login_tenant:
            cls = "other_org"
        elif claimed_type == "shared":
            cls = "same_org_shared_no_right"
        else:
            cls = "same_org_other"
    line = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind, "mode": m, "action": action, "class": cls,
        "login_tenant": login_tenant, "claimed_tenant": claimed_tenant, "claimed_type": claimed_type,
        "login_hash": hashlib.sha256(login.lower().encode()).hexdigest()[:12],
    }
    with _evidence_lock:
        with open(evidence_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    log(f"{m}: {kind} not owned, class={cls} login_tenant={login_tenant} claimed_tenant={claimed_tenant} -> {action}")


class Session(socketserver.BaseRequestHandler):
    def setup(self):
        self.db = Db()
        self.macros = {}
        self.reset()

    def reset(self):
        self.envelope = None
        self.from_values = []

    def finish(self):
        self.db.close()

    def read_exactly(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.request.recv(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return buf

    def send(self, cmd, data=b""):
        self.request.sendall(struct.pack(">I", len(data) + 1) + cmd + data)

    def handle(self):
        try:
            while True:
                (length,) = struct.unpack(">I", self.read_exactly(4))
                packet = self.read_exactly(length)
                cmd, data = packet[:1], packet[1:]
                if cmd == b"O":                       # negotiate
                    ver, _actions, offered = struct.unpack(">III", data[:12])
                    self.send(b"O", struct.pack(">III", min(ver, 6), 0, WANT_SKIPPED & offered))
                elif cmd == b"D":                     # macros, no reply
                    parts = data[1:].split(b"\0")
                    for k, v in zip(parts[0::2], parts[1::2]):
                        self.macros[k.decode(errors="replace")] = v.decode(errors="replace")
                elif cmd == b"M":                     # MAIL FROM
                    self.reset()
                    self.envelope = data.split(b"\0")[0].decode(errors="replace").strip("<>")
                    self.send(b"c")
                elif cmd == b"L":                     # one header
                    name, _, rest = data.partition(b"\0")
                    if name.decode(errors="replace").lower() == "from":
                        self.from_values.append(rest.rstrip(b"\0").decode(errors="replace"))
                    self.send(b"c")
                elif cmd == b"N":                     # end of headers: the decision
                    self.end_of_headers()
                elif cmd == b"A":                     # abort this message, no reply
                    self.reset()
                elif cmd == b"K":                     # quit, new connection follows
                    self.reset()
                    self.macros = {}
                elif cmd == b"Q":
                    return
                else:                                 # C H R T B U E: nothing to decide
                    self.send(b"c")
        except (EOFError, ConnectionError):
            return

    def end_of_headers(self):
        login = (self.macros.get("{auth_authen}") or "").strip()
        if not login:                                  # not signed in: not ours to judge
            self.send(b"c")
            return
        m = mode()
        try:
            refuse = False
            env = self.envelope or ""
            if env and not self.db.owns(login, env):
                # In enforce mode Postfix has already refused this at RCPT; in
                # warn mode it reaches here, and this is its record.
                record(self.db, "envelope", m, "recorded", login, env)
            addresses = [a for _, a in getaddresses(self.from_values) if "@" in a]
            if self.from_values and not addresses:
                record(self.db, "header", m, "refused" if m == "enforce" else "recorded", login, None)
                refuse = True
            for a in addresses:
                if not self.db.owns(login, a):
                    record(self.db, "header", m, "refused" if m == "enforce" else "recorded", login, a)
                    refuse = True
            if refuse and m == "enforce":
                self.send(b"y", REFUSAL)
            else:
                self.send(b"c")
        except Exception as e:                         # the database, most likely
            log(f"could not check ({type(e).__name__}) - {'451' if m == 'enforce' else 'continuing'} ({m})")
            self.db.close()
            self.db = Db()
            self.send(b"y", TRY_LATER) if m == "enforce" else self.send(b"c")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def drop_privileges():
    """Root only long enough to read the owner-only credentials file and bind;
    every message is handled as the postfix user (Mr. Singh, 3 Oct: a header-
    reading program with database access must not stay root). Refuses to go
    on if the drop did not take - root silently kept is the failure mode."""
    u = pwd.getpwnam(RUN_AS)
    os.setgroups([])
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        log("FATAL: still root after the privilege drop - refusing to handle mail")
        sys.exit(1)
    return u.pw_uid


if __name__ == "__main__":
    DB_SETTINGS.update(db_settings())                    # as root: the file is 0600
    srv = Server(LISTEN, Session)                        # bind before the drop
    uid = drop_privileges()
    log(f"listening on {LISTEN[0]}:{LISTEN[1]} as {RUN_AS} (uid {uid}), mode={mode()}, record={evidence_path()}")
    try:
        Db()._cur().close()
        log("database reachable")
    except Exception as e:
        log(f"database not reachable yet ({type(e).__name__}) - will retry per message")
    with srv:
        srv.serve_forever()
