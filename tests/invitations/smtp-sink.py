#!/usr/bin/env python
"""
A mail server that accepts everything and keeps it, for tests that have to
COUNT what was sent. No mail server runs locally, so without this every send
answers "not delivered" and the delivered path is never exercised.

  python smtp-sink.py PORT DIR

Each accepted message is written to DIR/<n>.eml with an "X-Sink-Rcpt:" line
first, naming who it was for, and announced on stdout as "kept <n> for <who>".
A second sink started on the same DIR numbers from 1 again, so empty the
folder before starting one. Speaks only what System.Net.Mail.SmtpClient
says: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT. No TLS, no AUTH.
"""
import os
import socketserver
import sys
import threading

PORT = int(sys.argv[1])
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
lock = threading.Lock()
count = [0]


class Handler(socketserver.StreamRequestHandler):
    def say(self, line):
        self.wfile.write((line + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        self.say("220 sink ready")
        rcpts = []
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            verb = raw.decode("latin-1").strip()
            up = verb.upper()
            if up.startswith("EHLO"):
                self.wfile.write(b"250-sink\r\n250 8BITMIME\r\n")
                self.wfile.flush()
            elif up.startswith("HELO"):
                self.say("250 sink")
            elif up.startswith("MAIL"):
                rcpts = []
                self.say("250 ok")
            elif up.startswith("RCPT"):
                rcpts.append(verb.split(":", 1)[1].strip().strip("<>"))
                self.say("250 ok")
            elif up == "DATA":
                self.say("354 go on")
                lines = []
                while True:
                    line = self.rfile.readline()
                    if not line or line in (b".\r\n", b".\n"):
                        break
                    lines.append(line[1:] if line.startswith(b"..") else line)
                with lock:
                    count[0] += 1
                    n = count[0]
                with open(os.path.join(OUT, "%04d.eml" % n), "wb") as f:
                    f.write(("X-Sink-Rcpt: %s\r\n" % ",".join(rcpts)).encode())
                    f.writelines(lines)
                # One line per message on stdout, so a test can ask "was anything
                # EVER addressed to X" after it has emptied the folder.
                print("kept %04d for %s" % (n, ",".join(rcpts)), flush=True)
                self.say("250 kept")
            elif up == "QUIT":
                self.say("221 bye")
                return
            else:
                self.say("250 ok")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


Server(("127.0.0.1", PORT), Handler).serve_forever()
