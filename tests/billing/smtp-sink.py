"""
A minimal SMTP server for tests: accepts every message and writes it to a
directory, one file per message, so a test can read what TatvaOS actually
sent (the recipient, the subject) instead of trusting that a send "worked".

Run:  python tests/billing/smtp-sink.py 5870 <directory>
"""
import os
import socketserver
import sys
import time

PORT = int(sys.argv[1])
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)


class Handler(socketserver.StreamRequestHandler):
    def say(self, line):
        self.wfile.write((line + "\r\n").encode())

    def handle(self):
        self.say("220 sink ESMTP")
        rcpt, data = [], None
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").rstrip("\r\n")
            cmd = line.upper()
            if cmd.startswith("EHLO") or cmd.startswith("HELO"):
                self.say("250 sink")
            elif cmd.startswith("MAIL FROM"):
                rcpt = []
                self.say("250 ok")
            elif cmd.startswith("RCPT TO"):
                rcpt.append(line.split(":", 1)[1].strip().strip("<>"))
                self.say("250 ok")
            elif cmd == "DATA":
                self.say("354 go ahead")
                lines = []
                while True:
                    l = self.rfile.readline().decode(errors="replace")
                    if l in (".\r\n", ".\n", ""):
                        break
                    lines.append(l)
                name = os.path.join(OUT, f"{time.time_ns()}.eml")
                with open(name, "w", encoding="utf-8") as f:
                    f.write("X-Sink-Rcpt: " + ",".join(rcpt) + "\n" + "".join(lines))
                self.say("250 stored")
            elif cmd == "QUIT":
                self.say("221 bye")
                return
            else:
                self.say("250 ok")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


Server(("127.0.0.1", PORT), Handler).serve_forever()
