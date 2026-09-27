// ============================================================================
//  A local SMTP sink for tests that must SEE the mail the API sends.
// ============================================================================
//
//  "The job ran without error" is the false green that hid the calendar
//  reminder incident for six weeks (27 Sept 2026). Tests that send mail assert
//  on what ARRIVED, so they need somewhere for it to arrive: this.
//
//    SMTP     :${SMTP_SINK_PORT:-5871}       accepts everything, delivers nowhere
//    HTTP     :${SMTP_SINK_HTTP_PORT:-5198}  GET /mail -> [{ to: [...], subject }]
//    log      ${SMTP_SINK_LOG:-.tmp/mail-sink.log}  every raw message, appended,
//             after a "----- <iso time> to <rcpt,...>" line. Bodies are MIME as
//             sent (base64 / quoted-printable): DECODE before searching them.
//
//  Used by tests/recovery-admin/test-admin-recovery-email.sh, locally and in
//  CI. Never point a real API's Smtp__Port here outside a test.
//
//    node tests/support/smtp-sink.mjs &
// ============================================================================
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const SMTP_PORT = Number(process.env.SMTP_SINK_PORT ?? 5871);
const HTTP_PORT = Number(process.env.SMTP_SINK_HTTP_PORT ?? 5198);
const LOG = process.env.SMTP_SINK_LOG ?? path.join(process.cwd(), '.tmp', 'mail-sink.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.appendFileSync(LOG, '');   // exists from the start: tests check for it

const mails = [];

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/mail') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mails));
    return;
  }
  res.writeHead(404).end();
}).listen(HTTP_PORT, '127.0.0.1');

net.createServer((sock) => {
  let data = '';
  let inData = false;
  const rcpt = [];
  sock.on('error', () => {}); // a client resetting after QUIT must not kill the sink
  sock.write('220 sink\r\n');
  sock.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (inData) {
      data += text;
      if (data.includes('\r\n.\r\n')) {
        inData = false;
        const subject = /^Subject: (.*)$/m.exec(data)?.[1]?.trim() ?? '';
        mails.push({ to: rcpt.slice(), subject });
        fs.appendFileSync(LOG, `----- ${new Date().toISOString()} to ${rcpt.join(',')}\n${data}\n`);
        data = ''; rcpt.length = 0;
        sock.write('250 queued\r\n');
      }
      return;
    }
    for (const line of text.split('\r\n').filter(Boolean)) {
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250 OK\r\n');
      else if (cmd === 'MAIL') sock.write('250 OK\r\n');
      else if (cmd === 'RCPT') { rcpt.push(/<([^>]*)>/.exec(line)?.[1] ?? line); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
}).listen(SMTP_PORT, '127.0.0.1');

console.log(`SMTP sink on :${SMTP_PORT}, /mail on :${HTTP_PORT}, log ${LOG}`);
