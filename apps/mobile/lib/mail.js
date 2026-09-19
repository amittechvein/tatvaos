/**
 * The Mail endpoints this app needs, ported from apps/web/lib/mail.ts.
 *
 * Everything goes through `request` in api.js, for the reason its opening
 * comment gives. The shapes below are the API's, not a translation: `isRead`
 * is `isRead` here as it is there, because a field renamed in the client is a
 * field somebody has to look up twice.
 *
 * ── WHAT THE API DOES NOT DO, AND THIS APP MUST ──────────────────────────
 *  • NO product gate. A person without Mail is not refused; they simply have
 *    no mailbox, and /bootstrap answers { mailbox: null, folders: [] }. That
 *    is an empty state to draw, not an error to report.
 *  • NO sanitisation. bodyHtml is the sender's HTML, untouched. The web app
 *    sanitises with DOMPurify and an iframe; the phone renders inside a
 *    WebView with JavaScript OFF and a content policy that blocks remote
 *    images until asked (screens/MailMessage.js).
 *  • Attachments are NOT saved with a draft (MailEndpoints.cs), so a draft
 *    saved from the phone loses them, and the compose screen says so.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { File } from 'expo-file-system';

import { request, API_BASE } from '../api';
import { htmlToText } from './mailHtml';

/**
 * The signature as text to put under a new message, or '' for none.
 *
 * ── "[object Object]" WENT OUT IN A REAL EMAIL. ─────────────────────────
 *  19 Sept 2026, seen in the Inbox on the emulator: a reply Amit sent from
 *  the phone the day before began "[object Object]". The API's bootstrap
 *  returns the signature as { bodyHtml, bodyText, enabled, includeOnReply }
 *  (MailEndpoints.ShapeSignature), and the compose screen dropped it into a
 *  template string as if it were text. Every check passed, because the
 *  screen checks fake the signature as the string '— Amit' — a fake in the
 *  wrong shape proves the fake.
 *
 *  So the shape is decided HERE, once, and honours the two flags the web
 *  honours: a disabled signature is no signature, and includeOnReply=false
 *  keeps it off replies and forwards. A plain string is still accepted, for
 *  the checks and for any older caller.
 * ───────────────────────────────────────────────────────────────────────
 */
export function signatureFor(signature, kind = 'new') {
  if (!signature) return '';
  if (typeof signature === 'string') return signature.trim();
  if (typeof signature !== 'object') return '';
  if (signature.enabled === false) return '';
  if (kind !== 'new' && signature.includeOnReply === false) return '';
  const t = signature.bodyText ?? signature.text ?? '';
  return typeof t === 'string' ? t.trim() : '';
}

/** Mailbox, folders and signature in one call — what the app opens Mail with. */
export async function bootstrap(token) {
  const data = await request('/api/mail/bootstrap', { method: 'GET', token });
  return {
    mailbox: data?.mailbox ?? null,
    folders: data?.folders ?? [],
    signature: data?.signature ?? '',
  };
}

/** Folders with their unread counts. Cheaper than bootstrap for a refresh. */
export async function listFolders(token) {
  const data = await request('/api/mail/folders', { method: 'GET', token });
  return data?.folders ?? [];
}

/**
 * One page of a folder, newest first. Offset paging — the API takes skip/take
 * and clamps take to 100; there is no cursor.
 */
/**
 * The orders a folder can be listed in: [key the server knows, words on screen].
 * The keys are MailListSort's (apps/api/Modules/Mail/MailListSort.cs); a key
 * that is not there is a 400, by design, not a quietly newest-first list.
 *
 * Sorting happens on the SERVER because the list is paged: thirty rows of a
 * folder of thousands. "Oldest first" sorted on the phone would be the oldest
 * of the newest thirty - right-looking, and wrong.
 */
export const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['unread', 'Unread first'],
  ['starred', 'Starred first'],
  ['sender', 'Sender, A to Z'],
  ['largest', 'Largest first'],
];
export const DEFAULT_SORT = 'newest';
export const sortLabel = (key) => SORTS.find((row) => row[0] === key)?.[1] ?? 'Newest first';

/**
 * `sorted` in the answer is the order the server SAYS it used, or null when it
 * said nothing - which is what a server older than the `sort` parameter does:
 * it ignores the parameter, answers 200, newest first. The caller compares
 * `sorted` with what it asked for instead of trusting the 200.
 */
export async function listMessages(token, folderId, { skip = 0, take = 30, sort = DEFAULT_SORT } = {}) {
  // The default is sent as nothing at all, so the commonest request is
  // byte-for-byte the one every deployed server already answers.
  const order = sort && sort !== DEFAULT_SORT ? `&sort=${encodeURIComponent(sort)}` : '';
  const data = await request(
    `/api/mail/folders/${folderId}/messages?skip=${skip}&take=${take}${order}`,
    { method: 'GET', token },
  );
  return { total: data?.total ?? 0, messages: data?.messages ?? [], sorted: data?.sort ?? null };
}

/** Search the whole mailbox. An empty query answers empty, not everything. */
export async function searchMessages(token, q, { skip = 0, take = 30 } = {}) {
  if (!q?.trim()) return { total: 0, messages: [] };
  const data = await request(
    `/api/mail/search?q=${encodeURIComponent(q.trim())}&skip=${skip}&take=${take}`,
    { method: 'GET', token },
  );
  return { total: data?.total ?? 0, messages: data?.messages ?? [] };
}

/** One message, with bodyHtml, bodyText and attachment metadata. */
export function getMessage(token, id) {
  return request(`/api/mail/messages/${id}`, { method: 'GET', token });
}

export function setRead(token, id, isRead) {
  return request(`/api/mail/messages/${id}/read`, { token, body: { isRead } });
}

export function setFlag(token, id, isFlagged) {
  return request(`/api/mail/messages/${id}/flag`, { token, body: { isFlagged } });
}

/**
 * Delete: the FIRST delete moves to Trash and answers
 * { deleted: false, movedTo }, the second (from Trash) removes it for good and
 * answers { deleted: true }. The screen says which happened, because "Deleted"
 * over a message that is still in Trash is a promise the app did not keep.
 */
export function deleteMessage(token, id) {
  return request(`/api/mail/messages/${id}`, { method: 'DELETE', token });
}

/**
 * Send. multipart/form-data, the same fields the web composer posts, because
 * the endpoint carries attachments and takes nothing else.
 *
 * `inReplyToId` is what makes a reply a reply rather than a new conversation.
 * A longer timeout than the default: this is the one call that can carry
 * megabytes up a phone's uplink.
 *
 * SentButNotFiled answers 200 with { id: null, warning } — sent, not filed in
 * Sent. Success, and the warning is worth showing; retrying would send twice.
 */
export async function send(token, {
  to, cc = '', subject = '', bodyText = '', bodyHtml = '', inReplyToId, draftId, files = [],
}, onProgress) {
  // ── A BIG ATTACHMENT NEEDS TO SHOW ITS PROGRESS. ───────────────────────
  //  Amit, 18 Sept 2026: "give progress bar that attachment that much % is
  //  uploaded". A photo on a phone's uplink takes long enough that a still
  //  spinner reads as a hang, and the person sends again.
  //
  //  fetch cannot report upload progress — no browser's can, and Expo's
  //  replacement is no different. XMLHttpRequest can, through
  //  upload.onprogress, and in React Native it is the NATIVE networking path
  //  rather than Expo's JavaScript one. That is also why the part shape
  //  differs below: { uri, name, type } is what RN's own uploader wants, and
  //  it is the shape Expo's fetch refused.
  //
  //  Only when there are files to watch. A text-only send is one packet and
  //  goes the proven way.
  // ───────────────────────────────────────────────────────────────────────
  if (files.length && typeof onProgress === 'function') {
    try {
      return await sendWithProgress(token, {
        to, cc, subject, bodyText, bodyHtml, inReplyToId, draftId, files,
      }, onProgress);
    } catch (e) {
      // The send itself failing must NOT be retried — it may have arrived,
      // and sending twice is worse than no progress bar. Only a refusal to
      // build the request at all falls through to the proven path.
      if (!e?.beforeSend) throw e;
      console.log(`[mail] upload with progress could not start (${e.message}); using the plain path`);
    }
  }

  const form = new FormData();
  form.append('to', to);
  if (cc) form.append('cc', cc);
  form.append('subject', subject);
  form.append('bodyText', bodyText);
  if (bodyHtml) form.append('bodyHtml', bodyHtml);
  if (inReplyToId) form.append('inReplyToId', inReplyToId);
  if (draftId) form.append('draftId', draftId);
  // ── ATTACHMENTS GO UP AS FILE OBJECTS, NOT { uri, name, type }. ─────────
  //  Every React Native example says to append { uri, name, type }, and it is
  //  what RN's own networking understands. Expo SDK 54+ replaces global fetch
  //  with its own (expo/src/winter/fetch), which builds the multipart body in
  //  JavaScript and accepts only strings, Blobs, and objects with bytes() —
  //  everything else throws "Unsupported FormDataPart implementation".
  //
  //  That arrived as a NETWORK failure ("Cannot reach TatvaOS") on the phone,
  //  18 Sept 2026: a send with no attachment answered 200 in half a second,
  //  and the same send with a 36 KB photo failed in 8 ms, which is the tell —
  //  nothing that crosses a network fails that fast.
  //
  //  expo-file-system's File is a Blob with bytes(), a name and a type, and it
  //  reads from disk natively. The 25 MB cap the compose screen enforces is
  //  what keeps bytes() from being a memory problem.
  // ───────────────────────────────────────────────────────────────────────
  for (const f of files) {
    if (!f?.uri) {
      console.log(`[mail] attachment has no uri, keys: ${Object.keys(f ?? {}).join(',')}`);
      throw new Error(`Could not read ${f?.name ?? 'that file'}. Attach it again.`);
    }
    form.append('files', new File(f.uri));
  }
  return request('/api/mail/send', { method: 'POST', token, form, timeoutMs: 120000 });
}

/**
 * The same send, over XMLHttpRequest, reporting how much has gone up.
 *
 * `onProgress(fraction, sentBytes, totalBytes)` — fraction is 0..1, or null
 * when the platform will not say how big the body is (it happens; the screen
 * shows an indeterminate bar rather than a wrong number).
 *
 * Deliberately NOT routed through api.js request(): that one owns fetch, the
 * timeout and the 401-renewal retry, and re-implementing those here would mean
 * two copies of the session rules. A 401 is handed back to the caller instead —
 * the compose screen is short-lived and the token was fresh when it opened.
 */
function sendWithProgress(token, fields, onProgress) {
  const { files, ...text } = fields;
  const form = new FormData();
  for (const [k, v] of Object.entries(text)) {
    // Same rule as the plain path: empty cc or a missing reply id are left
    // out entirely, not sent as empty strings.
    if (k === 'to' || k === 'subject' || k === 'bodyText' || v) form.append(k, String(v ?? ''));
  }
  for (const f of files) {
    if (!f?.uri) {
      const e = new Error(`Could not read ${f?.name ?? 'that file'}. Attach it again.`);
      // Nothing was sent, so the caller may safely try the other path.
      e.beforeSend = true;
      throw e;
    }
    form.append('files', {
      uri: f.uri,
      name: f.name || 'attachment',
      type: f.mimeType || 'application/octet-stream',
    });
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/mail/send`);
    xhr.timeout = 120000;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // No Content-Type: the multipart boundary is the uploader's to set, and
    // setting it by hand is how the boundary ends up missing.

    xhr.upload.onprogress = (e) => {
      const total = e.lengthComputable ? e.total : 0;
      onProgress(total ? e.loaded / total : null, e.loaded, total);
    };

    xhr.onload = () => {
      console.log(`[api] POST /api/mail/send -> ${xhr.status} ${Date.now() - started}ms (xhr)`);
      let parsed = null;
      try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1, 1, 1); resolve(parsed ?? {}); return; }
      // The API's own wording when it has one; it is written for the person.
      reject(new Error(parsed?.error || parsed?.detail || `Send failed (${xhr.status}).`));
    };
    // A failed upload says nothing about why, by design of the API. These are
    // the two states the person can act on, so they are named separately.
    xhr.onerror = () => reject(new Error('Cannot reach TatvaOS. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('That took too long to send. A smaller attachment may go through.'));

    xhr.send(form);
  });
}

/** Where an attachment can be downloaded from. Needs the bearer token. */
export function attachmentUrl(messageId, attachmentId) {
  return `${API_BASE}/api/mail/messages/${messageId}/attachments/${attachmentId}`;
}

/** The special folder slugs the app treats as known places. */
export const SLUGS = ['inbox', 'sent', 'drafts', 'junk', 'trash'];

/** Inbox first, then the other known folders, then everything else by name. */
export function orderFolders(folders) {
  const rank = (f) => {
    const i = SLUGS.indexOf(f.slug);
    return i < 0 ? SLUGS.length : i;
  };
  return [...(folders ?? [])].sort((a, b) =>
    rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** The name to show for a message row: the sender's name, or their address. */
export function senderLabel(m) {
  const from = m?.from ?? {};
  return from.name?.trim() || from.email || 'Unknown sender';
}

/**
 * "14:32" today, "Tue" this week, "12 Sep" this year, "12 Sep 2025" before
 * that — the shorthand every mail app uses, and the only reason a date column
 * fits on a phone. `now` is a parameter so the checks can pin the clock.
 */
export function whenLabel(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  // CALENDAR days, not elapsed time. Measured in hours, a message from last
  // Saturday evening is 6.8 days old on Saturday afternoon, "under a week", and
  // was labelled "Sat" - on a Saturday, above rows that said "Fri" and meant
  // yesterday. Seen on Amit's Samsung, 19 Sept 2026. Counted in whole days a
  // weekday name can only ever mean one of the last six days, never today's.
  const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((dayOf(now) - dayOf(d)) / 86400000);
  if (days >= 1 && days <= 6) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Addresses as the compose screen shows them: "a@x.com, b@y.com". */
export function addressList(people) {
  return (people ?? []).map((p) => p?.email).filter(Boolean).join(', ');
}

/** The quoted original under a reply, in plain text. */
export function quoted(message) {
  const who = senderLabel(message);
  const when = message?.sentAt || message?.receivedAt;
  const on = when ? new Date(when).toLocaleString() : '';

  // ── A DESIGNED EMAIL HAS NO TEXT PART. ────────────────────────────────
  //  Amit, 18 Sept 2026: "reply on html designed mail did not pick the
  //  content". Replying quoted bodyText, and anything built in a design tool
  //  — every newsletter, every notification — carries only bodyHtml. So the
  //  quote came out as the "On ... wrote:" line with nothing under it, and
  //  the reply arrived showing no sign of what it answered.
  //
  //  Falling back to the HTML, flattened. A quote is read for its words, not
  //  its layout, so losing the design costs nothing here.
  // ──────────────────────────────────────────────────────────────────────
  const body = ((message?.bodyText || '').trim()
    || htmlToText(message?.bodyHtml)).trim();

  // Nothing at all — an empty message, or one that is only an image. Say so,
  // rather than leaving a bare "wrote:" that reads like the quote broke.
  if (!body) return `\n\nOn ${on}, ${who} wrote:\n> (no text content)`;

  return `\n\nOn ${on}, ${who} wrote:\n`
    + body.split('\n').map((l) => `> ${l}`).join('\n');
}

// ── SUGGESTING RECIPIENTS ──────────────────────────────────────────────────
//  Amit, 18 Sept 2026: "auto name suggestion on to and cc". Typing a full
//  address on a phone keyboard is the slowest part of writing an email, and
//  the addresses people actually use are already known to us.
//
//  The API is Family's, not Mail's: GET /api/family/contacts/autocomplete
//  returns one row PER ADDRESS (somebody with two appears twice), colleagues
//  from core.users first, then contacts. The web composer uses exactly this,
//  so the phone offers the same people in the same order.
// ───────────────────────────────────────────────────────────────────────────

/** [{ id, email, displayName, isColleague }]. An empty term gives []. */
export function suggestRecipients(token, q, limit = 8) {
  const term = (q ?? '').trim();
  if (!term) return Promise.resolve([]);
  return request(
    `/api/family/contacts/autocomplete?q=${encodeURIComponent(term)}&limit=${limit}`,
    { method: 'GET', token },
  );
}

/**
 * The address being typed right now, from a "a@x.com, b@y." field.
 *
 * Only the fragment after the last comma is a query; everything before it is
 * already chosen. Returns '' when the caret sits after a comma or a space, so
 * a finished list does not keep asking the server about its last entry.
 */
export function typingTerm(value) {
  const tail = (value ?? '').split(',').pop() ?? '';
  // A trailing space means "done with that one" — the web composer treats a
  // comma the same way, and without this the suggestion list hangs about
  // under a completed address.
  if (/\s$/.test(tail) || tail.trim() === '') return '';
  return tail.trim();
}

/** The field's new value once a suggestion is picked, ready for the next one. */
export function withRecipient(value, email) {
  const parts = (value ?? '').split(',');
  parts.pop();                                   // drop the half-typed one
  const kept = parts.map((p) => p.trim()).filter(Boolean);
  // Already there: adding it twice sends twice in some clients, and looks
  // like the tap did nothing.
  if (!kept.some((p) => p.toLowerCase() === email.toLowerCase())) kept.push(email);
  return `${kept.join(', ')}, `;
}

/** Reply subject, without stacking "Re: Re: Re:". */
export function replySubject(subject) {
  const s = (subject ?? '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject) {
  const s = (subject ?? '').trim();
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}
