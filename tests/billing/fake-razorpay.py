"""
A stand-in for Razorpay's Payment Links API, for tests/billing/test-razorpay.sh.

Answers the two calls TatvaOS makes (create a link, read a link) the way
Razorpay documents them, and REFUSES a request whose Basic auth is not the
test key pair: a client that sent the wrong keys, or none, must fail here
exactly as it would against Razorpay.

Control routes, for the test only:
  POST /_control/pay/<link_id>   mark the link paid (amount_paid = amount)
  GET  /_control/log             every create request received, as JSON
  GET  /pay/<link_id>            (only with a 4th argument) acts as Razorpay's
                                 payment page: marks the link paid and sends
                                 the browser back to callback_url with the
                                 signed query string Razorpay adds

Run:  python tests/billing/fake-razorpay.py 5198 rzp_test_fake fake_key_secret [public-base-url]
"""
import base64
import hashlib
import hmac
import json
import sys
from urllib.parse import urlencode
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
KEY_ID, KEY_SECRET = sys.argv[2], sys.argv[3]
PUBLIC = sys.argv[4].rstrip("/") if len(sys.argv) > 4 else None
LINKS = {}
CREATES = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        want = "Basic " + base64.b64encode(f"{KEY_ID}:{KEY_SECRET}".encode()).decode()
        if self.headers.get("Authorization") != want:
            self.reply(401, {"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}})
            return False
        return True

    def do_GET(self):
        if PUBLIC and self.path.startswith("/pay/"):
            link = LINKS[self.path.rsplit("/", 1)[1]]
            pay_id = "pay_fake_" + link["id"][-6:]
            link.update(status="paid", amount_paid=link["amount"], payments=[{"payment_id": pay_id, "status": "captured"}])
            signed = f"{link['id']}|{link['reference_id']}|paid|{pay_id}"
            query = urlencode({
                "razorpay_payment_id": pay_id, "razorpay_payment_link_id": link["id"],
                "razorpay_payment_link_reference_id": link["reference_id"], "razorpay_payment_link_status": "paid",
                "razorpay_signature": hmac.new(KEY_SECRET.encode(), signed.encode(), hashlib.sha256).hexdigest(),
            })
            self.send_response(302)
            self.send_header("Location", f"{link['callback_url']}?{query}")
            self.end_headers()
            return
        if self.path == "/_control/log":
            return self.reply(200, CREATES)
        if self.path.startswith("/v1/payment_links/"):
            if not self.authed():
                return
            link = LINKS.get(self.path.rsplit("/", 1)[1])
            return self.reply(200, link) if link else self.reply(404, {"error": {"description": "not found"}})
        self.reply(404, {})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        if self.path.startswith("/v1/payment_links/") and self.path.endswith("/cancel"):
            if not self.authed():
                return
            link = LINKS.get(self.path.split("/")[3])
            if not link:
                return self.reply(404, {"error": {"description": "not found"}})
            if link["status"] == "paid":
                return self.reply(400, {"error": {"description": "Payment link cannot be cancelled as it is already paid"}})
            link["status"] = "cancelled"
            return self.reply(200, link)
        if self.path.startswith("/_control/pay/"):
            link = LINKS[self.path.rsplit("/", 1)[1]]
            link.update(status="paid", amount_paid=link["amount"],
                        payments=[{"payment_id": "pay_fake_" + link["id"][-6:], "status": "captured"}])
            return self.reply(200, link)
        if self.path == "/v1/payment_links":
            if not self.authed():
                return
            CREATES.append(data)
            link_id = f"plink_fake{len(CREATES):04d}"
            LINKS[link_id] = {
                "id": link_id, "status": "created", "callback_url": data.get("callback_url"),
                "short_url": f"{PUBLIC}/pay/{link_id}" if PUBLIC else f"https://rzp.io/fake/{link_id}",
                "amount": data["amount"], "amount_paid": 0, "reference_id": data.get("reference_id"),
                "payments": None,
            }
            return self.reply(200, LINKS[link_id])
        self.reply(404, {})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
