// TatvaOS Bugs — email.
//
// Sends through TatvaOS's own send API (POST /api/v1/mail/send) with a Mail
// API key the admin pastes into Settings. The key never lives in an env file
// or a transcript: it is typed into the app by the person who created it.
//
// One recipient per call, on purpose: the send API puts every recipient on
// every copy, and a tracker mail to five people would hand each of them the
// other four addresses.
//
// Failures are recorded in mail_log (visible to admins) and never fail the
// action that caused them: a report is saved whether or not its mail went.

import { getSetting, setSetting, now, issueKey, STATUS_LABEL } from './db.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMailer(db, cfg) {
  const queue = [];
  let running = false;

  function configured() {
    return !!(getSetting(db, 'mail_api_key') && getSetting(db, 'mail_from'));
  }

  async function sendOne(job) {
    const key = getSetting(db, 'mail_api_key');
    const from = getSetting(db, 'mail_from');
    if (!key || !from) {
      db.prepare('INSERT INTO mail_log(at, user_id, subject, ok, detail) VALUES (?,?,?,?,?)')
        .run(now(), job.userId ?? null, job.subject, 0, 'Email is not set up yet (Settings).');
      return false;
    }
    let ok = false;
    let detail = '';
    try {
      const res = await fetch(cfg.mailApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ from, to: job.to, subject: job.subject, text: job.text, html: job.html, saveToSent: false }),
        signal: AbortSignal.timeout(20000),
      });
      ok = res.ok;
      if (!ok) {
        // The API's error text names the problem ("from is not allowed for this
        // key"); it never echoes the key. Keep it short.
        detail = ('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300)).trim();
      }
    } catch (e) {
      detail = String(e && e.message || e).slice(0, 300);
    }
    db.prepare('INSERT INTO mail_log(at, user_id, subject, ok, detail) VALUES (?,?,?,?,?)')
      .run(now(), job.userId ?? null, job.subject, ok ? 1 : 0, detail);
    return ok;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) await sendOne(queue.shift());
    } finally {
      running = false;
    }
  }

  function enqueue(user, subject, lines, link) {
    if (!user || !user.email || !user.active) return;
    const text = lines.join('\n') + (link ? '\n\nOpen: ' + link : '') + '\n\n— TatvaOS Bugs';
    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">' +
      lines.map((l) => (l === '' ? '<br>' : '<div>' + esc(l) + '</div>')).join('') +
      (link ? '<p style="margin-top:16px"><a href="' + esc(link) + '" style="background:#6d28d9;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in TatvaOS Bugs</a></p>' : '') +
      '<p style="color:#6b7280;font-size:12px;margin-top:20px">TatvaOS Bugs · bug.tatvaos.com</p></div>';
    queue.push({ to: user.email, userId: user.id, subject, text, html });
    pump();
  }

  // ---- Immediate notifications ------------------------------------------
  //
  // Who hears about what: the reporter and the assignee hear about everything
  // on their issue; admins hear about new issues and reopenings. Nobody is
  // mailed about their own action.
  function issueEvent(issue, actor, event, body) {
    const key = issueKey(issue.id);
    const link = cfg.publicUrl + '/#/issue/' + issue.id;
    const users = (ids) => ids.filter(Boolean).map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)).filter(Boolean);
    const admins = () => db.prepare('SELECT * FROM users WHERE is_admin = 1 AND active = 1').all();

    let recipients = users([issue.reporter_id, issue.assignee_id]);
    if (event.kind === 'created' || event.kind === 'reopened') recipients = recipients.concat(admins());
    const seen = new Set([actor.id]);
    recipients = recipients.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));

    const subject = `[${key}] ${event.subjectPrefix}: ${issue.title}`.slice(0, 200);
    const lines = [
      `${event.line} by ${actor.name || actor.email}.`,
      '',
      `${key} · ${issue.type === 'bug' ? 'Bug' : 'Feature request'} · ${issue.priority} priority`,
      `Title: ${issue.title}`,
      `Status: ${STATUS_LABEL[issue.status]}`,
    ];
    if (body) lines.push('', body.slice(0, 2000));
    for (const u of recipients) enqueue(u, subject, lines, link);
  }

  // ---- Daily summary ----------------------------------------------------
  //
  // Sent once a day after 09:00 India time. The date it last ran is stored,
  // so a restart does not send it twice and a restart at 10:00 still sends.
  function istDate(d = new Date()) {
    return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
  }
  function istHour(d = new Date()) {
    return new Date(d.getTime() + 330 * 60000).getUTCHours();
  }

  function dailySummaries(force = false) {
    const today = istDate();
    if (!force && (istHour() < 9 || getSetting(db, 'last_summary_date') === today)) return 0;
    setSetting(db, 'last_summary_date', today);
    let sent = 0;
    const link = cfg.publicUrl + '/';
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;

    for (const u of db.prepare('SELECT * FROM users WHERE active = 1 AND daily_summary = 1 AND is_developer = 1').all()) {
      const q = (extra, ...p) => count(`SELECT COUNT(*) n FROM issues WHERE assignee_id = ? ${extra}`, u.id, ...p);
      const total = q("AND status NOT IN ('closed')");
      if (!total) continue;
      enqueue(u, `Your issues today — ${total} assigned`, [
        `Good morning ${u.name || ''}. Your assigned issues:`, '',
        `Total assigned (open): ${total}`,
        `Pending: ${q("AND status = 'pending'")}`,
        `Under Development: ${q("AND status = 'under_dev'")}`,
        `Fixed (waiting for the tester): ${q("AND status = 'fixed'")}`,
        `Overdue: ${q("AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('fixed','closed')", today)}`,
      ], link);
      sent++;
    }

    for (const u of db.prepare('SELECT * FROM users WHERE active = 1 AND daily_summary = 1 AND is_tester = 1').all()) {
      const q = (extra) => count(`SELECT COUNT(*) n FROM issues WHERE reporter_id = ? ${extra}`, u.id);
      const open = q("AND status <> 'closed'");
      if (!open) continue;
      enqueue(u, `Your reports today — ${q("AND status = 'fixed'")} waiting for you to verify`, [
        `Good morning ${u.name || ''}. Your reports:`, '',
        `Pending: ${q("AND status = 'pending'")}`,
        `Information required from you: ${q("AND status = 'more_info'")}`,
        `Under development: ${q("AND status = 'under_dev'")}`,
        `Fixed — please verify and close or reopen: ${q("AND status = 'fixed'")}`,
      ], link);
      sent++;
    }

    for (const u of db.prepare('SELECT * FROM users WHERE active = 1 AND is_admin = 1 AND admin_summary = 1').all()) {
      const byStatus = db.prepare('SELECT status, COUNT(*) n FROM issues GROUP BY status').all();
      const m = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
      const created = count('SELECT COUNT(*) n FROM issues WHERE created_at >= ?', new Date(Date.now() - 864e5).toISOString());
      enqueue(u, `TatvaOS Bugs — daily summary`, [
        `New in the last 24 hours: ${created}`, '',
        ...Object.keys(STATUS_LABEL).map((s) => `${STATUS_LABEL[s]}: ${m[s] || 0}`),
        `Overdue: ${count("SELECT COUNT(*) n FROM issues WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('fixed','closed')", today)}`,
      ], link);
      sent++;
    }
    return sent;
  }

  return { configured, enqueue, issueEvent, dailySummaries, istDate, _drain: async () => { while (queue.length || running) await new Promise((r) => setTimeout(r, 20)); } };
}
