#!/usr/bin/env python3
"""
A fake Google for tests/migration-e2e: every API the migration calls, under
one base URL, with the API's Migration:Google:ApiBase pointed here (honoured in
Development only - Program.cs).

It answers as Google does for what the migration asks, and no more:
  POST /token                                   a token for the JWT's "sub" -
                                                unauthorized_client for an
                                                admin named nogrant@...
  GET  /admin/directory/v1/users                the domain's people
  GET  /drive/v3/about                          a person's storage
  GET  /drive/v3/files                          (no Drive files)
  GET  /gmail/v1/users/{u}/profile|labels|labels/{id}|messages|messages/{id}|history
  GET  /v1/people/me/connections, /v1/contactGroups
  GET  /calendar/v3/calendars/primary/events    (no events)
  POST /_arrive?id=..&mid=..                    test control: a new message arrives
  GET  /_who?token=..                           test control: whom a token was for

It records every token's subject, so the test can say who was acted as.
Usage: fake_google.py PORT
"""
import base64, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

DOMAIN = "techvein.local"
PEOPLE = ["amit@techvein.local", "hr@techvein.local", "ghost@techvein.local"]
LOCK = threading.Lock()
TOKENS = {}            # token -> subject
HISTORY = {"id": 100}
MESSAGES = [           # (gmail id, Message-ID stem, labels)
    ("e1", "e2e-one", ["INBOX"]),
    ("e2", "e2e-two", ["SENT"]),
]
ARRIVED = []           # (gmail id, stem, history id it arrived after)

def b64url(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
def unb64(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def raw(stem, gid):
    return (f"Message-ID: <{stem}@customer.test>\r\nFrom: someone@else.test\r\nTo: amit@{DOMAIN}\r\n"
            f"Subject: e2e {gid}\r\nDate: Tue, 14 Nov 2023 10:00:00 +0000\r\n\r\nBody {gid}.\r\n").encode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def who(self):
        auth = self.headers.get("Authorization", "")
        return TOKENS.get(auth.removeprefix("Bearer ").strip())

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/token":
            form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
            claims = json.loads(unb64(form["assertion"][0].split(".")[1]))
            sub = claims["sub"]
            if sub.startswith("nogrant@"):
                return self.send(401, {"error": "unauthorized_client", "error_description": "Client is unauthorized"})
            with LOCK:
                tok = f"ya29.fake{len(TOKENS)}"; TOKENS[tok] = sub
            return self.send(200, {"access_token": tok, "expires_in": 3600})
        if u.path == "/_arrive":
            with LOCK:
                after = HISTORY["id"]; HISTORY["id"] += 10
                ARRIVED.append((q["id"][0], q["mid"][0], after))
            return self.send(200, {"history": HISTORY["id"]})
        self.send(404, {"error": {"code": 404, "message": "not found"}})

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); p = u.path
        if p == "/_who":
            return self.send(200, {"sub": TOKENS.get(q["token"][0])})
        sub = self.who()
        if sub is None:
            return self.send(401, {"error": {"code": 401, "message": "Invalid Credentials", "errors": [{"reason": "authError"}]}})
        if p == "/admin/directory/v1/users":
            return self.send(200, {"users": [{"primaryEmail": e} for e in PEOPLE]})
        if p == "/drive/v3/about":
            return self.send(200, {"storageQuota": {"usage": str(3 * 1024**2), "usageInDrive": str(1024**2), "usageInDriveTrash": "0"}})
        if p == "/drive/v3/drives":
            return self.send(200, {"drives": []})
        if p == "/drive/v3/files":
            return self.send(200, {"files": []})
        if p == "/calendar/v3/calendars/primary/events":
            return self.send(200, {"items": [], "timeZone": "Asia/Kolkata"})
        if p == "/v1/otherContacts":
            return self.send(200, {"otherContacts": []})
        if p == "/v1/contactGroups":
            return self.send(200, {"contactGroups": []})
        if p == "/v1/people/me/connections":
            people = [{"resourceName": "people/e2e1", "names": [{"displayName": "E2E Supplier"}],
                       "emailAddresses": [{"value": "e2e.supplier@partner.test", "type": "work"}]}] if sub.startswith("amit@") else []
            return self.send(200, {"connections": people, "totalPeople": len(people)})
        if p.startswith("/gmail/v1/users/"):
            rest = unquote(p[len("/gmail/v1/users/"):]).split("/", 1)[1]
            mine = sub.startswith("amit@")
            if rest == "profile":
                return self.send(200, {"emailAddress": sub, "messagesTotal": len(MESSAGES) if mine else 0,
                                       "threadsTotal": 2, "historyId": str(HISTORY["id"])})
            if rest == "labels":
                return self.send(200, {"labels": [{"id": "INBOX", "name": "INBOX", "type": "system"}]})
            if rest.startswith("labels/"):
                return self.send(200, {"id": rest[7:], "messagesTotal": 1, "threadsTotal": 1})
            if rest == "messages":
                return self.send(200, {"messages": [{"id": m[0]} for m in MESSAGES] if mine else [], "resultSizeEstimate": 2})
            if rest == "history":
                since = int(q["startHistoryId"][0])
                added = [{"messagesAdded": [{"message": {"id": a[0]}}]} for a in ARRIVED if a[2] >= since] if mine else []
                return self.send(200, {"history": added, "historyId": str(HISTORY["id"])})
            if rest.startswith("messages/"):
                gid = rest[9:]
                for (i, stem, labels) in MESSAGES + [(a[0], a[1], ["INBOX"]) for a in ARRIVED]:
                    if i == gid:
                        return self.send(200, {"id": gid, "labelIds": labels, "internalDate": "1700000000000", "raw": b64url(raw(stem, gid))})
        self.send(404, {"error": {"code": 404, "message": "not found", "errors": [{"reason": "notFound"}]}})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
