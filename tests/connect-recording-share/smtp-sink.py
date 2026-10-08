"""A mail server that accepts everything and keeps it, for reading what the API
sent. One file per message in the directory given, raw DATA as received.

Not aiosmtpd and not smtpd: the first is not installed on the laptop and the
second was removed in Python 3.12. Twenty lines of socket are cheaper than
either dependency and speak exactly the subset MailKit uses without TLS.
"""
import socket
import sys
import threading
import uuid
from pathlib import Path

port = int(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)


def serve(conn):
    f = conn.makefile("rb")
    say = lambda s: conn.sendall((s + "\r\n").encode())
    say("220 sink ready")
    while True:
        line = f.readline()
        if not line:
            break
        cmd = line.decode(errors="replace").strip().upper()
        if cmd.startswith("EHLO"):
            conn.sendall(b"250-sink\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n")
        elif cmd == "DATA":
            say("354 go ahead")
            data = []
            while True:
                l = f.readline()
                if l in (b".\r\n", b".\n", b""):
                    break
                data.append(l)
            (out / f"{uuid.uuid4().hex}.eml").write_bytes(b"".join(data))
            say("250 kept")
        elif cmd == "QUIT":
            say("221 bye")
            break
        else:
            say("250 ok")
    conn.close()


s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen()
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
